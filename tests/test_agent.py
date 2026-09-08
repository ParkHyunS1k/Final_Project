"""envelope 파서 · 상태머신 · 로깅 테스트. FakeLLMClient만 쓴다(네트워크 없음)."""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server.agent import Agent, EnvelopeError, FakeLLMClient, parse_envelope  # noqa: E402
from server.agent.prompt import PROMPT_VERSION, build_system_prompt  # noqa: E402
from server.db.connection import fresh_db  # noqa: E402
from server.db.fixtures import FIXED_NOW, seed_demo  # noqa: E402
from server.tools import ToolContext  # noqa: E402


class TestEnvelopeParser(unittest.TestCase):
    def test_tool_calls(self):
        env = parse_envelope(
            '{"decision":"tool_calls","calls":[{"name":"create_task","arguments":{"title":"평가"}}]}'
        )
        self.assertEqual(env.decision, "tool_calls")
        self.assertEqual(env.calls[0].name, "create_task")
        self.assertEqual(env.calls[0].arguments, {"title": "평가"})

    def test_clarify_and_no_tool(self):
        env = parse_envelope('{"decision":"clarify","missing_fields":["deadline"],"question":"언제?"}')
        self.assertEqual((env.decision, env.question, env.missing_fields), ("clarify", "언제?", ["deadline"]))
        env = parse_envelope('{"decision":"no_tool","answer":"진행률은 40%입니다"}')
        self.assertEqual(env.decision, "no_tool")

    def test_code_fence_is_stripped(self):
        # 유일하게 허용한 교정. 모든 조건에 똑같이 적용되므로 비교를 깨지 않는다.
        env = parse_envelope('```json\n{"decision":"no_tool","answer":"네"}\n```')
        self.assertEqual(env.decision, "no_tool")

    def test_prose_around_json_is_not_repaired(self):
        with self.assertRaises(EnvelopeError):
            parse_envelope('알겠습니다! {"decision":"no_tool","answer":"네"}')

    def test_failures(self):
        bad = [
            "",
            "그냥 문장",
            "[]",
            '{"decision":"execute","calls":[]}',
            '{"decision":"tool_calls","calls":[]}',
            '{"decision":"tool_calls","calls":[{"arguments":{}}]}',
            '{"decision":"tool_calls","calls":[{"name":"x","arguments":[]}]}',
            '{"decision":"clarify","missing_fields":["a"]}',
            '{"decision":"no_tool"}',
        ]
        for raw in bad:
            with self.assertRaises(EnvelopeError, msg=raw):
                parse_envelope(raw)


class AgentTestCase(unittest.TestCase):
    def setUp(self):
        self.conn = fresh_db()
        seed_demo(self.conn)
        self.ctx = ToolContext(conn=self.conn, project_id="p_demo", now=FIXED_NOW)

    def tearDown(self):
        self.conn.close()

    def agent(self, *responses, **kwargs):
        self.client = FakeLLMClient(responses=list(responses))
        return Agent(self.ctx, self.client, **kwargs)

    def rows(self, table):
        return self.conn.execute(f"SELECT * FROM {table}").fetchall()


class TestPrompt(AgentTestCase):
    def test_contains_today_members_and_tools(self):
        system = build_system_prompt(self.ctx)
        self.assertIn("2026-09-08 (화요일)", system)
        self.assertIn("김현민", system)
        self.assertIn("create_task", system)
        self.assertIn("complete_task", system)

    def test_only_implemented_tools_are_exposed(self):
        # 문서상 12개를 다 노출하면 모델 오류와 미구현 오류가 섞인다
        system = build_system_prompt(self.ctx)
        self.assertNotIn("find_common_time", system)

    def test_task_list_is_in_context_with_ids(self):
        """v1은 업무 목록이 없어서 'ID를 알려주세요'로 되물었다. id가 보여야 한다."""
        system = build_system_prompt(self.ctx)
        self.assertIn("t_eval", system)
        self.assertIn("평가 하네스 작성", system)
        self.assertIn("현재 업무", system)

    def test_context_does_not_leak_other_projects(self):
        system = build_system_prompt(self.ctx)
        self.assertNotIn("t_out", system)
        self.assertNotIn("남현민", system)

    def test_context_task_list_is_capped(self):
        from server.agent.prompt import CONTEXT_TASK_LIMIT

        for i in range(CONTEXT_TASK_LIMIT + 5):
            self.conn.execute(
                "INSERT INTO task (id, project_id, title, status) VALUES (?, 'p_demo', ?, 'todo')",
                (f"t_bulk{i}", f"대량 업무 {i}"),
            )
        system = build_system_prompt(self.ctx)
        self.assertIn("search_tasks로 찾아라", system)
        self.assertLessEqual(system.count("t_bulk"), CONTEXT_TASK_LIMIT)


