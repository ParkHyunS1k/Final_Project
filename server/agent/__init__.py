"""Agent 계층 — 프롬프트 · envelope 파서 · 상태머신 · 로깅.

평가 하네스와 서비스가 **같은 build_prompt / parse_envelope를 쓴다.** 갈라지면
하네스가 재는 시스템과 사용자가 쓰는 시스템이 달라진다.
"""
from .envelope import (
    CLARIFY,
    NO_TOOL,
    PARSE_ERROR,
    TOOL_CALLS,
    Envelope,
    EnvelopeError,
    ToolCall,
    parse_envelope,
)
from .llm import (
    FakeLLMClient,
    GeminiAgentClient,
    GenerationRequest,
    GenerationResult,
    LLMClient,
    LLMError,
)
from .log import RunMeta
from .loop import MAX_STEPS, Agent, AgentTurn, ProposedCall
from .prompt import PROMPT_VERSION, TOOLSET_VERSION, build_prompt, build_system_prompt, prompt_hash

__all__ = [
    "Agent",
    "AgentTurn",
    "ProposedCall",
    "MAX_STEPS",
    "Envelope",
    "EnvelopeError",
    "ToolCall",
    "parse_envelope",
    "TOOL_CALLS",
    "CLARIFY",
    "NO_TOOL",
    "PARSE_ERROR",
    "LLMClient",
    "LLMError",
    "FakeLLMClient",
    "GeminiAgentClient",
    "GenerationRequest",
    "GenerationResult",
    "RunMeta",
    "build_prompt",
    "build_system_prompt",
    "prompt_hash",
    "PROMPT_VERSION",
    "TOOLSET_VERSION",
]
