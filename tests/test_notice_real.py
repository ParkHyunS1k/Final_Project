"""실제 공고문(Val 셋) 회귀 테스트.

eval/testset/notice/val/ 의 2건은 **개발셋**이다. 여기 기대값을 고치는 건 허용되지만,
Test 셋을 보고 고치면 그 순간 Test가 아니다(docs/eval.md).

현재 rule-v1이 놓치는 것도 함께 고정해 둔다. LLM 추출기를 붙였을 때
무엇이 개선됐는지 이 파일의 차이로 바로 보인다.
"""
from __future__ import annotations

import sys
import unittest
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from server.db.connection import fresh_db  # noqa: E402
from server.db.fixtures import FIXED_NOW  # noqa: E402
from server.extract import RuleNoticeExtractor, bootstrap_from_notice  # noqa: E402
from server.scheduler import schedule_project  # noqa: E402
from server.tools import ToolContext  # noqa: E402

VAL = ROOT / "eval" / "testset" / "notice" / "val"
BASE = date(2026, 9, 8)


def extract(name: str):
    return RuleNoticeExtractor().extract((VAL / name).read_text(encoding="utf-8"), BASE)


class TestHanaNotice(unittest.TestCase):
    """하나손해보험 — 2단 배치, 시상식 날짜 미확정, 전화번호 노이즈."""

    def setUp(self):
        self.out = extract("hana_ai_video.txt")

    def test_anchors(self):
        got = [(a.title, a.date, a.time, a.event_type) for a in self.out.anchors]
        self.assertEqual(
            got,
            [
                ("접수 마감", "2026-09-08", None, "submission"),
                ("수상작 발표", "2026-09-22", None, "presentation"),
                ("시상식", None, None, "presentation"),  # 날짜 미확정
            ],
        )

    def test_period_start_does_not_leak_into_title(self):
        # "접수 기간 | 2026. 8. 12 ~ 9. 8" → 제목에 시작일이 남으면 안 된다
        titles = [a.title for a in self.out.anchors]
        self.assertNotIn("접수 마감 2026. 8. 12", titles)

    def test_undated_anchor_keeps_the_original_text(self):
        award = next(a for a in self.out.anchors if a.title == "시상식")
        self.assertIsNone(award.date)
        self.assertEqual(award.date_hint, "2026년 10월 예정")

    def test_team_size_from_명(self):
        self.assertEqual(self.out.constraints, {"team_size_max": 4})

    def test_phone_numbers_are_not_dates(self):
        # "02-6670-8939, 8935, 8959, 8951" 이 날짜로 잡히면 안 된다
        for a in self.out.anchors:
            self.assertNotEqual(a.title, "홍보팀")
        self.assertEqual(len(self.out.anchors), 3)


class TestKampNotice(unittest.TestCase):
    """KAMP — 헤더와 날짜가 다른 줄, 일정 표, '3인 이내', 상금 표 노이즈."""

    def setUp(self):
        self.out = extract("kamp_6th.txt")

    def test_deadline_from_header_on_previous_line(self):
        """'접수기간' 헤더 다음 줄의 날짜를 물려받아야 한다. 이 공고에서 가장 중요한 날짜다."""
        deadline = next(a for a in self.out.anchors if a.event_type == "submission")
        self.assertEqual((deadline.title, deadline.date, deadline.time),
                         ("접수마감", "2026-09-17", "23:59"))

    def test_team_size_from_인(self):
        self.assertEqual(self.out.constraints, {"team_size_max": 3})

    def test_schedule_rows(self):
        got = {a.title: a.date for a in self.out.anchors}
        self.assertEqual(got.get("문제발표 및 과제해결"), "2026-10-08")
        self.assertEqual(got.get("발표평가"), "2026-10-30")
        self.assertEqual(got.get("시상"), "2026-11-19")

    def test_prize_and_phone_numbers_are_not_dates(self):
        # 상금 '1,000만원', 전화 '031-628-9676', URL 이 날짜가 되면 안 된다
        self.assertEqual(len(self.out.anchors), 4)

    def test_known_gaps_of_rule_v1(self):
        """아직 못 잡는 것들. 키워드 사전 방식의 한계이고 LLM 추출기의 몫이다."""
        titles = [a.title for a in self.out.anchors]
        self.assertNotIn("참가팀 모집", titles)  # '모집'이 키워드에 없다
        self.assertNotIn("서면평가", titles)      # '평가'가 키워드에 없다


class TestUndatedMilestoneInDb(unittest.TestCase):
    def setUp(self):
        self.conn = fresh_db()
        self.conn.execute(
            "INSERT INTO project (id, title, created_at) VALUES ('p1', '테스트', '2026-09-01')"
        )
        self.conn.commit()
        self.ctx = ToolContext(conn=self.conn, project_id="p1", now=FIXED_NOW)
        bootstrap_from_notice(self.ctx, (VAL / "hana_ai_video.txt").read_text(encoding="utf-8"))

    def tearDown(self):
        self.conn.close()

    def test_stored_as_null_with_hint(self):
        row = self.conn.execute("SELECT * FROM milestone WHERE title = '시상식'").fetchone()
        self.assertIsNone(row["date"])
        self.assertEqual(row["date_hint"], "2026년 10월 예정")
        self.assertEqual(row["locked"], 1)

    def test_scheduler_ignores_undated_milestone(self):
        """날짜 미확정 마일스톤은 제약이 될 수 없다. 목록에는 남지만 마감으로 쓰이지 않는다."""
        self.conn.execute(
            "INSERT INTO member (id, project_id, name, weekly_hours) VALUES ('m1', 'p1', '현민', 7)"
        )
        ms = self.conn.execute("SELECT id FROM milestone WHERE date IS NULL").fetchone()
        self.conn.execute(
            "INSERT INTO task (id, project_id, milestone_id, title, assignee_id, status, effort_hours)"
            " VALUES ('t1', 'p1', ?, '시상식 준비', 'm1', 'todo', 3)",
            (ms["id"],),
        )
        self.conn.commit()

        schedule = schedule_project(self.ctx)
        # 최종 확정 앵커(수상작 발표 9/22)를 마감으로 대체해 쓴다
        self.assertEqual(schedule.by_id("t1").anchor_date, "2026-09-22")
        self.assertIn(None, [a["date"] for a in schedule.anchors])

    def test_all_dates_unknown_is_an_error_not_a_crash(self):
        self.conn.execute("UPDATE milestone SET date = NULL")
        self.conn.commit()
        from server.scheduler import SchedulerError

        with self.assertRaises(SchedulerError):
            schedule_project(self.ctx)


if __name__ == "__main__":
    unittest.main()
