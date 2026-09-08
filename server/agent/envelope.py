"""Agent 출력 envelope 파서.

출력은 항상 **하나의 envelope**다. Tool 호출·되묻기·무호출을 다른 형태로 뱉지 않는다.
파서가 하나여야 "파싱 실패 = 오답" 규칙이 성립한다(docs/eval.md).

    {"decision":"tool_calls","calls":[{"name":"create_task","arguments":{...}}]}
    {"decision":"clarify","missing_fields":["deadline"],"question":"마감일이 언제인가요?"}
    {"decision":"no_tool","answer":"..."}

**자동 교정은 하지 않는다.** 유일한 예외는 코드펜스 제거이고, 이건 모든 조건(base/SFT/API)에
똑같이 적용되므로 비교를 깨지 않는다. JSON 앞뒤에 붙은 설명문을 긁어내는 식의 복구는 하지 않는다.
평가 중 재시도도 하지 않는다. 서비스 모드에서만 상위 계층이 1회 재시도한다.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field

TOOL_CALLS = "tool_calls"
CLARIFY = "clarify"
NO_TOOL = "no_tool"
PARSE_ERROR = "parse_error"

DECISIONS = (TOOL_CALLS, CLARIFY, NO_TOOL)
MAX_CALLS = 20

_FENCE = re.compile(r"^\s*```(?:json)?\s*(.*?)\s*```\s*$", re.S)


class EnvelopeError(Exception):
    """파싱·형태 검증 실패. 평가에서는 그대로 오답이다."""


@dataclass
class ToolCall:
    name: str
    arguments: dict

    def to_dict(self) -> dict:
        return {"name": self.name, "arguments": self.arguments}


@dataclass
class Envelope:
    decision: str
    calls: list[ToolCall] = field(default_factory=list)
    missing_fields: list[str] = field(default_factory=list)
    question: str | None = None
    answer: str | None = None
    raw: str = ""

    def to_dict(self) -> dict:
        if self.decision == TOOL_CALLS:
            return {"decision": self.decision, "calls": [c.to_dict() for c in self.calls]}
        if self.decision == CLARIFY:
            return {
                "decision": self.decision,
                "missing_fields": self.missing_fields,
                "question": self.question,
            }
        return {"decision": self.decision, "answer": self.answer}


def strip_fence(text: str) -> str:
    match = _FENCE.match(text)
    return match.group(1) if match else text.strip()


def parse_envelope(raw: str) -> Envelope:
    """모델 원문 → Envelope. 실패하면 EnvelopeError."""
    if not raw or not raw.strip():
        raise EnvelopeError("빈 출력")
    text = strip_fence(raw)
    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        raise EnvelopeError(f"JSON 파싱 실패: {e.msg} (pos {e.pos})") from None
    if not isinstance(data, dict):
        raise EnvelopeError(f"최상위가 object가 아니다: {type(data).__name__}")

    decision = data.get("decision")
    if decision not in DECISIONS:
        raise EnvelopeError(f"decision이 {list(DECISIONS)} 중 하나여야 한다 (받은 값: {decision!r})")

    if decision == TOOL_CALLS:
        return _parse_tool_calls(data, raw)
    if decision == CLARIFY:
        question = data.get("question")
        if not isinstance(question, str) or not question.strip():
            raise EnvelopeError("clarify에는 question이 필요하다")
        missing = data.get("missing_fields", [])
        if not isinstance(missing, list) or any(not isinstance(m, str) for m in missing):
            raise EnvelopeError("missing_fields는 문자열 배열이어야 한다")
        return Envelope(CLARIFY, missing_fields=missing, question=question.strip(), raw=raw)

    answer = data.get("answer")
    if not isinstance(answer, str) or not answer.strip():
        raise EnvelopeError("no_tool에는 answer가 필요하다")
    return Envelope(NO_TOOL, answer=answer.strip(), raw=raw)


def _parse_tool_calls(data: dict, raw: str) -> Envelope:
    calls = data.get("calls")
    if not isinstance(calls, list) or not calls:
        raise EnvelopeError("tool_calls에는 비어 있지 않은 calls 배열이 필요하다")
    if len(calls) > MAX_CALLS:
        raise EnvelopeError(f"calls가 너무 많다({len(calls)} > {MAX_CALLS})")
    parsed: list[ToolCall] = []
    for i, call in enumerate(calls):
        if not isinstance(call, dict):
            raise EnvelopeError(f"calls[{i}]가 object가 아니다")
        name = call.get("name")
        if not isinstance(name, str) or not name:
            raise EnvelopeError(f"calls[{i}].name이 없다")
        arguments = call.get("arguments", {})
        if not isinstance(arguments, dict):
            raise EnvelopeError(f"calls[{i}].arguments가 object가 아니다")
        parsed.append(ToolCall(name=name, arguments=arguments))
    return Envelope(TOOL_CALLS, calls=parsed, raw=raw)
