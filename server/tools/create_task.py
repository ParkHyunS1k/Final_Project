"""create_task — 새 업무 생성 (변경 Tool. 확인 카드 승인 후 실행)."""
from __future__ import annotations

from ._resolve import require_milestone, require_task, resolve_member, task_view
from .registry import INVALID_ARGUMENT, ToolContext, ToolError, tool

SCHEMA = {
    "name": "create_task",
    "description": (
        "새 업무를 생성한다. 담당자와 마감일을 함께 지정할 수 있다. "
        "일정(회의)이 아니라 '해야 할 일'을 만들 때 사용한다."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "title": {"type": "string", "minLength": 1, "maxLength": 200, "description": "업무 이름"},
            "assignee": {
                "type": "string",
                "maxLength": 50,
                "description": "담당자 이름. 미정이면 생략",
            },
            "deadline": {
                "type": "string",
                "format": "date",
                # 되묻기 정책(CLAUDE.md): 사용자가 마감을 언급하지 않았으면 생략한 채 생성한다.
                # 언급했는데 값을 확정할 수 없을 때만 clarify.
                "description": "YYYY-MM-DD. 사용자가 마감을 말하지 않았으면 생략한다",
            },
            "effort_hours": {
                "type": "number",
                "minimum": 0,
                "maximum": 200,
                "description": "예상 소요 시간(시간 단위)",
            },
            "depends_on": {
                "type": "array",
                "items": {"type": "string", "maxLength": 40},
                "maxItems": 20,
                "description": "선행 업무 id 목록",
            },
            "milestone_id": {"type": "string", "maxLength": 40},
        },
        "required": ["title"],
        "additionalProperties": False,
    },
}


@tool(SCHEMA, mutating=True)
def create_task(
    ctx: ToolContext,
    *,
    title: str,
    assignee: str | None = None,
    deadline: str | None = None,
    effort_hours: float | None = None,
    depends_on: list[str] | None = None,
    milestone_id: str | None = None,
) -> dict:
    assignee_id = resolve_member(ctx, assignee) if assignee else None
    if milestone_id:
        require_milestone(ctx, milestone_id)

    dep_ids: list[str] = []
    for dep in depends_on or []:
        require_task(ctx, dep)  # 다른 프로젝트 업무면 FORBIDDEN
        if dep not in dep_ids:
            dep_ids.append(dep)

    task_id = ctx.new_id("t")
    ctx.conn.execute(
        "INSERT INTO task"
        " (id, project_id, milestone_id, title, assignee_id, status, deadline, effort_hours, created_from)"
        " VALUES (?, ?, ?, ?, ?, 'todo', ?, ?, 'user')",
        (task_id, ctx.project_id, milestone_id, title.strip(), assignee_id, deadline, effort_hours),
    )
    for dep in dep_ids:
        if dep == task_id:
            raise ToolError(INVALID_ARGUMENT, "자기 자신을 선행 업무로 지정할 수 없다")
        ctx.conn.execute(
            "INSERT INTO task_dependency (task_id, depends_on_id) VALUES (?, ?)", (task_id, dep)
        )

    row = ctx.conn.execute("SELECT * FROM task WHERE id = ?", (task_id,)).fetchone()
    return task_view(ctx, row)
