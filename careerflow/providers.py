from __future__ import annotations

import copy
import json
import os
from dataclasses import dataclass
from typing import Any, Protocol

from .prompts import SYSTEM_PROMPT
from .tools import TOOL_DEFINITIONS


@dataclass(frozen=True)
class ModelToolCall:
    call_id: str
    name: str
    arguments: dict[str, Any]


@dataclass(frozen=True)
class ModelTurn:
    text: str
    tool_calls: list[ModelToolCall]


@dataclass(frozen=True)
class ToolResult:
    call_id: str
    name: str
    output: dict[str, Any]


class ModelProvider(Protocol):
    def send_user(self, message: str) -> ModelTurn: ...

    def send_tool_results(self, results: list[ToolResult]) -> ModelTurn: ...


class OpenAIProvider:
    def __init__(self, model: str | None = None, client: Any | None = None) -> None:
        if client is None:
            from openai import OpenAI

            client = OpenAI()
        self.client = client
        self.model = model or os.getenv("OPENAI_MODEL", "gpt-5.6-terra")
        self.history: list[Any] = []

    def send_user(self, message: str) -> ModelTurn:
        self.history.append({"role": "user", "content": message})
        return self._create_response()

    def send_tool_results(self, results: list[ToolResult]) -> ModelTurn:
        self.history.extend(
            {
                "type": "function_call_output",
                "call_id": result.call_id,
                "output": json.dumps(result.output, ensure_ascii=False),
            }
            for result in results
        )
        return self._create_response()

    def _create_response(self) -> ModelTurn:
        response = self.client.responses.create(
            model=self.model,
            instructions=SYSTEM_PROMPT,
            input=self.history,
            tools=TOOL_DEFINITIONS,
        )
        self.history.extend(response.output)
        calls = [
            ModelToolCall(
                call_id=item.call_id,
                name=item.name,
                arguments=json.loads(item.arguments),
            )
            for item in response.output
            if item.type == "function_call"
        ]
        return ModelTurn(text=response.output_text or "", tool_calls=calls)


def _gemini_schema(schema: dict[str, Any]) -> dict[str, Any]:
    """OpenAI strict JSON Schema를 Gemini 지원 스키마 부분집합으로 변환한다."""
    converted = copy.deepcopy(schema)
    converted.pop("additionalProperties", None)

    schema_type = converted.get("type")
    if isinstance(schema_type, list) and "null" in schema_type:
        non_null_types = [item for item in schema_type if item != "null"]
        converted["type"] = non_null_types[0] if len(non_null_types) == 1 else non_null_types

    properties = converted.get("properties", {})
    nullable_properties: set[str] = set()
    for name, property_schema in list(properties.items()):
        if isinstance(property_schema.get("type"), list) and "null" in property_schema["type"]:
            nullable_properties.add(name)
        properties[name] = _gemini_schema(property_schema)

    if "items" in converted and isinstance(converted["items"], dict):
        converted["items"] = _gemini_schema(converted["items"])

    if nullable_properties and "required" in converted:
        converted["required"] = [
            name for name in converted["required"] if name not in nullable_properties
        ]
    return converted


def gemini_tool_definitions() -> list[dict[str, Any]]:
    tools = []
    for definition in TOOL_DEFINITIONS:
        tools.append({
            "type": "function",
            "name": definition["name"],
            "description": definition["description"],
            "parameters": _gemini_schema(definition["parameters"]),
        })
    return tools


class GeminiProvider:
    def __init__(self, model: str | None = None, client: Any | None = None) -> None:
        if client is None:
            from google import genai

            client = genai.Client(api_key=os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY"))
        self.client = client
        self.model = model or os.getenv("GEMINI_MODEL", "gemini-3.7-flash")
        self.tools = gemini_tool_definitions()
        self.history: list[dict[str, Any]] = []

    def send_user(self, message: str) -> ModelTurn:
        self.history.append({
            "type": "user_input",
            "content": [{"type": "text", "text": message}],
        })
        return self._create_interaction()

    def send_tool_results(self, results: list[ToolResult]) -> ModelTurn:
        function_results = [
            {
                "type": "function_result",
                "name": result.name,
                "call_id": result.call_id,
                "result": [{
                    "type": "text",
                    "text": json.dumps(result.output, ensure_ascii=False),
                }],
            }
            for result in results
        ]
        self.history.extend(function_results)
        return self._create_interaction()

    def _create_interaction(self) -> ModelTurn:
        arguments: dict[str, Any] = {
            "model": self.model,
            "input": copy.deepcopy(self.history),
            "system_instruction": SYSTEM_PROMPT,
            "tools": self.tools,
            "store": False,
        }

        interaction = self.client.interactions.create(**arguments)
        calls = []
        steps = interaction.steps or []
        for step in steps:
            if step.type != "function_call":
                continue
            raw_arguments = step.arguments or {}
            call_arguments = (
                json.loads(raw_arguments)
                if isinstance(raw_arguments, str)
                else dict(raw_arguments)
            )
            calls.append(ModelToolCall(
                call_id=str(step.id),
                name=step.name,
                arguments=call_arguments,
            ))
        self.history.extend(
            step.model_dump() if hasattr(step, "model_dump") else vars(step).copy()
            for step in steps
        )
        return ModelTurn(text=interaction.output_text or "", tool_calls=calls)


def create_provider(name: str, model: str | None = None, client: Any | None = None) -> ModelProvider:
    normalized = name.lower().strip()
    if normalized == "openai":
        return OpenAIProvider(model=model, client=client)
    if normalized == "gemini":
        return GeminiProvider(model=model, client=client)
    raise ValueError("지원하지 않는 provider입니다. openai 또는 gemini를 사용하세요.")