class TestReadPath(AgentTestCase):
    def test_read_tool_executes_immediately(self):
        agent = self.agent(
            '{"decision":"tool_calls","calls":[{"name":"search_tasks","arguments":{"delayed_only":true}}]}',
            '{"decision":"no_tool","answer":"지연 업무는 1건입니다"}',
        )
        turn = agent.run("지연된 업무 뭐 있어?")
        self.assertEqual(turn.decision, "no_tool")
        self.assertEqual(turn.executed[0][0], "search_tasks")
        self.assertTrue(turn.executed[0][1].ok)
        self.assertEqual(len(self.rows("action_proposal")), 0, "조회는 승인 대상이 아니다")
        self.assertEqual(len(self.rows("tool_call_log")), 1)
        self.assertEqual(len(self.rows("model_invocation")), 2)

    def test_observation_is_fed_back(self):
        agent = self.agent(
            '{"decision":"tool_calls","calls":[{"name":"get_member_tasks","arguments":{"member":"김현민"}}]}',
            '{"decision":"no_tool","answer":"현민님은 15시간입니다"}',
        )
        agent.run("현민이 업무량 얼마나 돼?")
        self.assertIn("방금 실행한 Tool 결과", self.client.calls[1].user)
        self.assertIn("get_member_tasks", self.client.calls[1].user)


class TestMutationPath(AgentTestCase):
    CREATE = (
        '{"decision":"tool_calls","calls":[{"name":"create_task",'
        '"arguments":{"title":"모델 평가","assignee":"이성경","deadline":"2026-09-11"}}]}'
    )

    def test_mutation_stops_at_approval(self):
        turn = self.agent(self.CREATE).run("성경이한테 금요일까지 모델평가 던져줘")
        self.assertTrue(turn.awaiting_approval)
        self.assertEqual(len(turn.proposals), 1)
        self.assertEqual(len(self.rows("tool_call_log")), 0, "승인 전에 실행되면 안 된다")

        proposal = self.rows("action_proposal")[0]
        self.assertEqual(proposal["decision"], "pending")
        self.assertEqual(proposal["proposed_tool_name"], "create_task")
        before = self.conn.execute("SELECT COUNT(*) c FROM task WHERE project_id = 'p_demo'").fetchone()["c"]
        self.assertEqual(before, 5, "DB가 아직 바뀌면 안 된다")

    def test_approve_executes_and_logs(self):
        agent = self.agent(self.CREATE)
        turn = agent.run("성경이한테 금요일까지 모델평가 던져줘")
        done = agent.resume(turn.proposals[0].proposal_id, "approved")

        self.assertTrue(done.executed[0][1].ok)
        self.assertEqual(done.executed[0][1].result["assignee"], "이성경")
        self.assertEqual(done.executed[0][1].result["deadline"], "2026-09-11")

        proposal = self.rows("action_proposal")[0]
        self.assertEqual(proposal["decision"], "approved")
        self.assertIsNotNone(proposal["decided_at"])

        log = self.rows("tool_call_log")[0]
        self.assertEqual(log["ok"], 1)
        self.assertEqual(log["proposal_id"], proposal["id"])
        self.assertEqual(log["invocation_id"], proposal["invocation_id"])

    def test_edit_keeps_both_arguments(self):
        """수정 로그 = 재학습 신호. 원본과 확정본이 둘 다 남아야 성립한다."""
        agent = self.agent(self.CREATE)
        turn = agent.run("성경이한테 금요일까지 모델평가 던져줘")
        agent.resume(
            turn.proposals[0].proposal_id,
            "edited",
            edited_arguments={"title": "모델 평가", "assignee": "이성경", "deadline": "2026-09-18"},
        )
        proposal = self.rows("action_proposal")[0]
        self.assertEqual(proposal["decision"], "edited")
        self.assertEqual(json.loads(proposal["proposed_arguments"])["deadline"], "2026-09-11")
        self.assertEqual(json.loads(proposal["approved_arguments"])["deadline"], "2026-09-18")
        row = self.conn.execute("SELECT deadline FROM task WHERE title = '모델 평가'").fetchone()
        self.assertEqual(row["deadline"], "2026-09-18")

    def test_reject_does_not_execute_but_keeps_the_proposal(self):
        agent = self.agent(self.CREATE)
        turn = agent.run("성경이한테 모델평가 던져줘")
        agent.resume(turn.proposals[0].proposal_id, "rejected")
        self.assertEqual(self.rows("action_proposal")[0]["decision"], "rejected")
        self.assertEqual(len(self.rows("tool_call_log")), 0)
        self.assertEqual(self.conn.execute("SELECT COUNT(*) c FROM task WHERE project_id = 'p_demo'").fetchone()["c"], 5)

    def test_mixed_read_and_write_all_go_to_approval(self):
        agent = self.agent(
            '{"decision":"tool_calls","calls":['
            '{"name":"search_tasks","arguments":{"status":"todo"}},'
            '{"name":"complete_task","arguments":{"task_id":"t_eval"}}]}'
        )
        turn = agent.run("todo 보여주고 평가 하네스는 완료 처리해줘")
        self.assertTrue(turn.awaiting_approval)
        self.assertEqual(len(turn.proposals), 2)
        self.assertEqual(len(self.rows("tool_call_log")), 0)

    def test_failed_tool_is_logged_and_rolled_back(self):
        agent = self.agent(
            '{"decision":"tool_calls","calls":[{"name":"create_task",'
            '"arguments":{"title":"테스트","assignee":"홍길동"}}]}'
        )
        turn = agent.run("홍길동한테 업무 줘")
        done = agent.resume(turn.proposals[0].proposal_id, "approved")
        self.assertFalse(done.executed[0][1].ok)
        self.assertEqual(done.executed[0][1].error_type, "NOT_FOUND")

        log = self.rows("tool_call_log")[0]
        self.assertEqual(log["ok"], 0)
        self.assertEqual(log["error_type"], "NOT_FOUND")
        # 실패해도 승인 기록과 로그는 남는다
        self.assertEqual(self.rows("action_proposal")[0]["decision"], "approved")
        self.assertEqual(self.conn.execute("SELECT COUNT(*) c FROM task WHERE project_id = 'p_demo'").fetchone()["c"], 5)

    def test_resume_twice_is_refused(self):
        agent = self.agent(self.CREATE)
        turn = agent.run("성경이한테 모델평가 던져줘")
        agent.resume(turn.proposals[0].proposal_id, "approved")
        with self.assertRaises(ValueError):
            agent.resume(turn.proposals[0].proposal_id, "approved")

    def test_resume_is_scoped_to_project(self):
        agent = self.agent(self.CREATE)
        turn = agent.run("성경이한테 모델평가 던져줘")
        other = Agent(
            ToolContext(conn=self.conn, project_id="p_other", now=FIXED_NOW),
            FakeLLMClient(),
        )
        with self.assertRaises(ValueError):
            other.resume(turn.proposals[0].proposal_id, "approved")


