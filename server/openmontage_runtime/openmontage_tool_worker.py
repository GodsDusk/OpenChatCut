"""Private bridge to the pinned OpenMontage Python tool implementation.

The POC keeps orchestration and prompts inside OpenChatCut, while loading the
already validated OpenMontage tool package from a server-owned source checkout.
For deployment this checkout belongs in the worker image; it is never exposed to
the browser.
"""

from __future__ import annotations

import dataclasses
import importlib
import inspect
import json
import os
import subprocess
import sys
from enum import Enum
from functools import lru_cache
from pathlib import Path
from typing import Any

PINNED_COMMIT = "b97ad70ff23f9415dc5998569d65959d15df357f"

TOOL_MODULES = {
    "transcriber": "tools.analysis.transcriber",
    "scene_detect": "tools.analysis.scene_detect",
    "audio_enhance": "tools.audio.audio_enhance",
    "frame_sampler": "tools.analysis.frame_sampler",
    "subtitle_gen": "tools.subtitle.subtitle_gen",
    "tts_selector": "tools.audio.tts_selector",
    "image_selector": "tools.graphics.image_selector",
    "video_selector": "tools.video.video_selector",
    "diagram_gen": "tools.graphics.diagram_gen",
    "code_snippet": "tools.graphics.code_snippet",
    "music_gen": "tools.audio.music_gen",
    "video_compose": "tools.video.video_compose",
    "hyperframes_compose": "tools.video.hyperframes_compose",
    "audio_mixer": "tools.audio.audio_mixer",
    "video_stitch": "tools.video.video_stitch",
    "video_trimmer": "tools.video.video_trimmer",
    "color_grade": "tools.enhancement.color_grade",
}


@lru_cache(maxsize=1)
def _source_root() -> Path:
    configured = os.getenv("OPENMONTAGE_SOURCE_ROOT", "").strip()
    if configured:
        root = Path(configured).expanduser().resolve()
    else:
        root = Path(__file__).resolve().parents[3] / "modify_motage_open"
    if not (root / "tools" / "base_tool.py").is_file():
        raise RuntimeError(
            "OpenMontage tool source is unavailable; set OPENMONTAGE_SOURCE_ROOT "
            "to the server-owned OpenMontage checkout"
        )
    expected = os.getenv("OPENMONTAGE_SOURCE_COMMIT", PINNED_COMMIT).strip()
    if expected:
        try:
            actual = subprocess.run(
                ["git", "-C", str(root), "rev-parse", "HEAD"],
                text=True,
                capture_output=True,
                timeout=10,
                check=True,
            ).stdout.strip()
        except (OSError, subprocess.SubprocessError) as exc:
            raise RuntimeError(f"cannot verify OpenMontage source revision: {exc}") from exc
        if actual != expected:
            raise RuntimeError(f"OpenMontage source revision mismatch: expected {expected}, got {actual}")
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))
    return root


@lru_cache(maxsize=None)
def _tool(name: str):
    if name not in TOOL_MODULES:
        raise RuntimeError(f"tool is not allowlisted: {name}")
    _source_root()
    from tools.base_tool import BaseTool

    module = importlib.import_module(TOOL_MODULES[name])
    for _, candidate in inspect.getmembers(module, inspect.isclass):
        if candidate is not BaseTool and issubclass(candidate, BaseTool) and candidate.__module__ == module.__name__:
            instance = candidate()
            if instance.name == name:
                return instance
    raise RuntimeError(f"OpenMontage tool implementation was not found: {name}")


def _jsonable(value: Any) -> Any:
    if dataclasses.is_dataclass(value):
        return _jsonable(dataclasses.asdict(value))
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, dict):
        return {str(key): _jsonable(child) for key, child in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_jsonable(child) for child in value]
    return value


def _describe(names: list[str]) -> dict[str, Any]:
    contracts: dict[str, Any] = {}
    for name in names:
        if name not in TOOL_MODULES:
            continue
        try:
            tool = _tool(name)
            info = tool.get_info()
            contracts[name] = {
                "status": str(info.get("status", "unavailable")),
                "description": inspect.getdoc(tool.__class__) or f"OpenMontage {name} tool",
                "input_schema": info.get("input_schema") or {"type": "object"},
            }
        except Exception as exc:
            contracts[name] = {"status": "unavailable", "error": str(exc)}
    return {"tools": contracts, "sourceCommit": PINNED_COMMIT}


def main() -> int:
    try:
        payload = json.loads(sys.stdin.read())
        if not isinstance(payload, dict):
            raise RuntimeError("worker request must be an object")
        if payload.get("action") == "describe":
            names = payload.get("tools", [])
            if not isinstance(names, list) or not all(isinstance(name, str) for name in names):
                raise RuntimeError("describe.tools must be a string array")
            result = _describe(names)
        else:
            name = payload.get("tool")
            arguments = payload.get("arguments", {})
            if not isinstance(name, str) or not isinstance(arguments, dict):
                raise RuntimeError("tool and object arguments are required")
            result = _jsonable(_tool(name).execute(arguments))
        sys.stdout.write(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception as exc:
        sys.stderr.write(str(exc))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
