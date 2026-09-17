"""get_member_tasks — 팀원의 업무와 업무량 (조회 Tool)."""
from __future__ import annotations

from ._resolve import resolve_member, task_view
from .registry import ToolContext, tool

SCHEMA = {
    "name": "get_member_tasks",
    "description": "특정 팀원에게 배정된 업무와 현재 업무량(총 예상 시간)을 반환한다.",
    "parameters": {
        "type": "object",
        "properties": {
            "member": {"type": "string", "maxLength": 50},
            "include_done": {"type": "boolean", "default": False},
        },
        "required": ["member"],
        "additionalProperties": False,
    },
}


@tool(SCHEMA, mutating=False)
def get_member_tasks(ctx: ToolContext, *, member: str, include_done: bool) -> dict:
    # include_done 기본값은 registry.apply_defaults가 채운다. 여기서 또 채우지 않는다.
    member_id = resolve_member(ctx, member)
    row = ctx.conn.execute(
        "SELECT name, role, weekly_hours FROM member WHERE id = ?", (member_id,)
    ).fetchone()

    sql = "SELECT * FROM task WHERE project_id = ? AND assignee_id = ?"
    if not include_done:
        sql += " AND status != 'done'"
    sql += " ORDER BY deadline IS NULL, deadline, id"
    tasks = ctx.conn.execute(sql, (ctx.project_id, member_id)).fetchall()

    open_hours = sum(
        (t["effort_hours"] or 0.0) for t in tasks if t["status"] != "done"
    )
    delayed = [
        t["id"]
        for t in tasks
        if t["deadline"] and t["deadline"] < ctx.today() and t["status"] != "done"
    ]
    return {
        "member": row["name"],
        "role": row["role"],
        "weekly_hours": row["weekly_hours"],
        "task_count": len(tasks),
        "open_effort_hours": round(open_hours, 2),
        "delayed_task_ids": delayed,
        "tasks": [task_view(ctx, t) for t in tasks],
    }
