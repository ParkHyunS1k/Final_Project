"""model_invocation / action_proposal / tool_call_log 기록.

세 테이블의 역할이 다르다.
    model_invocation — 모델 호출 1회. Tool을 안 부른 턴(clarify/no_tool/파싱 실패)도 남는다.
    action_proposal  — 변경 Tool 제안 1건. 승인 전에도 pending으로 남는다.
    tool_call_log    — 실제로 실행된 Tool 1건.

**커밋하지 않는다.** 트랜잭션은 호출자(loop.Agent)가 소유한다.
"""
from __future__ import annotations

import json
from dataclasses import dataclass

from ..tools.registry import ToolContext, ToolResult


def _json(value) -> str:
    return json.dumps(value, ensure_ascii=False)


@dataclass
class RunMeta:
    """한 턴의 실행 조건. 전부 기록해야 나중에 조건별로 쪼개서 볼 수 있다."""

    trace_id: str
    session_id: str | None = None
    mode: str = "service"            # service | eval
    requested_model: str | None = None
    prompt_version: str | None = None
    prompt_hash: str | None = None
    toolset_version: str | None = None
    route: str | None = None         # local | api | fallback
    assigned_group: str | None = None
    route_reason: str | None = None


def log_invocation(
    ctx: ToolContext,
    meta: RunMeta,
    *,
    step_index: int,
    user_request: str,
    raw_output: str | None,
    decision: str,
    parsed: dict | None = None,
    parse_error: str | None = None,
    served_model: str | None = None,
    model_revision: str | None = None,
    generation_config: dict | None = None,
    finish_reason: str | None = None,
    input_tokens: int | None = None,
    output_tokens: int | None = None,
    latency_ms: int | None = None,
    retry_count: int = 0,
) -> str:
    invocation_id = ctx.new_id("inv")
    ctx.conn.execute(
        "INSERT INTO model_invocation ("
        " id, project_id, trace_id, session_id, step_index, mode, user_request, raw_output,"
        " decision, parsed, parse_error, requested_model, served_model, model_revision,"
        " prompt_version, prompt_hash, toolset_version, generation_config, route, assigned_group,"
        " finish_reason, input_tokens, output_tokens, latency_ms, retry_count, created_at)"
        " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (
            invocation_id, ctx.project_id, meta.trace_id, meta.session_id, step_index, meta.mode,
            user_request, raw_output, decision,
            _json(parsed) if parsed is not None else None, parse_error,
            meta.requested_model, served_model, model_revision,
            meta.prompt_version, meta.prompt_hash, meta.toolset_version,
            _json(generation_config) if generation_config else None,
            meta.route, meta.assigned_group,
            finish_reason, input_tokens, output_tokens, latency_ms, retry_count,
            ctx.now.isoformat(),
        ),
    )
    return invocation_id


def log_proposal(
    ctx: ToolContext,
    meta: RunMeta,
    *,
    invocation_id: str,
    step_index: int,
    user_request: str,
    tool_name: str,
    arguments: dict,
) -> str:
    """승인 대기 제안을 저장한다. decision은 'pending'."""
    proposal_id = ctx.new_id("ap")
    ctx.conn.execute(
        "INSERT INTO action_proposal ("
        " id, project_id, invocation_id, trace_id, step_index, user_request,"
        " proposed_tool_name, proposed_arguments, decision, model_id, prompt_version,"
        " toolset_version, assigned_group, route_reason, created_at)"
        " VALUES (?,?,?,?,?,?,?,?,'pending',?,?,?,?,?,?)",
        (
            proposal_id, ctx.project_id, invocation_id, meta.trace_id, step_index, user_request,
            tool_name, _json(arguments), meta.requested_model, meta.prompt_version,
            meta.toolset_version, meta.assigned_group, meta.route_reason, ctx.now.isoformat(),
        ),
    )
    return proposal_id


def settle_proposal(
    ctx: ToolContext, proposal_id: str, decision: str, approved_arguments: dict | None
) -> None:
    ctx.conn.execute(
        "UPDATE action_proposal SET decision = ?, approved_arguments = ?, decided_at = ?"
        " WHERE id = ? AND project_id = ?",
        (
            decision,
            _json(approved_arguments) if approved_arguments is not None else None,
            ctx.now.isoformat(),
            proposal_id,
            ctx.project_id,
        ),
    )


def log_tool_call(
    ctx: ToolContext,
    meta: RunMeta,
    *,
    invocation_id: str | None,
    proposal_id: str | None,
    user_request: str,
    tool_name: str,
    arguments: dict,
    result: ToolResult,
) -> str:
    log_id = ctx.new_id("tcl")
    ctx.conn.execute(
        "INSERT INTO tool_call_log ("
        " id, project_id, proposal_id, invocation_id, trace_id, session_id, user_request,"
        " tool_name, arguments, result, ok, error_type, latency_ms, model_id, assigned_group,"
        " route, created_at)"
        " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (
            log_id, ctx.project_id, proposal_id, invocation_id, meta.trace_id, meta.session_id,
            user_request, tool_name, _json(arguments),
            _json(result.result) if result.ok else _json(result.as_dict()),
            1 if result.ok else 0, result.error_type, result.latency_ms,
            meta.requested_model, meta.assigned_group, meta.route, ctx.now.isoformat(),
        ),
    )
    return log_id
