"""이름 → ID 변환과 project_id 범위 검사.

Tool은 사람 이름 문자열을 받지만 DB는 ID를 저장한다. 변환은 **실행 계층**의 책임이다.
전달받은 ID를 그대로 믿지 않는다. 모든 조회·변경은 현재 project_id 범위 안에서만 한다.
"""
from __future__ import annotations

import sqlite3

from .registry import AMBIGUOUS, FORBIDDEN, NOT_FOUND, ToolContext, ToolError


def resolve_member(ctx: ToolContext, name: str) -> str:
    """팀원 이름 → member.id.

    1. 현재 project_id 안에서만 조회한다.
    2. 정확히 1명이면 ID로 변환한다.
    3. 0명이면 NOT_FOUND. **임의로 생성하지 않는다.**
    4. 2명 이상이면 AMBIGUOUS.
    부분 일치('현민' → '김현민')는 완전 일치가 하나도 없을 때만 시도한다.
    """
    key = name.strip()
    rows = ctx.conn.execute(
        "SELECT id, name FROM member WHERE project_id = ? AND name = ?",
        (ctx.project_id, key),
    ).fetchall()
    if not rows:
        rows = ctx.conn.execute(
            "SELECT id, name FROM member WHERE project_id = ? AND name LIKE ?",
            (ctx.project_id, f"%{key}%"),
        ).fetchall()
    if not rows:
        raise ToolError(NOT_FOUND, f"팀원을 찾을 수 없다: {name}", member=name)
    if len(rows) > 1:
        raise ToolError(
            AMBIGUOUS,
            f"이름이 여러 명과 일치한다: {name}",
            member=name,
            candidates=[r["name"] for r in rows],
        )
    return rows[0]["id"]


def _require_scoped(ctx: ToolContext, table: str, row_id: str, label: str) -> sqlite3.Row:
    row = ctx.conn.execute(f"SELECT * FROM {table} WHERE id = ?", (row_id,)).fetchone()
    if row is None:
        raise ToolError(NOT_FOUND, f"{label}을(를) 찾을 수 없다: {row_id}", id=row_id)
    if row["project_id"] != ctx.project_id:
        # 존재하지만 다른 프로젝트의 것. 승인과 권한은 별개 검사다.
        raise ToolError(FORBIDDEN, f"현재 프로젝트의 {label}이(가) 아니다: {row_id}", id=row_id)
    return row


def require_task(ctx: ToolContext, task_id: str) -> sqlite3.Row:
    return _require_scoped(ctx, "task", task_id, "업무")


def require_milestone(ctx: ToolContext, milestone_id: str) -> sqlite3.Row:
    return _require_scoped(ctx, "milestone", milestone_id, "마일스톤")


def member_name(ctx: ToolContext, member_id: str | None) -> str | None:
    if member_id is None:
        return None
    row = ctx.conn.execute("SELECT name FROM member WHERE id = ?", (member_id,)).fetchone()
    return row["name"] if row else None


def task_view(ctx: ToolContext, row: sqlite3.Row) -> dict:
    """Tool 응답용 업무 표현. 내부 ID(assignee_id)는 노출하지 않고 이름으로 돌려준다."""
    deps = [
        r["depends_on_id"]
        for r in ctx.conn.execute(
            "SELECT depends_on_id FROM task_dependency WHERE task_id = ? ORDER BY depends_on_id",
            (row["id"],),
        )
    ]
    return {
        "id": row["id"],
        "title": row["title"],
        "assignee": member_name(ctx, row["assignee_id"]),
        "status": row["status"],
        "deadline": row["deadline"],
        "effort_hours": row["effort_hours"],
        "milestone_id": row["milestone_id"],
        "depends_on": deps,
    }
