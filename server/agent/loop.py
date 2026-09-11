"""Agent 상태머신 (직접 구현. 프레임워크 없음).

    PLAN → RETRIEVE_TOOL → DECIDE
      ├ parse error → ERROR
      ├ clarify     → FINISH
      ├ no_tool     → FINISH
      └ tool_calls
          ├ 전부 조회 → EXECUTE → OBSERVE → REPLAN → FINISH
          └ 변경 포함 → PROPOSE → WAIT_APPROVAL   ← 턴이 여기서 끝난다
                          └ resume(...) → EXECUTE → OBSERVE → FINISH

**승인 대기에서 턴을 끝낸다.** run() 안에서 입력을 기다리지 않는다. 제안은 pending으로 저장되고
resume()이 별도 호출로 이어받는다. CLI에서는 차이가 없지만 웹에서는 요청이 끊겼다 이어진다.

**혼합 호출은 전부 승인 대상이다.** 조회만 먼저 실행하면 사용자가 거절해도 되돌릴 수 없다.

**트랜잭션은 여기가 소유한다.** Tool 실행과 로그 기록이 한 트랜잭션이어야
"실행됐는데 로그가 없는 변경"이 생기지 않는다.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field

from ..tools import registry
from ..tools.registry import ToolContext, ToolResult
from . import log as agent_log
from .envelope import (
    CLARIFY,
    NO_TOOL,
    PARSE_ERROR,
    TOOL_CALLS,
    Envelope,
    EnvelopeError,
    parse_envelope,
)
from .llm import GenerationRequest, LLMClient, LLMError
from .prompt import PROMPT_VERSION, TOOLSET_VERSION, build_prompt, prompt_hash

MAX_STEPS = 2  # multi-step 상한. 4B/8B에서 그 이상은 오류가 누적돼 신호가 사라진다.


@dataclass
class ProposedCall:
    proposal_id: str
    tool_name: str
    arguments: dict

    def to_dict(self) -> dict:
        return {
            "proposal_id": self.proposal_id,
            "tool_name": self.tool_name,
            "arguments": self.arguments,
        }


@dataclass
class AgentTurn:
    trace_id: str
    decision: str                       # tool_calls | clarify | no_tool | parse_error | awaiting_approval
    invocation_ids: list[str] = field(default_factory=list)
    proposals: list[ProposedCall] = field(default_factory=list)
    executed: list[tuple[str, ToolResult]] = field(default_factory=list)
    question: str | None = None
    missing_fields: list[str] = field(default_factory=list)
    answer: str | None = None
    error: str | None = None
    raw_outputs: list[str] = field(default_factory=list)

    @property
    def awaiting_approval(self) -> bool:
        return self.decision == "awaiting_approval"


class Agent:
    def __init__(
        self,
        ctx: ToolContext,
        client: LLMClient,
        *,
        mode: str = "service",
        session_id: str | None = None,
        assigned_group: str | None = None,
        max_steps: int = MAX_STEPS,
        structured: bool = False,
    ):
        self.ctx = ctx
        self.client = client
        self.mode = mode
        self.session_id = session_id
        self.assigned_group = assigned_group
        self.max_steps = max_steps
        self.structured = structured

    # ── PLAN → DECIDE ────────────────────────────────────
    def run(self, request: str, *, trace_id: str | None = None) -> AgentTurn:
        meta = self._meta(trace_id or f"tr_{uuid.uuid4().hex[:8]}")
        turn = AgentTurn(trace_id=meta.trace_id, decision=PARSE_ERROR)
        observations: str | None = None

        for step in range(self.max_steps):
            system, user = build_prompt(self.ctx, request, observations=observations)
            meta.prompt_hash = prompt_hash(system)
            gen_request = GenerationRequest(system=system, user=user, structured=self.structured)

            try:
                result = self.client.generate(gen_request)
            except LLMError as e:
                # 모델을 못 부른 것은 오답이 아니라 서빙 실패다. 구분해서 남긴다.
                turn.decision, turn.error = "error", str(e)
                turn.invocation_ids.append(
                    agent_log.log_invocation(
                        self.ctx, meta, step_index=step, user_request=request,
                        raw_output=None, decision="error", parse_error=str(e),
                        generation_config=gen_request.config_dict(),
                    )
                )
                self.ctx.conn.commit()
                return turn

            turn.raw_outputs.append(result.text)
            try:
                envelope = parse_envelope(result.text)
                parse_error = None
            except EnvelopeError as e:
                envelope, parse_error = None, str(e)

            invocation_id = agent_log.log_invocation(
                self.ctx, meta,
                step_index=step,
                user_request=request,
                raw_output=result.text,
                decision=envelope.decision if envelope else PARSE_ERROR,
                parsed=envelope.to_dict() if envelope else None,
                parse_error=parse_error,
                served_model=result.served_model,
                model_revision=result.model_revision,
                generation_config=gen_request.config_dict(),
                finish_reason=result.finish_reason,
                input_tokens=result.input_tokens,
                output_tokens=result.output_tokens,
                latency_ms=result.latency_ms,
                retry_count=result.retry_count,
            )
            turn.invocation_ids.append(invocation_id)

            if envelope is None:
                # 평가 모드에서는 재시도하지 않는다. 조건 간 비교가 불가능해진다.
                turn.decision, turn.error = PARSE_ERROR, parse_error
                self.ctx.conn.commit()
                return turn

            if envelope.decision == CLARIFY:
                turn.decision = CLARIFY
                turn.question, turn.missing_fields = envelope.question, envelope.missing_fields
                self.ctx.conn.commit()
                return turn

            if envelope.decision == NO_TOOL:
                turn.decision, turn.answer = NO_TOOL, envelope.answer
                self.ctx.conn.commit()
                return turn

            if self._has_mutation(envelope):
                self._propose(turn, meta, invocation_id, step, request, envelope)
                self.ctx.conn.commit()
                return turn

            observations = self._execute_reads(turn, meta, invocation_id, request, envelope)
            self.ctx.conn.commit()

        turn.decision = TOOL_CALLS
        return turn

    # ── resume(승인 이후) ─────────────────────────────────
    def resume(
        self,
        proposal_id: str,
        decision: str,
        *,
        edited_arguments: dict | None = None,
        trace_id: str | None = None,
    ) -> AgentTurn:
        """승인/수정/거절을 받아 실행한다. 제안 1건 = 이 호출 1번."""
        row = self.ctx.conn.execute(
            "SELECT * FROM action_proposal WHERE id = ? AND project_id = ?",
            (proposal_id, self.ctx.project_id),
        ).fetchone()
        if row is None:
            raise ValueError(f"제안을 찾을 수 없다: {proposal_id}")
        if row["decision"] != "pending":
            raise ValueError(f"이미 처리된 제안이다: {proposal_id} ({row['decision']})")

        import json

        meta = self._meta(trace_id or row["trace_id"])
        turn = AgentTurn(trace_id=meta.trace_id, decision=decision)
        original = json.loads(row["proposed_arguments"])
        arguments = edited_arguments if decision == "edited" else original

        if decision == "rejected":
            agent_log.settle_proposal(self.ctx, proposal_id, "rejected", None)
            self.ctx.conn.commit()
            return turn

        # 승인 상태 갱신 → Tool 실행 → 로그 기록이 한 트랜잭션이다.
        agent_log.settle_proposal(self.ctx, proposal_id, decision, arguments)
        result = registry.call(row["proposed_tool_name"], self.ctx, arguments, commit=False)
        agent_log.log_tool_call(
            self.ctx, meta,
            invocation_id=row["invocation_id"],
            proposal_id=proposal_id,
            user_request=row["user_request"] or "",
            tool_name=row["proposed_tool_name"],
            arguments=arguments,
            result=result,
        )
        self.ctx.conn.commit()
        turn.executed.append((row["proposed_tool_name"], result))
        return turn

    # ── 내부 ─────────────────────────────────────────────
    def _meta(self, trace_id: str) -> agent_log.RunMeta:
        return agent_log.RunMeta(
            trace_id=trace_id,
            session_id=self.session_id,
            mode=self.mode,
            requested_model=self.client.name,
            prompt_version=PROMPT_VERSION,
            toolset_version=TOOLSET_VERSION,
            route=self.client.route,
            assigned_group=self.assigned_group,
            route_reason=self.client.route,
        )

    def _has_mutation(self, envelope: Envelope) -> bool:
        for call in envelope.calls:
            spec = registry.REGISTRY.get(call.name)
            # 없는 Tool은 실행 계층이 NOT_FOUND로 처리한다. 조회로 취급해 바로 실행시킨다.
            if spec is not None and spec.mutating:
                return True
        return False

    def _propose(self, turn, meta, invocation_id, step, request, envelope) -> None:
        turn.decision = "awaiting_approval"
        for call in envelope.calls:
            proposal_id = agent_log.log_proposal(
                self.ctx, meta,
                invocation_id=invocation_id,
                step_index=step,
                user_request=request,
                tool_name=call.name,
                arguments=call.arguments,
            )
            turn.proposals.append(ProposedCall(proposal_id, call.name, call.arguments))

    def _execute_reads(self, turn, meta, invocation_id, request, envelope) -> str:
        lines = []
        for call in envelope.calls:
            result = registry.call(call.name, self.ctx, call.arguments, commit=False)
            agent_log.log_tool_call(
                self.ctx, meta,
                invocation_id=invocation_id,
                proposal_id=None,
                user_request=request,
                tool_name=call.name,
                arguments=call.arguments,
                result=result,
            )
            turn.executed.append((call.name, result))
            import json

            lines.append(f"{call.name} → {json.dumps(result.as_dict(), ensure_ascii=False)[:800]}")
        return "\n".join(lines)
