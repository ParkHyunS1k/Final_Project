"""Tool 패키지. 이 모듈을 import하면 모든 Tool이 레지스트리에 등록된다.

Tool 1개 = 파일 1개. 새 Tool을 추가하면 아래 import 목록에 한 줄 추가한다.
(자동 스캔을 쓰지 않는 이유: 등록 순서가 곧 모델에게 보여줄 스키마 순서이고,
 순서가 바뀌면 평가 조건이 달라진다.)
"""
from __future__ import annotations

from .registry import (  # noqa: F401
    AMBIGUOUS,
    FORBIDDEN,
    INVALID_ARGUMENT,
    INVALID_STATE,
    NOT_FOUND,
    REGISTRY,
    ToolContext,
    ToolError,
    ToolResult,
    call,
    get,
    schemas,
)

# ── Tier 1 Core ──────────────────────────────────────────────────
# 업무 (5)
from . import create_task as _create_task  # noqa: F401,E402
from . import update_task as _update_task  # noqa: F401,E402
from . import complete_task as _complete_task  # noqa: F401,E402
from . import search_tasks as _search_tasks  # noqa: F401,E402
from . import get_member_tasks as _get_member_tasks  # noqa: F401,E402

# 일정 (4) — 미구현: find_common_time, create_meeting, update_meeting, get_member_schedule
# 프로젝트·팀·문서 (3) — 미구현: get_team_members, get_project_status, search_documents

__all__ = [
    "REGISTRY",
    "ToolContext",
    "ToolError",
    "ToolResult",
    "call",
    "get",
    "schemas",
    "NOT_FOUND",
    "AMBIGUOUS",
    "INVALID_STATE",
    "FORBIDDEN",
    "INVALID_ARGUMENT",
]
