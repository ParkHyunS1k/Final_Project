"""역산 스케줄러 · 제약 검증기 테스트.

가용시간을 1.0h/일로 고정한 팀원을 써서 날짜를 손으로 검산할 수 있게 만든다
(weekly_hours=7, busy_slot 없음 → 요일별 균등 1.0h).
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server.db.connection import fresh_db  # noqa: E402
from server.db.fixtures import FIXED_NOW  # noqa: E402
from server.scheduler import SchedulerError, schedule_project, validate  # noqa: E402
from server.scheduler.validate import (  # noqa: E402
    ANCHOR_INFEASIBLE,
    CAPACITY_OVERRUN,
    DEADLINE_AFTER_ANCHOR,
    DEPENDENCY_CYCLE,
    MISSING_EFFORT,
    UNASSIGNED_TASK,
    csr_pass,
)
from server.tools import ToolContext  # noqa: E402


class SchedulerTestCase(unittest.TestCase):
    def setUp(self):
        self.conn = fresh_db()
        self.conn.execute(
            "INSERT INTO project (id, title, created_at) VALUES ('p1', '테스트', '2026-09-01')"
        )
        self.ctx = ToolContext(conn=self.conn, project_id="p1", now=FIXED_NOW)  # 오늘 = 2026-09-08

    def tearDown(self):
        self.conn.close()

    # ── 빌더 ─────────────────────────────────────────────
    def member(self, mid, name, weekly_hours=7.0, busy=()):
        self.conn.execute(
            "INSERT INTO member (id, project_id, name, weekly_hours) VALUES (?, 'p1', ?, ?)",
            (mid, name, weekly_hours),
        )
        for weekday, start_min, end_min in busy:
            self.conn.execute(
                "INSERT INTO busy_slot (id, member_id, weekday, start_min, end_min)"
                " VALUES (?, ?, ?, ?, ?)",
                (f"bs_{mid}_{weekday}_{start_min}", mid, weekday, start_min, end_min),
            )

    def milestone(self, msid, title, day, kind="anchor"):
        self.conn.execute(
            "INSERT INTO milestone (id, project_id, title, date, kind, locked)"
            " VALUES (?, 'p1', ?, ?, ?, ?)",
            (msid, title, day, kind, 1 if kind == "anchor" else 0),
        )

    def task(self, tid, title, *, assignee=None, effort=None, milestone=None, deps=(), status="todo",
             deadline=None):
        self.conn.execute(
            "INSERT INTO task (id, project_id, milestone_id, title, assignee_id, status, deadline, effort_hours)"
            " VALUES (?, 'p1', ?, ?, ?, ?, ?, ?)",
            (tid, milestone, title, assignee, status, deadline, effort),
        )
        for dep in deps:
            self.conn.execute(
                "INSERT INTO task_dependency (task_id, depends_on_id) VALUES (?, ?)", (tid, dep)
            )

    def schedule(self):
        self.conn.commit()
        return schedule_project(self.ctx)


class TestBackwardPass(SchedulerTestCase):
    def test_effort_is_converted_by_available_hours_not_calendar_days(self):
        self.member("m1", "현민")  # 1.0h/일
        self.milestone("ms1", "제출", "2026-09-30")
        self.task("t1", "구현", assignee="m1", effort=6, milestone="ms1")
        t = self.schedule().by_id("t1")
        self.assertEqual(t.latest_finish, "2026-09-30")
        self.assertEqual(t.latest_start, "2026-09-25")  # 6h ÷ 1.0h/일 = 6일

    def test_zero_capacity_weekday_is_skipped(self):
        # 수요일(2)만 종일 수업 → 그 요일 가용시간 0 → 건너뛴다
        self.member("m1", "현민", busy=[(2, 0, 24 * 60)])
        self.milestone("ms1", "제출", "2026-09-30")  # 수요일
        self.task("t1", "구현", assignee="m1", effort=2, milestone="ms1")
        t = self.schedule().by_id("t1")
        # 30일(수)은 가용 0h라 실제 작업일이 아니다 → 29·28에서 1h씩
        self.assertEqual(t.latest_finish, "2026-09-29")
        self.assertEqual(t.latest_start, "2026-09-28")

    def test_each_task_counts_back_from_its_own_anchor(self):
        # 앵커가 여러 개면 최종 앵커 하나가 아니라 업무별 소속 앵커에서 역산한다
        self.member("m1", "현민")
        self.milestone("ms1", "1차 제출", "2026-09-20")
        self.milestone("ms2", "본선", "2026-10-20")
        self.task("t1", "기획", assignee="m1", effort=3, milestone="ms1")
        self.task("t2", "발표", assignee="m1", effort=3, milestone="ms2")
        s = self.schedule()
        self.assertEqual(s.by_id("t1").latest_finish, "2026-09-20")
        self.assertEqual(s.by_id("t2").latest_finish, "2026-10-20")

    def test_dependency_pushes_predecessor_earlier(self):
        self.member("m1", "현민")
        self.milestone("ms1", "제출", "2026-09-30")
        self.task("t1", "설계", assignee="m1", effort=3, milestone="ms1")
        self.task("t2", "구현", assignee="m1", effort=3, milestone="ms1", deps=["t1"])
        s = self.schedule()
        self.assertLess(s.by_id("t1").latest_finish, s.by_id("t2").latest_start)
        self.assertEqual(s.by_id("t2").latest_start, "2026-09-28")
        self.assertEqual(s.by_id("t1").latest_finish, "2026-09-27")

    def test_same_member_tasks_do_not_share_days(self):
        """자원 평준화: 같은 담당자의 두 업무가 같은 날을 동시에 먹지 않는다."""
        self.member("m1", "현민")
        self.milestone("ms1", "제출", "2026-09-30")
        self.task("t1", "A", assignee="m1", effort=3, milestone="ms1")
        self.task("t2", "B", assignee="m1", effort=3, milestone="ms1")
        s = self.schedule()
        a, b = sorted((s.by_id("t1"), s.by_id("t2")), key=lambda t: t.latest_start)
        self.assertLess(a.latest_finish, b.latest_start, "두 업무의 작업 구간이 겹친다")

    def test_different_members_may_work_in_parallel(self):
        self.member("m1", "현민")
        self.member("m2", "성경")
        self.milestone("ms1", "제출", "2026-09-30")
        self.task("t1", "A", assignee="m1", effort=3, milestone="ms1")
        self.task("t2", "B", assignee="m2", effort=3, milestone="ms1")
        s = self.schedule()
        self.assertEqual(s.by_id("t1").latest_start, s.by_id("t2").latest_start)

    def test_done_tasks_leave_the_graph(self):
        self.member("m1", "현민")
        self.milestone("ms1", "제출", "2026-09-30")
        self.task("t1", "끝난 일", assignee="m1", effort=100, milestone="ms1", status="done")
        self.task("t2", "남은 일", assignee="m1", effort=3, milestone="ms1", deps=["t1"])
        s = self.schedule()
        self.assertEqual([t.id for t in s.tasks], ["t2"])
        self.assertEqual(s.by_id("t2").latest_finish, "2026-09-30")

    def test_cycle_raises(self):
        self.member("m1", "현민")
        self.milestone("ms1", "제출", "2026-09-30")
        self.task("t1", "A", assignee="m1", effort=1, milestone="ms1")
        self.task("t2", "B", assignee="m1", effort=1, milestone="ms1", deps=["t1"])
        self.conn.execute("INSERT INTO task_dependency VALUES ('t1', 't2')")
        with self.assertRaises(SchedulerError):
            self.schedule()

    def test_no_milestone_raises(self):
        self.member("m1", "현민")
        self.task("t1", "A", assignee="m1", effort=1)
        with self.assertRaises(SchedulerError):
            self.schedule()


class TestSlackAndCritical(SchedulerTestCase):
    def test_slack_and_critical_path(self):
        self.member("m1", "현민")
        self.member("m2", "성경")
        self.milestone("ms1", "제출", "2026-09-30")
        # 9/8~9/30 = 23일, 1.0h/일. 체인 공수 합이 23h면 여유 0 → 크리티컬.
        self.task("t1", "체인1", assignee="m1", effort=11, milestone="ms1")
        self.task("t2", "체인2", assignee="m1", effort=12, milestone="ms1", deps=["t1"])
        self.task("t3", "짧은 일", assignee="m2", effort=2, milestone="ms1")
        s = self.schedule()
        self.assertEqual(sorted(s.critical_path), ["t1", "t2"])
        self.assertGreater(s.by_id("t3").slack_days, 0)


class TestOverrunAndValidation(SchedulerTestCase):
    def test_infeasible_plan_is_reported(self):
        self.member("m1", "현민")  # 1.0h/일
        self.milestone("ms1", "제출", "2026-09-15")  # 오늘(9/8) 기준 8일 = 8h 가용
        self.task("t1", "거대 업무", assignee="m1", effort=40, milestone="ms1")
        s = self.schedule()
        t = s.by_id("t1")
        self.assertGreater(t.overrun_days, 0)
        self.assertLess(t.latest_start, s.project_start)

        codes = {v.code for v in validate(self.ctx, s)}
        self.assertIn(ANCHOR_INFEASIBLE, codes)
        self.assertIn(CAPACITY_OVERRUN, codes)

        overrun = s.overruns[0]
        self.assertEqual(overrun.member, "현민")
        self.assertAlmostEqual(overrun.available_hours, 8.0, places=2)
        self.assertAlmostEqual(overrun.excess_hours, 32.0, places=2)

    def test_clean_plan_passes_csr(self):
        self.member("m1", "현민")
        self.milestone("ms1", "제출", "2026-09-30")
        self.task("t1", "구현", assignee="m1", effort=6, milestone="ms1")
        violations = validate(self.ctx, self.schedule())
        self.assertEqual(violations, [])
        self.assertTrue(csr_pass(violations))

    def test_unassigned_and_missing_effort(self):
        self.member("m1", "현민")
        self.milestone("ms1", "제출", "2026-09-30")
        self.task("t1", "미배정 업무", effort=2, milestone="ms1")
        self.task("t2", "공수 없음", assignee="m1", milestone="ms1")
        codes = {v.code for v in validate(self.ctx, self.schedule())}
        self.assertIn(UNASSIGNED_TASK, codes)
        self.assertIn(MISSING_EFFORT, codes)

    def test_task_deadline_after_anchor(self):
        self.member("m1", "현민")
        self.milestone("ms1", "제출", "2026-09-30")
        self.task("t1", "늦은 마감", assignee="m1", effort=2, milestone="ms1", deadline="2026-10-05")
        codes = {v.code for v in validate(self.ctx, self.schedule())}
        self.assertIn(DEADLINE_AFTER_ANCHOR, codes)

    def test_cycle_is_a_violation_not_a_crash(self):
        self.member("m1", "현민")
        self.milestone("ms1", "제출", "2026-09-30")
        self.task("t1", "A", assignee="m1", effort=1, milestone="ms1")
        self.task("t2", "B", assignee="m1", effort=1, milestone="ms1", deps=["t1"])
        self.conn.execute("INSERT INTO task_dependency VALUES ('t1', 't2')")
        self.conn.commit()
        violations = validate(self.ctx)
        self.assertEqual([v.code for v in violations], [DEPENDENCY_CYCLE])


class TestProjectScope(SchedulerTestCase):
    def test_other_project_tasks_are_invisible(self):
        self.conn.execute(
            "INSERT INTO project (id, title, created_at) VALUES ('p2', '남의 팀', '2026-09-01')"
        )
        self.conn.execute(
            "INSERT INTO member (id, project_id, name, weekly_hours) VALUES ('m2', 'p2', '남', 7)"
        )
        self.conn.execute(
            "INSERT INTO milestone (id, project_id, title, date, kind, locked)"
            " VALUES ('ms2', 'p2', '남의 제출', '2026-09-12', 'anchor', 1)"
        )
        self.conn.execute(
            "INSERT INTO task (id, project_id, milestone_id, title, assignee_id, status, effort_hours)"
            " VALUES ('t9', 'p2', 'ms2', '남의 업무', 'm2', 'todo', 50)"
        )
        self.member("m1", "현민")
        self.milestone("ms1", "제출", "2026-09-30")
        self.task("t1", "내 업무", assignee="m1", effort=3, milestone="ms1")
        s = self.schedule()
        self.assertEqual([t.id for t in s.tasks], ["t1"])
        self.assertEqual([a["id"] for a in s.anchors], ["ms1"])


if __name__ == "__main__":
    unittest.main()
