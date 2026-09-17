"""update_task — 기존 업무 수정 (변경 Tool).

canonical 규칙: 상태만 바꿀 때도 이 Tool을 쓴다(set_task_status는 쓰지 않는다).
단, '완료' 처리는 complete_task가 담당하므로 status enum에 done은 없다.
"""
from __future__ import annotations

from ._resolve import require_task, resolve_member, task_view
from .registry import INVALID_ARGUMENT, ToolContext, ToolError, tool

SCHEMA = {
    "name": "update_task",
    "description": (
        "기존 업무의 제목, 담당자, 마감일, 상태, 예상 공수를 수정한다. "
        "업무를 '완료' 처리할 때는 complete_task를 쓴다."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "task_id": {"type": "string", "maxLength": 40},
            "title": {"type": "string", "minLength": 1, "maxLength": 200},
            "assignee": {"type": "string", "maxLength": 50},
            "deadline": {"type": "string", "format": "date"},
            "status": {"type": "string", "enum": ["todo", "in_progress", "blocked"]},
            "effort_hours": {"type": "number", "minimum": 0, "maximum": 200},
        },
        "required": ["task_id"],
        "additionalProperties": False,
    },
}

_COLUMNS = {
    "title": "title",
    "deadline": "deadline",
    "status": "status",
    "effort_hours": "effort_hours",
}


@tool(SCHEMA, mutating=True)
def update_task(
    ctx: ToolContext,
    *,
    task_id: str,
    title: str | None = None,
    assignee: str | None = None,
    deadline: str | None = None,
    status: str | None = None,
    effort_hours: float | None = None,
) -> dict:
    require_task(ctx, task_id)

    changes: dict = {}
    for key, value in (
        ("title", title.strip() if title else None),
        ("deadline", deadline),
        ("status", status),
        ("effort_hours", effort_hours),
    ):
        if value is not None:
            changes[key] = value
    if assignee is not None:
        changes["assignee_id"] = resolve_member(ctx, assignee)

    if not changes:
        raise ToolError(INVALID_ARGUMENT, "수정할 필드가 하나도 없다", task_id=task_id)

    sets = ", ".join(f"{col} = ?" for col in changes)
    ctx.conn.execute(
        f"UPDATE task SET {sets} WHERE id = ? AND project_id = ?",
        (*changes.values(), task_id, ctx.project_id),
    )
    row = ctx.conn.execute("SELECT * FROM task WHERE id = ?", (task_id,)).fetchone()
    return {"updated_fields": sorted(changes), **task_view(ctx, row)}
