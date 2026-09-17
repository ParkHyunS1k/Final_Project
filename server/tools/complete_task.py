"""complete_task — 업무를 완료 상태로 (변경 Tool)."""
from __future__ import annotations

from ._resolve import require_task, task_view
from .registry import INVALID_STATE, ToolContext, ToolError, tool

SCHEMA = {
    "name": "complete_task",
    "description": "업무를 완료 상태로 바꾼다. 완료 외의 상태 변경은 update_task를 쓴다.",
    "parameters": {
        "type": "object",
        "properties": {"task_id": {"type": "string", "maxLength": 40}},
        "required": ["task_id"],
        "additionalProperties": False,
    },
}


@tool(SCHEMA, mutating=True)
def complete_task(ctx: ToolContext, *, task_id: str) -> dict:
    row = require_task(ctx, task_id)
    if row["status"] == "done":
        raise ToolError(INVALID_STATE, f"이미 완료된 업무다: {row['title']}", task_id=task_id)

    # 선행 업무가 남아 있어도 막지 않는다. 실제로 먼저 끝나는 경우가 있어서
    # 여기서 막으면 사용자가 우회 경로를 찾게 된다. 대신 경고로 돌려준다.
    open_deps = [
        {"id": r["id"], "title": r["title"], "status": r["status"]}
        for r in ctx.conn.execute(
            "SELECT t.id, t.title, t.status FROM task_dependency d"
            " JOIN task t ON t.id = d.depends_on_id"
            " WHERE d.task_id = ? AND t.status != 'done'",
            (task_id,),
        )
    ]

    ctx.conn.execute(
        "UPDATE task SET status = 'done' WHERE id = ? AND project_id = ?",
        (task_id, ctx.project_id),
    )
    updated = ctx.conn.execute("SELECT * FROM task WHERE id = ?", (task_id,)).fetchone()
    result = task_view(ctx, updated)
    if open_deps:
        result["warning"] = "미완료 선행 업무가 있다"
        result["open_dependencies"] = open_deps
    return result
