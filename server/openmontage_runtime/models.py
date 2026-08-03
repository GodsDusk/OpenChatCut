from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any

from .contracts import JsonObject, ModelRequest
from .debug import runtime_debug
from .errors import ConfigurationError, RuntimeFailure


def _json_from_content(content: Any) -> JsonObject:
    if isinstance(content, dict):
        return content
    if not isinstance(content, str):
        raise RuntimeFailure("model response content is not a JSON object or string")
    candidate = content.strip()
    if not candidate:
        raise RuntimeFailure("model returned empty content; inspect model.message in the server debug log")
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
        runtime_debug(
            "model.request",
            {
                "endpoint": endpoint,
                "model": self.model,
                "mode": request.mode,
                "messages": list(request.messages),
                "tool_schemas": list(request.tool_schemas),
                "request_body": body,
            },
            workspace=request.workspace,
            run_id=request.run_id,
            stage=request.stage,
        )
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
                response_text = response.read().decode("utf-8", errors="replace")
                runtime_debug(
                    "model.http_response",
                    {"status": response.status, "headers": dict(response.headers.items()), "body": response_text},
                    workspace=request.workspace,
                    run_id=request.run_id,
                    stage=request.stage,
                )
                payload = json.loads(response_text)
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")[:1000]
            runtime_debug(
                "model.http_error",
                {"status": exc.code, "detail": detail},
                workspace=request.workspace,
                run_id=request.run_id,
                stage=request.stage,
            )
            raise RuntimeFailure(f"model HTTP {exc.code}: {detail}") from exc
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            runtime_debug(
                "model.transport_or_envelope_error",
                {"type": exc.__class__.__name__, "message": str(exc)},
                workspace=request.workspace,
                run_id=request.run_id,
                stage=request.stage,
            )
            raise RuntimeFailure(f"model request failed: {exc}") from exc
        try:
            message = payload["choices"][0]["message"]
            runtime_debug(
                "model.message",
                message,
                workspace=request.workspace,
                run_id=request.run_id,
                stage=request.stage,
            )
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
                result = {"tool_calls": normalized}
                runtime_debug(
                    "model.parsed_output", result,
                    workspace=request.workspace, run_id=request.run_id, stage=request.stage,
                )
                return result
            result = _json_from_content(message.get("content"))
            runtime_debug(
                "model.parsed_output", result,
                workspace=request.workspace, run_id=request.run_id, stage=request.stage,
            )
            return result
        except (RuntimeFailure, json.JSONDecodeError) as exc:
            runtime_debug(
                "model.parse_error",
                {"type": exc.__class__.__name__, "message": str(exc), "payload": payload},
                workspace=request.workspace,
                run_id=request.run_id,
                stage=request.stage,
            )
            if isinstance(exc, RuntimeFailure):
                raise
            raise RuntimeFailure(f"model tool call arguments are not valid JSON: {exc}") from exc
        except (KeyError, IndexError, TypeError) as exc:
            runtime_debug(
                "model.parse_error",
                {"type": exc.__class__.__name__, "message": str(exc), "payload": payload},
                workspace=request.workspace,
                run_id=request.run_id,
                stage=request.stage,
            )
            raise RuntimeFailure("model response is missing choices[0].message.content") from exc
