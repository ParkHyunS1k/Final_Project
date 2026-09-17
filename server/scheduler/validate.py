"""제약 검증기 — 제약 만족률(CSR)의 근거.

CSR = 위반이 0인 계획의 비율. 자동 채점되므로 계획 생성 품질을 그래프 하나로 보고할 수 있다.

업무량 불균형(workload_imbalance_ratio)은 **하드 제약에 넣지 않는다.** 임계값에 보편적 근거가
없어서 정답이 아닌 이유로 CSR이 흔들린다. 균형은 별도 품질 지표로 따로 본다.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date

from ..tools.registry import ToolContext
from .backward import Schedule, SchedulerError, schedule_project

# 위반 코드
DEPENDENCY_CYCLE = "DEPENDENCY_CYCLE"
ANCHOR_INFEASIBLE = "ANCHOR_INFEASIBLE"
DEADLINE_AFTER_ANCHOR = "DEADLINE_AFTER_ANCHOR"
UNASSIGNED_TASK = "UNASSIGNED_TASK"
MISSING_EFFORT = "MISSING_EFFORT"
MILESTONE_ORDER = "MILESTONE_ORDER"
CAPACITY_OVERRUN = "CAPACITY_OVERRUN"


@dataclass
class Violation:
    code: str
    message: str
    task_id: str | None = None
    member: str | None = None

    def to_dict(self) -> dict:
        return {k: v for k, v in self.__dict__.items() if v is not None}


def validate(ctx: ToolContext, schedule: Schedule | None = None) -> list[Violation]:
    conn, pid = ctx.conn, ctx.project_id
    out: list[Violation] = []

    if schedule is None:
        try:
            schedule = schedule_project(ctx)
        except SchedulerError as e:
            return [Violation(DEPENDENCY_CYCLE, str(e))]

    milestones = {
        r["id"]: r for r in conn.execute("SELECT * FROM milestone WHERE project_id = ?", (pid,))
    }
    anchor_dates = [m["date"] for m in milestones.values() if m["kind"] == "anchor" and m["date"]]
    final_anchor = max(anchor_dates) if anchor_dates else None

    for ms in milestones.values():
        if not ms["date"]:
            continue  # 날짜 미확정 마일스톤은 순서를 따질 수 없다
        if final_anchor and ms["kind"] == "derived" and ms["date"] > final_anchor:
            out.append(
                Violation(MILESTONE_ORDER, f"파생 마일스톤이 최종 앵커보다 늦다: {ms['title']} ({ms['date']})")
            )

    for row in conn.execute(
        "SELECT t.*, m.name AS assignee_name FROM task t"
        " LEFT JOIN member m ON m.id = t.assignee_id"
        " WHERE t.project_id = ? AND t.status != 'done' ORDER BY t.id",
        (pid,),
    ):
        if row["assignee_id"] is None:
            out.append(Violation(UNASSIGNED_TASK, f"담당자 미배정: {row['title']}", task_id=row["id"]))
        if row["effort_hours"] is None:
            out.append(Violation(MISSING_EFFORT, f"예상 공수 없음: {row['title']}", task_id=row["id"]))
        ms = milestones.get(row["milestone_id"])
        if row["deadline"] and ms and ms["date"] and row["deadline"] > ms["date"]:
            out.append(
                Violation(
                    DEADLINE_AFTER_ANCHOR,
                    f"업무 마감이 마일스톤({ms['title']} {ms['date']})보다 늦다: {row['title']}",
                    task_id=row["id"],
                )
            )

    for t in schedule.tasks:
        if t.overrun_days > 0:
            out.append(
                Violation(
                    ANCHOR_INFEASIBLE,
                    f"착수해도 늦는다: {t.title} — 마감 {t.anchor_date} 기준 {t.overrun_days}일 초과",
                    task_id=t.id,
                    member=t.assignee,
                )
            )

    for o in schedule.overruns:
        out.append(
            Violation(
                CAPACITY_OVERRUN,
                f"{o.member}: {o.milestone_date}까지 가용 {o.available_hours:.1f}h < 배정 {o.assigned_hours:.1f}h"
                f" ({o.excess_hours:.1f}h 초과)",
                member=o.member,
            )
        )
    return out


def csr_pass(violations: list[Violation]) -> bool:
    """이 계획이 CSR 분자에 들어가는가."""
    return not violations