class TestNonToolPaths(AgentTestCase):
    def test_clarify_is_logged_without_tool_call(self):
        turn = self.agent(
            '{"decision":"clarify","missing_fields":["deadline"],"question":"언제까지인가요?"}'
        ).run("다음 주쯤까지 발표자료 만들어줘")
        self.assertEqual(turn.decision, "clarify")
        self.assertEqual(turn.question, "언제까지인가요?")
        self.assertEqual(len(self.rows("tool_call_log")), 0)
        inv = self.rows("model_invocation")[0]
        self.assertEqual(inv["decision"], "clarify")
        self.assertEqual(json.loads(inv["parsed"])["missing_fields"], ["deadline"])

    def test_no_tool_is_logged(self):
        turn = self.agent('{"decision":"no_tool","answer":"저는 날씨를 모릅니다"}').run("오늘 날씨 어때?")
        self.assertEqual(turn.decision, "no_tool")
        self.assertEqual(self.rows("model_invocation")[0]["decision"], "no_tool")

    def test_parse_error_is_recorded_not_retried(self):
        client_agent = self.agent("죄송합니다, 무슨 말인지 모르겠어요")
        turn = client_agent.run("업무 만들어줘")
        self.assertEqual(turn.decision, "parse_error")
        self.assertEqual(len(self.client.calls), 1, "평가 비교가 깨지므로 재시도하면 안 된다")
        inv = self.rows("model_invocation")[0]
        self.assertEqual(inv["decision"], "parse_error")
        self.assertIsNotNone(inv["parse_error"])
        self.assertEqual(inv["raw_output"], "죄송합니다, 무슨 말인지 모르겠어요")

    def test_hallucinated_tool_is_not_found(self):
        turn = self.agent(
            '{"decision":"tool_calls","calls":[{"name":"delete_project","arguments":{}}]}'
        ).run("프로젝트 지워줘")
        self.assertEqual(turn.executed[0][1].error_type, "NOT_FOUND")
        self.assertEqual(self.rows("tool_call_log")[0]["error_type"], "NOT_FOUND")


class TestInvocationLog(AgentTestCase):
    def test_experiment_conditions_are_recorded(self):
        agent = self.agent(
            '{"decision":"no_tool","answer":"네"}', mode="eval", assigned_group="A", session_id="s1"
        )
        agent.run("안녕")
        inv = self.rows("model_invocation")[0]
        self.assertEqual(inv["mode"], "eval")
        self.assertEqual(inv["assigned_group"], "A")
        self.assertEqual(inv["session_id"], "s1")
        self.assertEqual(inv["requested_model"], "fake")
        self.assertEqual(inv["served_model"], "fake")
        self.assertEqual(inv["prompt_version"], PROMPT_VERSION)
        self.assertEqual(inv["toolset_version"], "core5-dev-v1")
        self.assertEqual(len(inv["prompt_hash"]), 12)
        self.assertEqual(json.loads(inv["generation_config"])["structured"], False)

    def test_prompt_hash_changes_with_context(self):
        agent = self.agent('{"decision":"no_tool","answer":"1"}', '{"decision":"no_tool","answer":"2"}')
        agent.run("안녕")
        self.conn.execute(
            "INSERT INTO member (id, project_id, name, weekly_hours) VALUES ('m_new','p_demo','새사람',5)"
        )
        agent.run("안녕")
        hashes = [r["prompt_hash"] for r in self.rows("model_invocation")]
        self.assertNotEqual(hashes[0], hashes[1])


if __name__ == "__main__":
    unittest.main()
