"""시간표(busy_slot) → 팀원별 '요일별' 가용시간, 그리고 날짜별 소진 장부.

주간 총합만 쓰면 주말과 공강 0인 날이 무시된다. 요일별로 들고 있어야 한다.

요일별 가용시간 산출 규칙 (magic number를 만들지 않기 위한 선택):
    member.weekly_hours = 팀원이 프로젝트에 쓸 수 있다고 밝힌 주당 시간(총량)
    busy_slot           = 그 시간을 '어느 요일에' 쓸 수 있는지의 분포
  → capacity[요일] = weekly_hours × (그 요일 공강시간 / 주간 공강시간 합)

공강이 0인 요일은 0시간이 되어 자동으로 건너뛰어진다.
시간표가 아예 없는 팀원은 7일 균등 분배한다(분포를 모르므로).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, timedelta

# 활동 가능 시간대(자정 기준 분). 회의 가능 시간대와는 별개 개념이다.
WORK_WINDOW = (9 * 60, 24 * 60)
_WINDOW_HOURS = (WORK_WINDOW[1] - WORK_WINDOW[0]) / 60.0


def free_hours_by_weekday(conn, member_id: str) -> list[float]:
    """요일별 공강 시간(0=월 ... 6=일). busy_slot의 여집합을 WORK_WINDOW로 자른다."""
    busy = [0.0] * 7
    for row in conn.execute(
        "SELECT weekday, start_min, end_min FROM busy_slot WHERE member_id = ?", (member_id,)
    ):
        lo = max(row["start_min"], WORK_WINDOW[0])
        hi = min(row["end_min"], WORK_WINDOW[1])
        if hi > lo:
            busy[row["weekday"]] += (hi - lo) / 60.0
    return [max(0.0, _WINDOW_HOURS - b) for b in busy]


def daily_capacity(conn, member_id: str, weekly_hours: float) -> list[float]:
    """요일별 투입 가능 시간. 합계는 weekly_hours와 같다."""
    free = free_hours_by_weekday(conn, member_id)
    total = sum(free)
    if total <= 0:
        return [weekly_hours / 7.0] * 7
    return [weekly_hours * f / total for f in free]


@dataclass
class Ledger:
    """날짜별 잔여 가용시간 장부. 한 사람의 업무가 같은 날 겹치지 않게 한다.

    같은 장부를 공유하면 자원 평준화가 자동으로 일어난다(먼저 배치된 업무가 그 날을 이미 먹는다).
    전진 패스와 후진 패스는 서로 다른 시나리오이므로 **장부를 따로 쓴다.**
    """

    capacity: dict[str, list[float]]           # member_id → 요일별 시간
    used: dict[tuple[str, date], float] = field(default_factory=dict)
    max_span_days: int = 400

    def capacity_on(self, member_id: str, day: date) -> float:
        cap = self.capacity.get(member_id)
        if cap is None:
            return 0.0
        return max(0.0, cap[day.weekday()] - self.used.get((member_id, day), 0.0))

    def _take(self, member_id: str, day: date, hours: float) -> float:
        avail = self.capacity_on(member_id, day)
        take = min(avail, hours)
        if take > 0:
            self.used[(member_id, day)] = self.used.get((member_id, day), 0.0) + take
        return take

    def consume_backward(self, member_id: str, finish: date, hours: float) -> tuple[date, list[date]]:
        """finish일부터 거꾸로 가용시간을 차감해 착수일을 찾는다.

        달력일 균등 분할(effort/(weekly/7))을 쓰지 않는다. 실제 가용일만 센다.
        """
        if hours <= 0:
            return finish, [finish]
        remaining = hours
        day = finish
        days: list[date] = []
        for _ in range(self.max_span_days):
            took = self._take(member_id, day, remaining)
            if took > 0:
                days.append(day)
                remaining -= took
            if remaining <= 1e-9:
                return day, sorted(days)
            day -= timedelta(days=1)
        # 400일을 거슬러도 공수가 안 빠지면 가용량이 사실상 0인 사람이다.
        return day, sorted(days) or [finish]

    def consume_forward(self, member_id: str, start: date, hours: float) -> tuple[date, list[date]]:
        if hours <= 0:
            return start, [start]
        remaining = hours
        day = start
        days: list[date] = []
        for _ in range(self.max_span_days):
            took = self._take(member_id, day, remaining)
            if took > 0:
                days.append(day)
                remaining -= took
            if remaining <= 1e-9:
                return day, sorted(days)
            day += timedelta(days=1)
        return day, sorted(days) or [start]

    def window_capacity(self, member_id: str, start: date, end: date) -> float:
        """[start, end] 구간의 총 가용시간(소진 이력 무시, 순수 용량)."""
        cap = self.capacity.get(member_id)
        if cap is None or end < start:
            return 0.0
        total, day = 0.0, start
        while day <= end:
            total += cap[day.weekday()]
            day += timedelta(days=1)
        return total


def build_capacity(conn, project_id: str) -> dict[str, list[float]]:
    members = conn.execute(
        "SELECT id, weekly_hours FROM member WHERE project_id = ?", (project_id,)
    ).fetchall()
    table = {m["id"]: daily_capacity(conn, m["id"], m["weekly_hours"] or 0.0) for m in members}
    if table:
        # 미배정 업무용 가상 담당자: 팀 평균 가용시간
        avg = [sum(c[i] for c in table.values()) / len(table) for i in range(7)]
        table[UNASSIGNED] = avg
    return table


UNASSIGNED = "__unassigned__"
