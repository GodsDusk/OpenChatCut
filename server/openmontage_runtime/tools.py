from __future__ import annotations

import json
import shlex
import subprocess
import sys
from dataclasses import dataclass
from typing import Any, Mapping

from .contracts import ComposeAdapter, JsonObject, ToolExecutor
from .errors import ConfigurationError, RuntimeFailure, ToolPolicyError

GLOBAL_TOOL_ALLOWLIST = frozenset({
    "transcriber", "scene_detect", "audio_enhance", "frame_sampler",
    "subtitle_gen", "tts_selector", "image_selector", "video_selector",
    "diagram_gen", "code_snippet", "music_gen", "video_compose",
    "hyperframes_compose", "audio_mixer", "video_stitch", "video_trimmer",
    "color_grade",
})


@dataclass(frozen=True)
class ToolRegistration:
    executor: ToolExecutor
    description: str
    input_schema: JsonObject


class ToolRegistry:
    def __init__(self) -> None:
        self._tools: dict[str, ToolRegistration] = {}

    def register(
        self,
        name: str,
        executor: ToolExecutor,
        *,
        description: str = "Server-controlled OpenMontage tool",
        input_schema: JsonObject | None = None,
    ) -> None:
        if name not in GLOBAL_TOOL_ALLOWLIST:
            raise ToolPolicyError(f"tool '{name}' is not in the server allowlist")
        self._tools[name] = ToolRegistration(
            executor=executor,
            description=description,
            input_schema=input_schema or {"type": "object", "additionalProperties": True},
        )

    def has(self, name: str) -> bool:
        return name in self._tools

    def require(self, names: tuple[str, ...] | list[str]) -> None:
        missing = [name for name in names if name not in self._tools]
        if missing:
            raise ConfigurationError(
                "OpenMontage render/tool backend is not configured; missing executors: "
                + ", ".join(missing)
            )

    def schemas_for(self, allowed: tuple[str, ...]) -> list[JsonObject]:
        schemas: list[JsonObject] = []
        for name in allowed:
            registration = self._tools.get(name)
            if registration:
                schemas.append({
                    "type": "function",
                    "function": {
                        "name": name,
                        "description": registration.description,
                        "parameters": registration.input_schema,
                    },
                })
        return schemas

    def execute(
        self,
        name: str,
        arguments: Mapping[str, Any],
        context: Mapping[str, Any],
        *,
        stage_allowlist: tuple[str, ...],
    ) -> JsonObject:
        if name not in GLOBAL_TOOL_ALLOWLIST or name not in stage_allowlist:
            raise ToolPolicyError(f"stage '{context.get('stage')}' may not call tool '{name}'")
        registration = self._tools.get(name)
        if not registration:
            raise ConfigurationError(f"model requested unconfigured tool '{name}'")
        result = registration.executor(arguments, context)
        if not isinstance(result, dict):
            raise RuntimeFailure(f"tool '{name}' returned a non-object result")
        return result


class SubprocessToolAdapter(ComposeAdapter):
    """JSON stdin/stdout boundary to a separately sandboxed media worker."""

    def __init__(self, command: str | list[str], *, timeout_seconds: float = 900.0):
        self.command = shlex.split(command) if isinstance(command, str) else list(command)
        if not self.command:
            raise ConfigurationError("OpenMontage tool command is empty")
        self.timeout_seconds = timeout_seconds

    def execute(self, tool_name: str, arguments: Mapping[str, Any], context: Mapping[str, Any]) -> JsonObject:
        payload = json.dumps({
            "tool": tool_name,
            "arguments": dict(arguments),
            "context": dict(context),
        }, ensure_ascii=False)
        try:
            completed = subprocess.run(
                self.command,
                input=payload,
                text=True,
                capture_output=True,
                timeout=self.timeout_seconds,
                check=False,
                cwd=str(context["workspace"]),
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise RuntimeFailure(f"tool worker failed to launch for '{tool_name}': {exc}") from exc
        if completed.returncode != 0:
            raise RuntimeFailure(
                f"tool worker '{tool_name}' exited {completed.returncode}: {completed.stderr[-1000:]}"
            )
        try:
            result = json.loads(completed.stdout)
        except json.JSONDecodeError as exc:
            raise RuntimeFailure(f"tool worker '{tool_name}' returned invalid JSON") from exc
        if not isinstance(result, dict):
            raise RuntimeFailure(f"tool worker '{tool_name}' result must be an object")
        return result

    def describe(self, names: tuple[str, ...]) -> dict[str, JsonObject]:
        """Read real OpenMontage tool contracts from the private worker."""
        try:
            completed = subprocess.run(
                self.command,
                input=json.dumps({"action": "describe", "tools": list(names)}),
                text=True,
                capture_output=True,
                timeout=min(self.timeout_seconds, 120.0),
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise ConfigurationError(f"OpenMontage tool worker discovery failed: {exc}") from exc
        if completed.returncode != 0:
            raise ConfigurationError(
                "OpenMontage tool worker discovery failed: " + completed.stderr[-1000:]
            )
        try:
            result = json.loads(completed.stdout)
        except json.JSONDecodeError as exc:
            raise ConfigurationError("OpenMontage tool worker discovery returned invalid JSON") from exc
        tools = result.get("tools") if isinstance(result, dict) else None
        if not isinstance(tools, dict):
            raise ConfigurationError("OpenMontage tool worker discovery omitted tools")
        return {str(name): value for name, value in tools.items() if isinstance(value, dict)}

    def bind(self, registry: ToolRegistry, names: tuple[str, ...]) -> None:
        contracts = self.describe(names)
        for name in names:
            contract = contracts.get(name)
            if not contract or contract.get("status") != "available":
                continue
            schema = contract.get("input_schema")
            if not isinstance(schema, dict):
                schema = {"type": "object", "additionalProperties": True}
            registry.register(
                name,
                lambda arguments, context, tool_name=name: self.execute(tool_name, arguments, context),
                description=str(contract.get("description") or f"OpenMontage {name} tool"),
                input_schema=schema,
            )


def bundled_worker_command() -> list[str]:
    """Use the same interpreter for the bundled, server-only OpenMontage bridge."""
    return [sys.executable, "-m", "server.openmontage_runtime.openmontage_tool_worker"]
