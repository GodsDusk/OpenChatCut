from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any

from .contracts import JsonObject, ModelRequest
from .errors import ConfigurationError, RuntimeFailure


def _json_from_content(content: Any) -> JsonObject:
    if isinstance(content, dict):
        return content
    if not isinstance(content, str):
        raise RuntimeFailure("model response content is not a JSON object or string")
    candidate = content.strip()
    if candidate.startswith("```"):
        lines = candidate.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        candidate = "\n".join(lines).strip()
    try:
        value = json.loads(candidate)
    except json.JSONDecodeError as exc:
        raise RuntimeFailure(f"model did not return valid JSON: {exc}") from exc
    if not isinstance(value, dict):
        raise RuntimeFailure("model JSON response must be an object")
    return value


@dataclass
class OpenAICompatibleModelClient:
    base_url: str
    api_key: str
    model: str
    timeout_seconds: float = 120.0

    @classmethod
    def from_env(cls) -> "OpenAICompatibleModelClient":
        base_url = os.getenv("OPENMONTAGE_MODEL_BASE_URL", "").strip()
        api_key = os.getenv("OPENMONTAGE_MODEL_API_KEY", "").strip()
        model = os.getenv("OPENMONTAGE_MODEL_NAME", "").strip()
        missing = [
            name
            for name, value in (
                ("OPENMONTAGE_MODEL_BASE_URL", base_url),
                ("OPENMONTAGE_MODEL_API_KEY", api_key),
                ("OPENMONTAGE_MODEL_NAME", model),
            )
            if not value
        ]
        if missing:
            raise ConfigurationError(
                "OpenMontage model is not configured; missing " + ", ".join(missing)
            )
        return cls(base_url=base_url, api_key=api_key, model=model)

    def preflight(self) -> None:
        if not self.base_url or not self.api_key or not self.model:
            raise ConfigurationError("OpenMontage model client has empty base_url, api_key, or model")

    def complete_json(self, request: ModelRequest) -> JsonObject:
        self.preflight()
        endpoint = self.base_url.rstrip("/")
        if not endpoint.endswith("/chat/completions"):
            endpoint += "/chat/completions"
        body: JsonObject = {
            "model": self.model,
            "messages": list(request.messages),
            "response_format": {"type": "json_object"},
            "temperature": 0.2,
        }
        if request.tool_schemas:
            body["tools"] = list(request.tool_schemas)
        raw = json.dumps(body, ensure_ascii=False).encode("utf-8")
        http_request = urllib.request.Request(
            endpoint,
            data=raw,
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(http_request, timeout=self.timeout_seconds) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")[:1000]
            raise RuntimeFailure(f"model HTTP {exc.code}: {detail}") from exc
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            raise RuntimeFailure(f"model request failed: {exc}") from exc
        try:
            message = payload["choices"][0]["message"]
            tool_calls = message.get("tool_calls")
            if isinstance(tool_calls, list) and tool_calls:
                normalized = []
                for call in tool_calls:
                    function = call.get("function", {}) if isinstance(call, dict) else {}
                    name = function.get("name")
                    arguments = function.get("arguments", {})
                    if isinstance(arguments, str):
                        arguments = json.loads(arguments)
                    if not isinstance(name, str) or not isinstance(arguments, dict):
                        raise RuntimeFailure("model returned an invalid function tool call")
                    normalized.append({"name": name, "arguments": arguments})
                return {"tool_calls": normalized}
            return _json_from_content(message.get("content"))
        except (KeyError, IndexError, TypeError, json.JSONDecodeError) as exc:
            raise RuntimeFailure("model response is missing choices[0].message.content") from exc
