"""의존관계 기반 역산 스케줄러.

**이름 주의**: 엄밀한 CPM이 아니다. CPM은 자원 제약을 가정하지 않는다. 여기서는 담당자별
가용량 제약이 들어가므로 자원제약 스케줄링에 가깝다. 발표에서 "CPM 구현"이라고 말하지 않는다.

절차
  1. 의존 그래프 위상정렬. 사이클이면 즉시 에러.
  2. 후진 패스: 업무가 속한 **마일스톤 앵커**에서 역산해 latest_finish / latest_start.
     - 마감이 늦은 업무부터 처리해 뒤쪽 날짜를 먼저 가져간다.
     - 같은 담당자의 날짜는 공유 장부에서 차감되므로 자원 평준화가 함께 일어난다.
  3. 전진 패스: 착수 가능일(project_start)부터 earliest_start / earliest_finish. (별도 장부)
  4. slack = latest_start - earliest_start. slack <= 0 이면 크리티컬.
  5. latest_start < project_start 이면 OVERRUN(이미 늦었다) + 초과 일수.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, timedelta

import networkx as nx

from ..tools.registry import ToolContext
from .capacity import UNASSIGNED, Ledger, build_capacity


class SchedulerError(Exception):
    pass


@dataclass
class ScheduledTask:
    id: str
    title: str
    assignee: str | None
    assignee_id: str | None
    milestone_id: str | None
    anchor_title: str | None
    anchor_date: str | None
    effort_hours: float
    earliest_start: str
    earliest_finish: str
    latest_start: str
    latest_finish: str
    slack_days: int
    critical: bool
    overrun_days: int
    depends_on: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return dict(self.__dict__)


@dataclass
class Overrun:
    """담당자 × 마일스톤 단위 가용량 초과."""

    member: str
    milestone_title: str | None
    milestone_date: str
    assigned_hours: float
    available_hours: float

    @property
    def excess_hours(self) -> float:
        return round(self.assigned_hours - self.available_hours, 2)

    def to_dict(self) -> dict:
        return {
            "member": self.member,
            "milestone_title": self.milestone_title,
            "milestone_date": self.milestone_date,
            "assigned_hours": round(self.assigned_hours, 2),
            "available_hours": round(self.available_hours, 2),
            "excess_hours": self.excess_hours,
        }


@dataclass
class Schedule:
    project_start: str
    tasks: list[ScheduledTask]
    overruns: list[Overrun]
    anchors: list[dict]

    @property
    def critical_path(self) -> list[str]:
        return [t.id for t in self.tasks if t.critical]

    def by_id(self, task_id: str) -> ScheduledTask:
        for t in self.tasks:
            if t.id == task_id:
                return t
        raise KeyError(task_id)

    def to_dict(self) -> dict:
        return {
            "project_start": self.project_start,
            "anchors": self.anchors,
            "tasks": [t.to_dict() for t in self.tasks],
            "overruns": [o.to_dict() for o in self.overruns],
            "critical_path": self.critical_path,
        }


def schedule_project(ctx: ToolContext, *, start_date: date | None = None) -> Schedule:
    conn, pid = ctx.conn, ctx.project_id
    project_start = start_date or ctx.now.date()

    milestones = {
        r["id"]: r
        for r in conn.execute("SELECT * FROM milestone WHERE project_id = ? ORDER BY date", (pid,))
    }
    anchors = [m for m in milestones.values() if m["kind"] == "anchor"]
    # 날짜 미확정(date IS NULL) 마일스톤은 제약이 될 수 없다. 일정 계산에서 빼되 목록에는 남긴다.
    dated = [m["date"] for m in milestones.values() if m["date"]]
    final_date = max(dated, default=None)
    if final_date is None:
        raise SchedulerError(
            "날짜가 확정된 마일스톤이 없다. 공고문 부트스트랩을 돌리거나 미확정 마일스톤의 날짜를 채워야 한다."
        )

    rows = conn.execute(
        "SELECT t.*, m.name AS assignee_name FROM task t"
        " LEFT JOIN member m ON m.id = t.assignee_id"
        " WHERE t.project_id = ? AND t.status != 'done' ORDER BY t.id",
        (pid,),
    ).fetchall()
    tasks = {r["id"]: r for r in rows}

    graph = nx.DiGraph()
    graph.add_nodes_from(tasks)
    for r in conn.execute(
        "SELECT d.task_id, d.depends_on_id FROM task_dependency d"
        " JOIN task t ON t.id = d.task_id WHERE t.project_id = ?",
        (pid,),
    ):
        # 완료된 선행 업무는 제약이 아니므로 그래프에서 뺀다.
        if r["task_id"] in tasks and r["depends_on_id"] in tasks:
            graph.add_edge(r["depends_on_id"], r["task_id"])
    if not nx.is_directed_acyclic_graph(graph):
        cycle = nx.find_cycle(graph)
        raise SchedulerError(f"의존 사이클이 있다: {[e[0] for e in cycle]}")

    capacity = build_capacity(conn, pid)
    back_ledger, fwd_ledger = Ledger(capacity), Ledger(capacity)

    def owner(row) -> str:
        return row["assignee_id"] or UNASSIGNED

    def anchor_date_of(row) -> str:
        ms = milestones.get(row["milestone_id"])
        # 마일스톤이 없거나 그 마일스톤의 날짜가 미확정이면 프로젝트 최종 마일스톤을 마감으로 본다.
        return (ms["date"] if ms else None) or final_date

    # ── 후진 패스 ────────────────────────────────────────
    latest_finish: dict[str, date] = {}
    latest_start: dict[str, date] = {}
    unprocessed_succ = {n: set(graph.successors(n)) for n in graph}
    ready = [n for n, s in unprocessed_succ.items() if not s]

    def bound(node: str) -> date:
        limit = date.fromisoformat(anchor_date_of(tasks[node]))
        for succ in graph.successors(node):
            limit = min(limit, latest_start[succ] - timedelta(days=1))
        return limit

    while ready:
        # 마감이 늦은 업무부터 뒤쪽 날짜를 가져간다. 동률이면 id 순(결정적).
        node = max(ready, key=lambda n: (bound(n), n))
        ready.remove(node)
        row = tasks[node]
        _, days = back_ledger.consume_backward(owner(row), bound(node), row["effort_hours"] or 0.0)
        # 마감(bound)이 아니라 **실제로 가용시간을 쓴 마지막 날**이 latest_finish다.
        # 같은 담당자의 다른 업무가 뒤쪽 날을 이미 먹었으면 이 업무는 그만큼 앞당겨진다.
        latest_finish[node], latest_start[node] = days[-1], days[0]
        for pred in graph.predecessors(node):
            unprocessed_succ[pred].discard(node)
            if not unprocessed_succ[pred]:
                ready.append(pred)

    # ── 전진 패스 ────────────────────────────────────────
    earliest_start: dict[str, date] = {}
    earliest_finish: dict[str, date] = {}
    for node in nx.topological_sort(graph):
        row = tasks[node]
        begin = project_start
        for pred in graph.predecessors(node):
            begin = max(begin, earliest_finish[pred] + timedelta(days=1))
        finish, _ = fwd_ledger.consume_forward(owner(row), begin, row["effort_hours"] or 0.0)
        earliest_start[node], earliest_finish[node] = begin, finish

    scheduled: list[ScheduledTask] = []
    for node, row in tasks.items():
        ms = milestones.get(row["milestone_id"])
        slack = (latest_start[node] - earliest_start[node]).days
        overrun = max(0, (project_start - latest_start[node]).days)
        scheduled.append(
            ScheduledTask(
                id=node,
                title=row["title"],
                assignee=row["assignee_name"],
                assignee_id=row["assignee_id"],
                milestone_id=row["milestone_id"],
                anchor_title=ms["title"] if ms else None,
                anchor_date=anchor_date_of(row),
                effort_hours=row["effort_hours"] or 0.0,
                earliest_start=earliest_start[node].isoformat(),
                earliest_finish=earliest_finish[node].isoformat(),
                latest_start=latest_start[node].isoformat(),
                latest_finish=latest_finish[node].isoformat(),
                slack_days=slack,
                critical=slack <= 0,
                overrun_days=overrun,
                depends_on=sorted(graph.predecessors(node)),
            )
        )
    scheduled.sort(key=lambda t: (t.latest_start, t.id))

    return Schedule(
        project_start=project_start.isoformat(),
        tasks=scheduled,
        overruns=_find_overruns(conn, tasks, milestones, final_date, project_start, back_ledger),
        anchors=[
            {
                "id": a["id"],
                "title": a["title"],
                "date": a["date"],
                "date_hint": a["date_hint"],
                "event_type": a["event_type"],
            }
            for a in anchors
        ],
    )


def _find_overruns(conn, tasks, milestones, final_date, project_start, ledger) -> list[Overrun]:
    """담당자 × 마일스톤 기간 안에서 (가용량 < 배정 공수)인 조합을 찾는다.

    팀 합계로 보면 한 사람에게 몰린 경우를 놓치므로 담당자별로 본다.
    """
    buckets: dict[tuple[str, str | None], float] = {}
    for row in tasks.values():
        key = (row["assignee_id"] or UNASSIGNED, row["milestone_id"])
        buckets[key] = buckets.get(key, 0.0) + (row["effort_hours"] or 0.0)

    names = {
        r["id"]: r["name"] for r in conn.execute("SELECT id, name FROM member")
    }
    out: list[Overrun] = []
    for (member_id, ms_id), hours in sorted(buckets.items(), key=lambda kv: (kv[0][0], str(kv[0][1]))):
        ms = milestones.get(ms_id)
        end_iso = (ms["date"] if ms else None) or final_date
        end = date.fromisoformat(end_iso)
        available = ledger.window_capacity(member_id, project_start, end)
        if hours > available + 1e-9:
            out.append(
                Overrun(
                    member=names.get(member_id, "미배정"),
                    milestone_title=ms["title"] if ms else None,
                    milestone_date=end_iso,
                    assigned_hours=hours,
                    available_hours=available,
                )
            )
    return out
