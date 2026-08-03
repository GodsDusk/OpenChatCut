from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any, Mapping

from .contracts import JsonObject, StageDefinition
from .manifest import RESOURCE_ROOT

TOOL_SKILLS = {
    "transcriber": ("speech-to-text",),
    "scene_detect": ("ffmpeg",),
    "audio_enhance": ("ffmpeg", "elevenlabs"),
    "frame_sampler": ("ffmpeg",),
    "subtitle_gen": ("remotion-best-practices",),
    "tts_selector": ("text-to-speech", "elevenlabs"),
    "image_selector": ("flux-best-practices", "bfl-api"),
    "video_selector": ("ai-video-gen", "create-video", "ltx2"),
    "diagram_gen": ("beautiful-mermaid", "d3-viz"),
    "music_gen": ("music", "sound-effects", "elevenlabs"),
    "video_compose": ("remotion-best-practices", "remotion", "ffmpeg"),
    "hyperframes_compose": ("ffmpeg",),
    "audio_mixer": ("ffmpeg", "video-toolkit"),
    "video_stitch": ("ffmpeg", "video-toolkit"),
    "video_trimmer": ("ffmpeg", "video-toolkit"),
    "color_grade": ("ffmpeg",),
}


@lru_cache(maxsize=None)
def _read(relative: str) -> str:
    return (RESOURCE_ROOT / relative).read_text(encoding="utf-8")


def _schemas(stage: StageDefinition) -> dict[str, Any]:
    return {
        name: json.loads(_read(f"schemas/artifacts/{name}.schema.json"))
        for name in stage.produces
    }


class PromptBuilder:
    def build(
        self,
        stage: StageDefinition,
        *,
        mode: str,
        user_message: str,
        assets: list[JsonObject],
        artifacts: Mapping[str, Any],
        workspace: str | None = None,
        tool_results: list[JsonObject] | None = None,
        review: JsonObject | None = None,
    ) -> list[JsonObject]:
        director_path = stage.skill + ".md"
        layer3_names = sorted({skill for tool in stage.tools_available for skill in TOOL_SKILLS.get(tool, ())})
        layer3 = []
        for name in layer3_names:
            path = RESOURCE_ROOT / ".agents" / "skills" / name / "SKILL.md"
            if path.is_file():
                layer3.append(f"## Layer 3: {name}\n{path.read_text(encoding='utf-8')}")
        system = "\n\n".join([
            _read("AGENT_GUIDE.md"),
            f"# Active Hybrid stage: {stage.name}\n" + _read(f"skills/{director_path}"),
            "# Reviewer contract\n" + _read("skills/meta/reviewer.md"),
            "# Checkpoint contract\n" + _read("skills/meta/checkpoint-protocol.md"),
            "\n\n".join(layer3),
            """# Server runtime response contract
Return one JSON object only. In produce/revise mode return
{"artifacts": {<required artifact names>: <schema-valid objects>},
 "tool_calls": [{"name": <allowed tool>, "arguments": {}}]}.
Use tool_calls only when a real registered tool is necessary. If tool results are present,
finish the artifacts using those results and return an empty tool_calls list.
In review mode return {"decision":"PASS"|"REVISE"|"PASS_WITH_WARNINGS",
"findings":[{"severity":"critical"|"suggestion"|"nitpick"|"investigation",
"description":"...","proposed_fix":"..."}]}. Every critical needs proposed_fix.""",
        ])
        payload = {
            "mode": mode,
            "stage": stage.name,
            "user_request": user_message,
            "source_assets": assets,
            "run_workspace": workspace,
            "prior_artifacts": artifacts,
            "required_outputs": list(stage.produces),
            "output_schemas": _schemas(stage),
            "stage_tools": list(stage.tools_available),
            "review_focus": list(stage.review_focus),
            "success_criteria": list(stage.success_criteria),
            "tool_results": tool_results or [],
            "prior_review": review,
        }
        return [
            {"role": "system", "content": system},
            {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
        ]
