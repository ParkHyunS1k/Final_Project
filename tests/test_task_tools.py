"""업무 Tool 5개 스모크 테스트.

실행: py -3 -m unittest discover -s tests -v
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server.db.connection import fresh_db  # noqa: E402
from server.db.fixtures import FIXED_NOW, OTHER_PROJECT_ID, seed_demo  # noqa: E402
from server.tools import ToolContext, call  # noqa: E402


class ToolTestCase(unittest.TestCase):
    def setUp(self) -> None:
        # 에피소드 격리: 매 테스트마다 새 :memory: DB
        self.conn = fresh_db()
        project_id = seed_demo(self.conn)
        self.ctx = ToolContext(conn=self.conn, project_id=project_id, now=FIXED_NOW)

    def tearDown(self) -> None:
        self.conn.close()

    def call(self, name, **args):
        return call(name, self.ctx, args)

    def assertErr(self, res, code):
        self.assertFalse(res.ok, f"성공하면 안 된다: {res.result}")
        self.assertEqual(res.error_type, code, res.message)


class TestCreateTask(ToolTestCase):
    def test_creates_with_assignee_and_deadline(self):
        res = self.call("create_task", title="라우터 구현", assignee="이성경", deadline="2026-09-15", effort_hours=8)
        self.assertTrue(res.ok, res.message)
        self.assertEqual(res.result["assignee"], "이성경")
        self.assertEqual(res.result["status"], "todo")
        row = self.conn.execute("SELECT * FROM task WHERE id = ?", (res.result["id"],)).fetchone()
        self.assertEqual(row["assignee_id"], "m_sk")
        self.assertEqual(row["project_id"], "p_demo")

    def test_partial_name_matches_only_within_project(self):
        # '남현민'은 p_other 소속이므로 후보에 들어오면 안 된다 → 유일 매칭
        res = self.call("create_task", title="배포 스크립트", assignee="현민")
        self.assertTrue(res.ok, res.message)
        self.assertEqual(res.result["assignee"], "김현민")

    def test_ambiguous_name(self):
        res = self.call("create_task", title="테스트", assignee="지원")
        self.assertErr(res, "AMBIGUOUS")
        self.assertEqual(sorted(res.details["candidates"]), ["박지원", "최지원"])

    def test_unknown_member_is_not_created(self):
        res = self.call("create_task", title="테스트", assignee="홍길동")
        self.assertErr(res, "NOT_FOUND")
        self.assertEqual(self.conn.execute("SELECT COUNT(*) c FROM member").fetchone()["c"], 5)

    def test_relative_date_string_is_rejected(self):
        res = self.call("create_task", title="테스트", deadline="다음 주 금요일")
        self.assertErr(res, "INVALID_ARGUMENT")

    def test_unknown_argument_is_rejected(self):
        res = self.call("create_task", title="테스트", priority="high")
        self.assertErr(res, "INVALID_ARGUMENT")

    def test_missing_required(self):
        res = self.call("create_task", assignee="이성경")
        self.assertErr(res, "INVALID_ARGUMENT")

    def test_depends_on_other_project_task_is_forbidden(self):
        before = self.conn.execute("SELECT COUNT(*) c FROM task").fetchone()["c"]
        res = self.call("create_task", title="테스트", depends_on=["t_out"])
        self.assertErr(res, "FORBIDDEN")
        after = self.conn.execute("SELECT COUNT(*) c FROM task").fetchone()["c"]
        self.assertEqual(before, after, "실패한 변경이 롤백되지 않았다")

    def test_depends_on_records_edges(self):
        res = self.call("create_task", title="통합", depends_on=["t_api", "t_ui"])
        self.assertTrue(res.ok, res.message)
        self.assertEqual(res.result["depends_on"], ["t_api", "t_ui"])

    def test_milestone_of_other_project_is_forbidden(self):
        res = self.call("create_task", title="테스트", milestone_id="ms_out")
        self.assertErr(res, "FORBIDDEN")


class TestUpdateTask(ToolTestCase):
    def test_updates_fields(self):
        res = self.call("update_task", task_id="t_ui", deadline="2026-09-20", status="in_progress")
        self.assertTrue(res.ok, res.message)
        self.assertEqual(res.result["updated_fields"], ["deadline", "status"])
        self.assertEqual(res.result["deadline"], "2026-09-20")

    def test_reassign(self):
        res = self.call("update_task", task_id="t_doc", assignee="최지원")
        self.assertTrue(res.ok, res.message)
        self.assertEqual(res.result["assignee"], "최지원")

    def test_other_project_task_is_forbidden(self):
        res = self.call("update_task", task_id="t_out", title="가로채기")
        self.assertErr(res, "FORBIDDEN")
        row = self.conn.execute("SELECT title FROM task WHERE id = 't_out'").fetchone()
        self.assertEqual(row["title"], "남의 업무")

    def test_unknown_task(self):
        self.assertErr(self.call("update_task", task_id="t_nope", title="x"), "NOT_FOUND")

    def test_done_is_not_in_status_enum(self):
        self.assertErr(self.call("update_task", task_id="t_ui", status="done"), "INVALID_ARGUMENT")

    def test_no_field_to_update(self):
        self.assertErr(self.call("update_task", task_id="t_ui"), "INVALID_ARGUMENT")


class TestCompleteTask(ToolTestCase):
    def test_complete(self):
        res = self.call("complete_task", task_id="t_eval")
        self.assertTrue(res.ok, res.message)
        self.assertEqual(res.result["status"], "done")

    def test_already_done(self):
        self.assertErr(self.call("complete_task", task_id="t_db"), "INVALID_STATE")

    def test_warns_on_open_dependency(self):
        res = self.call("complete_task", task_id="t_ui")  # t_api가 아직 in_progress
        self.assertTrue(res.ok, res.message)
        self.assertEqual([d["id"] for d in res.result["open_dependencies"]], ["t_api"])

    def test_other_project(self):
        self.assertErr(self.call("complete_task", task_id="t_out"), "FORBIDDEN")


class TestSearchTasks(ToolTestCase):
    def test_no_filter_returns_only_this_project(self):
        res = self.call("search_tasks")
        self.assertTrue(res.ok, res.message)
        self.assertEqual(res.result["count"], 5)
        self.assertNotIn("t_out", [t["id"] for t in res.result["tasks"]])

    def test_delayed_only_uses_fixed_clock(self):
        # 기준일 2026-09-08. t_eval(09-04, todo)만 지연. t_db(09-05)는 done이라 제외.
        res = self.call("search_tasks", delayed_only=True)
        self.assertEqual([t["id"] for t in res.result["tasks"]], ["t_eval"])

    def test_keyword_and_status(self):
        res = self.call("search_tasks", keyword="API")
        self.assertEqual([t["id"] for t in res.result["tasks"]], ["t_api"])
        res = self.call("search_tasks", status="todo")
        self.assertEqual(sorted(t["id"] for t in res.result["tasks"]), ["t_doc", "t_eval", "t_ui"])

    def test_assignee_filter(self):
        res = self.call("search_tasks", assignee="김현민")
        self.assertEqual(sorted(t["id"] for t in res.result["tasks"]), ["t_api", "t_db"])

    def test_unknown_assignee_is_not_found(self):
        self.assertErr(self.call("search_tasks", assignee="홍길동"), "NOT_FOUND")


class TestGetMemberTasks(ToolTestCase):
    def test_default_excludes_done(self):
        res = self.call("get_member_tasks", member="김현민")
        self.assertTrue(res.ok, res.message)
        self.assertEqual([t["id"] for t in res.result["tasks"]], ["t_api"])
        self.assertEqual(res.result["open_effort_hours"], 15.0)

    def test_include_done(self):
        res = self.call("get_member_tasks", member="김현민", include_done=True)
        self.assertEqual(sorted(t["id"] for t in res.result["tasks"]), ["t_api", "t_db"])
        self.assertEqual(res.result["open_effort_hours"], 15.0)

    def test_delayed_ids(self):
        res = self.call("get_member_tasks", member="이성경")
        self.assertEqual(res.result["delayed_task_ids"], ["t_eval"])

    def test_member_of_other_project_is_not_found(self):
        # 이름이 p_other에만 있으면 현재 프로젝트에서는 존재하지 않는 것과 같다
        ctx_other = ToolContext(conn=self.conn, project_id=OTHER_PROJECT_ID, now=FIXED_NOW)
        self.assertTrue(call("get_member_tasks", ctx_other, {"member": "남현민"}).ok)
        self.assertErr(self.call("get_member_tasks", member="남현민"), "NOT_FOUND")


class TestRegistryContract(ToolTestCase):
    def test_unknown_tool(self):
        self.assertErr(self.call("delete_everything"), "NOT_FOUND")

    def test_mutating_flags(self):
        from server.tools import REGISTRY

        self.assertTrue(REGISTRY["create_task"].mutating)
        self.assertTrue(REGISTRY["update_task"].mutating)
        self.assertTrue(REGISTRY["complete_task"].mutating)
        self.assertFalse(REGISTRY["search_tasks"].mutating)
        self.assertFalse(REGISTRY["get_member_tasks"].mutating)


if __name__ == "__main__":
    unittest.main()
