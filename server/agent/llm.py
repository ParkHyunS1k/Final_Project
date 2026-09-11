"""LLM 클라이언트 — provider 중립 인터페이스.

전사용 Gemini 클라이언트(server/extract/vision.py)를 재사용하지 않는다. 그쪽은 전사 전용
프롬프트·멀티모달 body·전용 오류형을 갖고 있어서, 억지로 일반화하면 Stage 0 경계가 흐려진다.
공유하는 것은 설정(server/config)뿐이다.

구현 순서: FakeLLMClient(테스트) → GeminiAgentClient(현재) → VLLMClient(로컬 서빙).
셋 다 같은 GenerationRequest/GenerationResult를 쓰므로 상태머신은 바뀌지 않는다.
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Callable, Protocol

from .. import config

GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
DEFAULT_GEMINI_MODEL = "gemini-2.5-flash"


class LLMError(Exception):
    pass


@dataclass
class GenerationRequest:
    system: str
    user: str
    temperature: float = 0.0
    max_output_tokens: int = 2048
    # 주 실험은 structured output OFF다(docs/eval.md). ON은 별도 smoke 셀에서만 켠다.
    structured: bool = False

    def config_dict(self) -> dict:
        return {
            "temperature": self.temperature,
            "max_output_tokens": self.max_output_tokens,
            "structured": self.structured,
        }


@dataclass
class GenerationResult:
    text: str
    served_model: str
    finish_reason: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    latency_ms: int = 0
    model_revision: str | None = None
    # 429(쿼터) 때문에 다시 부른 횟수. 파싱 실패 재시도가 아니다 — 그건 하지 않는다.
    retry_count: int = 0


class LLMClient(Protocol):
    name: str          # requested_model 로 기록된다
    route: str         # 'local' | 'api'

    def generate(self, request: GenerationRequest) -> GenerationResult: ...


@dataclass
class FakeLLMClient:
    """테스트용. 미리 정한 응답을 순서대로 돌려준다. 네트워크를 타지 않는다."""

    responses: list[str] = field(default_factory=list)
    name: str = "fake"
    route: str = "local"
    calls: list[GenerationRequest] = field(default_factory=list)
    responder: Callable[[GenerationRequest], str] | None = None

    def generate(self, request: GenerationRequest) -> GenerationResult:
        self.calls.append(request)
        if self.responder is not None:
            text = self.responder(request)
        elif self.responses:
            text = self.responses.pop(0)
        else:
            raise LLMError("FakeLLMClient에 남은 응답이 없다")
        return GenerationResult(
            text=text,
            served_model=self.name,
            finish_reason="STOP",
            input_tokens=len(request.system) // 4,
            output_tokens=len(text) // 4,
            latency_ms=0,
        )


@dataclass
class GeminiAgentClient:
    """Gemini API 경로. 라우터의 폴백 경로이자 demo-api 프로필의 기본 경로다.

    주의: Gemini는 배관 검증과 상한선일 뿐, Qwen base→QLoRA 개선의 기준선이 아니다.
    """

    # .env의 GEMINI_MODEL로 바꿀 수 있다. 무료 티어는 모델마다 일일 한도가 다르다
    # (2.5-flash는 20회/일이라 파일럿 한 바퀴에 소진된다).
    model: str = field(default_factory=lambda: config.get("GEMINI_MODEL") or DEFAULT_GEMINI_MODEL)
    timeout: int = 60
    api_key: str | None = None
    route: str = "api"
    # 무료 티어는 분당 5회다. 쿼터 초과는 모델의 오답이 아니라 서빙 제약이므로 기다렸다 다시 부른다.
    # (파싱 실패 재시도와는 다른 것이다. 그쪽은 하지 않는다.)
    rate_limit_retries: int = 2
    rate_limit_wait: float = 22.0

    @property
    def name(self) -> str:
        return f"gemini:{self.model}"

    def _key(self) -> str:
        return self.api_key or config.require("GEMINI_API_KEY")

    def generate(self, request: GenerationRequest) -> GenerationResult:
        generation_config: dict = {
            "temperature": request.temperature,
            "maxOutputTokens": request.max_output_tokens,
            "responseMimeType": "application/json" if request.structured else "text/plain",
            "thinkingConfig": {"thinkingBudget": 0},
        }
        body = {
            "systemInstruction": {"parts": [{"text": request.system}]},
            "contents": [{"role": "user", "parts": [{"text": request.user}]}],
            "generationConfig": generation_config,
        }
        started = time.perf_counter()
        payload, retries = self._post_with_backoff(body)
        latency = int((time.perf_counter() - started) * 1000)

        candidates = payload.get("candidates") or []
        if not candidates:
            blocked = payload.get("promptFeedback", {}).get("blockReason")
            raise LLMError(f"응답에 candidate가 없다 (blockReason={blocked})")
        cand = candidates[0]
        parts = cand.get("content", {}).get("parts") or []
        usage = payload.get("usageMetadata", {})
        return GenerationResult(
            text="\n".join(p["text"] for p in parts if "text" in p).strip(),
            served_model=self.name,
            finish_reason=cand.get("finishReason"),
            input_tokens=usage.get("promptTokenCount"),
            output_tokens=usage.get("candidatesTokenCount"),
            latency_ms=latency,
            model_revision=payload.get("modelVersion"),
            retry_count=retries,
        )

    def _post_with_backoff(self, body: dict) -> tuple[dict, int]:
        for attempt in range(self.rate_limit_retries + 1):
            try:
                return self._post(body), attempt
            except LLMError as e:
                if "429" not in str(e) or attempt == self.rate_limit_retries:
                    raise
                time.sleep(self.rate_limit_wait)
        raise LLMError("도달할 수 없음")

    def _post(self, body: dict) -> dict:
        try:
            return self._request(body)
        except LLMError as e:
            if "thinkingConfig" in str(e) or "thinking_budget" in str(e):
                body["generationConfig"].pop("thinkingConfig", None)
                return self._request(body)
            raise

    def _request(self, body: dict) -> dict:
        req = urllib.request.Request(
            GEMINI_ENDPOINT.format(model=self.model),
            data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json", "x-goog-api-key": self._key()},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            raise LLMError(f"Gemini API {e.code}: {e.read().decode('utf-8', 'replace')[:400]}") from None
        except urllib.error.URLError as e:
            raise LLMError(f"Gemini API 연결 실패: {e.reason}") from None
