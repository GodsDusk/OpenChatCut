from __future__ import annotations

import re
from pathlib import Path

from .contracts import StageDefinition
from .errors import ConfigurationError

RESOURCE_ROOT = Path(__file__).with_name("resources")
PIPELINE_PATH = RESOURCE_ROOT / "pipeline_defs" / "hybrid.yaml"
STAGE_ORDER = ("idea", "script", "scene_plan", "assets", "edit", "compose")

_LIST_FIELDS = {
    "produces",
    "required_artifacts_in",
    "optional_artifacts_in",
    "tools_available",
    "required_tools",
    "optional_tools",
    "review_focus",
    "success_criteria",
}


def _scalar(value: str):
    value = value.strip()
    if value == "true":
        return True
    if value == "false":
        return False
    if value == "[]":
        return []
    return value.strip('"\'')


def load_hybrid_stages(path: Path = PIPELINE_PATH) -> tuple[StageDefinition, ...]:
    """Parse the deliberately small stage subset of the pinned YAML without PyYAML."""
    text = path.read_text(encoding="utf-8")
    match = re.search(r"(?m)^stages:\s*$", text)
    if not match:
        raise ConfigurationError(f"invalid Hybrid manifest (missing stages): {path}")
    blocks = re.split(r"(?m)^  - name:\s*", text[match.end():])[1:]
    parsed: list[StageDefinition] = []
    for block in blocks:
        lines = block.splitlines()
        data: dict[str, object] = {"name": lines[0].strip()}
        active_list: str | None = None
        for line in lines[1:]:
            if re.match(r"^    [a-z_]+:", line):
                key, raw = line.strip().split(":", 1)
                active_list = key if key in _LIST_FIELDS else None
                if active_list:
                    data[key] = [] if not raw.strip() else _scalar(raw)
                else:
                    data[key] = _scalar(raw)
            elif active_list and re.match(r"^      - ", line):
                value = line.strip()[2:].strip().strip('"')
                cast = data.setdefault(active_list, [])
                if isinstance(cast, list):
                    cast.append(value)
        if data["name"] not in STAGE_ORDER:
            continue
        parsed.append(StageDefinition(
            name=str(data["name"]),
            skill=str(data.get("skill", "")),
            produces=tuple(data.get("produces", [])),
            required_artifacts_in=tuple(data.get("required_artifacts_in", [])),
            optional_artifacts_in=tuple(data.get("optional_artifacts_in", [])),
            tools_available=tuple(data.get("tools_available", [])),
            required_tools=tuple(data.get("required_tools", [])),
            checkpoint_required=bool(data.get("checkpoint_required", True)),
            human_approval_default=bool(data.get("human_approval_default", False)),
            review_focus=tuple(data.get("review_focus", [])),
            success_criteria=tuple(data.get("success_criteria", [])),
        ))
    if tuple(stage.name for stage in parsed) != STAGE_ORDER:
        raise ConfigurationError(
            f"pinned Hybrid manifest stage mismatch: expected {STAGE_ORDER}, "
            f"got {tuple(stage.name for stage in parsed)}"
        )
    return tuple(parsed)
