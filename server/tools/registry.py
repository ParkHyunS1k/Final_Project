"""Tool 레지스트리 · 인자 검증 · 실행 계층.

설계 규칙 (CLAUDE.md / docs/tools.md)
- Tool 1개 = 파일 1개. 스키마와 구현을 같은 파일에 둔다.
- Tool 함수는 순수하게 DB만 조작한다. 여기서 LLM을 부르지 않는다.
- JSON schema의 `default`는 문서용 annotation이다. 실제 적용은 **이 실행 계층**이 한다
  (apply_defaults). Tool 구현 본문에서 기본값을 또 채우지 않는다.
- 조회 Tool과 변경 Tool을 구분한다(mutating). 변경 Tool은 승인 뒤에 실행한다.
"""
from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any, Callable

# ── 공통 오류 코드 ────────────────────────────────────────────────
NOT_FOUND = "NOT_FOUND"
AMBIGUOUS = "AMBIGUOUS"
INVALID_STATE = "INVALID_STATE"
FORBIDDEN = "FORBIDDEN"
INVALID_ARGUMENT = "INVALID_ARGUMENT"  # 스키마 위반. 실행 계층 전용 코드


class ToolError(Exception):
    def __init__(self, code: str, message: str, **details: Any):
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details


# ── 실행 컨텍스트 ─────────────────────────────────────────────────
@dataclass
class ToolContext:
    """모든 Tool은 이 컨텍스트 범위 밖을 조회·변경할 수 없다.

    now: 가짜 시계. 평가·테스트에서는 항상 고정값(2026-09-08T09:00:00+09:00).
         Tool 안에서 datetime.now()를 부르지 않는다.
    """

    conn: Any
    project_id: str
    now: datetime

    def today(self) -> str:
        return self.now.date().isoformat()

    def new_id(self, prefix: str) -> str:
        return f"{prefix}_{uuid.uuid4().hex[:8]}"


@dataclass
class ToolResult:
    ok: bool
    result: Any = None
    error_type: str | None = None
    message: str | None = None
    details: dict = field(default_factory=dict)
    latency_ms: int = 0

    def as_dict(self) -> dict:
        if self.ok:
            return {"ok": True, "result": self.result}
        out = {"ok": False, "error_type": self.error_type, "message": self.message}
        if self.details:
            out["details"] = self.details
        return out


@dataclass
class ToolSpec:
    name: str
    schema: dict
    mutating: bool
    fn: Callable[..., Any]
    tier: int


REGISTRY: dict[str, ToolSpec] = {}


def tool(schema: dict, *, mutating: bool, tier: int = 1):
    """Tool 등록 데코레이터. schema는 function-calling 형식."""

    def deco(fn: Callable[..., Any]) -> Callable[..., Any]:
        name = schema["name"]
        if name in REGISTRY:
            raise RuntimeError(f"tool 이름 중복: {name}")
        _check_schema_hygiene(schema)
        REGISTRY[name] = ToolSpec(name, schema, mutating, fn, tier)
        return fn

    return deco


def get(name: str) -> ToolSpec:
    spec = REGISTRY.get(name)
    if spec is None:
        raise ToolError(NOT_FOUND, f"알 수 없는 tool: {name}", tool_name=name)
    return spec


def schemas(tier: int | None = None) -> list[dict]:
    return [s.schema for s in REGISTRY.values() if tier is None or s.tier == tier]


def _check_schema_hygiene(schema: dict) -> None:
    params = schema.get("parameters", {})
    if params.get("additionalProperties") is not False:
        raise RuntimeError(f"{schema['name']}: parameters에 additionalProperties: false 필요")


# ── 인자 검증 (의존성 없는 최소 JSON schema 부분집합) ──────────────
_TYPES: dict[str, tuple] = {
    "string": (str,),
    "number": (int, float),
    "integer": (int,),
    "boolean": (bool,),
    "array": (list,),
    "object": (dict,),
}


def _fail(msg: str, **d):
    raise ToolError(INVALID_ARGUMENT, msg, **d)


