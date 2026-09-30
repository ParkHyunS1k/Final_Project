from __future__ import annotations

import json
from typing import Any

from .providers import ModelProvider, ToolResult, create_provider
from .tools import ToolRegistry


SENSITIVE_TRACE_KEYS = {"name", "resume_text", "resume_evidence", "posting_text"}


def redact_trace_data(value: Any) -> Any:
    """발표·디버그 로그에 개인 데이터 원문이 노출되지 않도록 마스킹한다."""
    if isinstance(value, dict):
        return {
            key: "[REDACTED]" if key in SENSITIVE_TRACE_KEYS else redact_trace_data(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [redact_trace_data(item) for item in value]
    return value


class CareerFlowAgent:
    def __init__(
        self,
        registry: ToolRegistry,
        model: str | None = None,
        client: Any | None = None,
        provider: str | ModelProvider = "openai",
    ) -> None:
        self.registry = registry
        self.provider = (
            create_provider(provider, model=model, client=client)
            if isinstance(provider, str)
            else provider
        )

    def run(self, user_message: str, *, trace: bool = False, max_rounds: int = 10) -> str:
        turn = self.provider.send_user(user_message)

        for _ in range(max_rounds):
            if not turn.tool_calls:
                return turn.text

            tool_results = []
            for call in turn.tool_calls:
                arguments = call.arguments
                if trace:
                    safe_arguments = redact_trace_data(arguments)
                    print(f"[tool] {call.name}({json.dumps(safe_arguments, ensure_ascii=False)})")
                result = self.registry.execute(call.name, arguments)
                if trace:
                    safe_result = redact_trace_data(result)
                    print(f"[result] {json.dumps(safe_result, ensure_ascii=False)}")
                tool_results.append(ToolResult(
                    call_id=call.call_id,
                    name=call.name,
                    output=result,
                ))

            turn = self.provider.send_tool_results(tool_results)

        if not turn.tool_calls:
            return turn.text
        raise RuntimeError("툴 호출 횟수 제한을 초과했습니다.")
