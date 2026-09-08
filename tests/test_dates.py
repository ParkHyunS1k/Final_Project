"""한국어 날짜 표기 정규화 테스트.

여기 케이스가 곧 필드 추출 F1의 하한이다. LLM 추출기를 붙여도 이 정규화는 그대로 쓴다.
"""
from __future__ import annotations

import sys
import unittest
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server.extract.dates import find_dates, parse_one  # noqa: E402

BASE = date(2026, 9, 8)  # 가짜 시계 기준일 (화)


class TestDateNormalization(unittest.TestCase):
    def one(self, text):
        return parse_one(text, BASE)

    def test_dotted_with_weekday_and_hour(self):
        m = self.one("10.01(수) 15시까지")
        self.assertEqual((m.date, m.time), ("2026-10-01", "15:00"))

    def test_korean_full(self):
        m = self.one("2026년 10월 1일")
        self.assertEqual((m.date, m.time), ("2026-10-01", None))

    def test_slash_with_pm(self):
        m = self.one("10/1 오후 3시")
        self.assertEqual((m.date, m.time), ("2026-10-01", "15:00"))

    def test_pm_12_and_am_12(self):
        self.assertEqual(self.one("10/1 오후 12시 30분").time, "12:30")
        self.assertEqual(self.one("10/1 오전 12시").time, "00:00")

    def test_short_form_after_label(self):
        self.assertEqual(self.one("접수마감 10.1").date, "2026-10-01")

    def test_spaced_dots(self):
        self.assertEqual(self.one("9. 25.(금) 18:00").date, "2026-09-25")

    def test_hyphen_iso(self):
        self.assertEqual(self.one("2026-10-01 마감").date, "2026-10-01")

    def test_nth_weekday(self):
        # 2026년 10월: 수요일은 7·14·21·28일
        self.assertEqual(self.one("10월 셋째 주 수요일").date, "2026-10-21")
        self.assertEqual(self.one("10월 첫째 주 금요일").date, "2026-10-02")
        self.assertEqual(self.one("10월 마지막 주 금요일").date, "2026-10-30")

    def test_year_rollover(self):
        # 기준일(9/8)보다 이른 월·일은 내년으로 본다 (공고 마감은 과거일 수 없다)
        self.assertEqual(self.one("3.15").date, "2027-03-15")
        self.assertEqual(self.one("9.7").date, "2027-09-07")
        self.assertEqual(self.one("9.8").date, "2026-09-08")

    def test_year_rollover_can_be_disabled(self):
        m = find_dates("3.15", BASE, infer_year=False)[0]
        self.assertEqual(m.date, "2026-03-15")

    def test_period_returns_both_ends(self):
        ms = find_dates("접수 기간: 2026.09.01 ~ 09.25(금) 18:00까지", BASE)
        self.assertEqual([m.date for m in ms], ["2026-09-01", "2026-09-25"])
        self.assertEqual(ms[-1].time, "18:00")

    def test_non_dates_are_ignored(self):
        for text in ("vLLM 0.12에서 제거됨", "팀당 4명 이내", "18:00까지", "정확도 95.5% 달성"):
            self.assertEqual(find_dates(text, BASE), [], text)

    def test_invalid_calendar_date(self):
        self.assertEqual(find_dates("2026.02.30", BASE), [])


if __name__ == "__main__":
    unittest.main()
