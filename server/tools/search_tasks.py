"""search_tasks — 조건으로 업무 검색 (조회 Tool. 승인 없이 실행)."""
from __future__ import annotations

from ._resolve import resolve_member, task_view
from .registry import ToolContext, tool

SCHEMA = {
    "name": "search_tasks",
    "description": (
        "조건으로 업무를 검색한다. "
        "특정 팀원의 전체 업무 목록만 필요하면 get_member_tasks가 더 적합하다."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "keyword": {"type": "string", "maxLength": 100},
            "status": {"type": "string", "enum": ["todo", "in_progress", "blocked", "done"]},
            "assignee": {"type": "string", "maxLength": 50},
            "deadline_before": {"type": "string", "format": "date"},
            "delayed_only": {
                "type": "boolean",
                "description": "마감일이 지났고 미완료인 업무만",
            },
        },
        "additionalProperties": False,
    },
}

_LIMIT = 100


@tool(SCHEMA, mutating=False)
def search_tasks(
    ctx: ToolContext,
    *,
    keyword: str | None = None,
    status: str | None = None,
    assignee: str | None = None,
    deadline_before: str | None = None,
    delayed_only: bool = False,
) -> dict:
    where = ["project_id = ?"]
    params: list = [ctx.project_id]

    if keyword:
        where.append("title LIKE ?")
        params.append(f"%{keyword}%")
    if status:
        where.append("status = ?")
        params.append(status)
    if assignee:
        where.append("assignee_id = ?")
        params.append(resolve_member(ctx, assignee))
    if deadline_before:
        where.append("deadline IS NOT NULL AND deadline < ?")
        params.append(deadline_before)
    if delayed_only:
        # '지금'은 가짜 시계(ctx.now)에서 온다. datetime.now()를 쓰지 않는다.
        where.append("deadline IS NOT NULL AND deadline < ? AND status != 'done'")
        params.append(ctx.today())

    rows = ctx.conn.execute(
        "SELECT * FROM task WHERE "
        + " AND ".join(where)
        + " ORDER BY deadline IS NULL, deadline, id LIMIT ?",
        (*params, _LIMIT),
    ).fetchall()
    return {"count": len(rows), "tasks": [task_view(ctx, r) for r in rows]}