def _check_value(name: str, value: Any, spec: dict) -> None:
    t = spec.get("type")
    if t:
        # bool은 파이썬에서 int의 하위 타입이라 숫자 자리에 들어오면 안 된다.
        if t in ("number", "integer") and isinstance(value, bool):
            _fail(f"{name}: {t} 자리에 boolean", field=name)
        if not isinstance(value, _TYPES[t]):
            _fail(f"{name}: {t} 여야 하는데 {type(value).__name__}", field=name)
    if "enum" in spec and value not in spec["enum"]:
        _fail(f"{name}: 허용값 {spec['enum']} 중 하나여야 한다 (받은 값: {value!r})", field=name)
    if "minimum" in spec and value < spec["minimum"]:
        _fail(f"{name}: {spec['minimum']} 이상이어야 한다", field=name)
    if "maximum" in spec and value > spec["maximum"]:
        _fail(f"{name}: {spec['maximum']} 이하여야 한다", field=name)
    if isinstance(value, str):
        if "minLength" in spec and len(value) < spec["minLength"]:
            _fail(f"{name}: 비어 있을 수 없다", field=name)
        if "maxLength" in spec and len(value) > spec["maxLength"]:
            _fail(f"{name}: {spec['maxLength']}자 이하여야 한다", field=name)
        fmt = spec.get("format")
        if fmt == "date":
            parse_date(value, name)
        elif fmt == "date-time":
            parse_datetime(value, name)
    if isinstance(value, list):
        if "maxItems" in spec and len(value) > spec["maxItems"]:
            _fail(f"{name}: 원소 {spec['maxItems']}개 이하여야 한다", field=name)
        item_spec = spec.get("items")
        if item_spec:
            for i, item in enumerate(value):
                _check_value(f"{name}[{i}]", item, item_spec)


def parse_date(value: str, field_name: str = "date") -> date:
    """ISO 8601 date만 받는다. '다음 주 금요일' 같은 문자열은 여기서 오답이 된다."""
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except (ValueError, TypeError):
        _fail(f"{field_name}: YYYY-MM-DD 형식이어야 한다 (받은 값: {value!r})", field=field_name)


def parse_datetime(value: str, field_name: str = "datetime") -> datetime:
    try:
        return datetime.fromisoformat(value)
    except (ValueError, TypeError):
        _fail(f"{field_name}: ISO 8601 datetime 이어야 한다 (받은 값: {value!r})", field=field_name)


def validate_arguments(schema: dict, arguments: dict) -> dict:
    params = schema.get("parameters", {})
    props: dict = params.get("properties", {})
    if not isinstance(arguments, dict):
        _fail("arguments는 object여야 한다")
    unknown = set(arguments) - set(props)
    if unknown:
        _fail(f"허용되지 않은 인자: {sorted(unknown)}", fields=sorted(unknown))
    for req in params.get("required", []):
        if arguments.get(req) is None:
            _fail(f"필수 인자 누락: {req}", field=req)
    clean = {}
    for key, value in arguments.items():
        if value is None:  # 생략과 동일하게 취급
            continue
        _check_value(key, value, props[key])
        clean[key] = value
    return clean


def apply_defaults(schema: dict, arguments: dict) -> dict:
    """JSON schema의 default를 **실행 계층에서 명시적으로** 채운다."""
    props: dict = schema.get("parameters", {}).get("properties", {})
    filled = dict(arguments)
    for key, spec in props.items():
        if "default" in spec and key not in filled:
            filled[key] = spec["default"]
    return filled


# ── 실행 ─────────────────────────────────────────────────────────
def call(
    name: str, ctx: ToolContext, arguments: dict | None = None, *, commit: bool = True
) -> ToolResult:
    """검증 → 기본값 적용 → 실행. 예외는 ToolResult로 변환한다.

    commit=True  — 단독 호출(테스트·스크립트). 여기서 커밋·롤백을 끝낸다.
    commit=False — **agent 계층이 트랜잭션을 소유한다.** 승인 상태 갱신 → Tool 실행 →
                   tool_call_log 삽입이 한 트랜잭션이어야 "실행됐는데 로그가 없는 변경"이
                   생기지 않는다. 이때 실패해도 바깥 트랜잭션을 죽이지 않도록
                   SAVEPOINT로 이 호출분만 되돌린다.

    tool_call_log 기록은 agent 계층이 한다(model_id·A/B 그룹을 알아야 하므로).
    """
    started = time.perf_counter()
    savepoint = f"tool_{uuid.uuid4().hex[:8]}"
    if not commit:
        ctx.conn.execute(f"SAVEPOINT {savepoint}")
    try:
        spec = get(name)
        args = validate_arguments(spec.schema, arguments or {})
        args = apply_defaults(spec.schema, args)
        result = spec.fn(ctx, **args)
        if commit:
            ctx.conn.commit()
        else:
            ctx.conn.execute(f"RELEASE {savepoint}")
    except ToolError as e:
        if commit:
            ctx.conn.rollback()
        else:
            ctx.conn.execute(f"ROLLBACK TO {savepoint}")
            ctx.conn.execute(f"RELEASE {savepoint}")
        latency = int((time.perf_counter() - started) * 1000)
        return ToolResult(
            False,
            error_type=e.code,
            message=e.message,
            details=e.details,
            latency_ms=latency,
        )
    return ToolResult(True, result, latency_ms=int((time.perf_counter() - started) * 1000))
