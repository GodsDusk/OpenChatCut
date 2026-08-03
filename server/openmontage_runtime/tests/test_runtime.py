from __future__ import annotations

from pathlib import Path

import pytest

from server.openmontage_runtime.contracts import ModelRequest, RunRequest
from server.openmontage_runtime.errors import ArtifactValidationError, ConfigurationError, ToolPolicyError
from server.openmontage_runtime.manifest import STAGE_ORDER, load_hybrid_stages
from server.openmontage_runtime.models import OpenAICompatibleModelClient
from server.openmontage_runtime.runner import HybridStageRunner
from server.openmontage_runtime.service import RuntimeService
from server.openmontage_runtime.storage import FileRunStore
from server.openmontage_runtime.tools import ToolRegistry
from server.openmontage_runtime.validation import SchemaValidator


class FakePromptBuilder:
    def build(self, *args, **kwargs):
        return [{"role": "user", "content": "fake"}]


class NoopValidator:
    def validate(self, name, value):
        return None

    def validate_checkpoint(self, value):
        return None


class FakeModel:
    def __init__(self, output_path: Path | None = None):
        self.output_path = output_path
        self.calls: list[tuple[str, str]] = []

    def preflight(self):
        return None

    def complete_json(self, request: ModelRequest):
        self.calls.append((request.stage, request.mode))
        if request.mode == "review":
            return {"decision": "PASS", "findings": []}
        values = {
            "idea": {"brief": {}, "decision_log": {}},
            "script": {"script": {}},
            "scene_plan": {"scene_plan": {}},
            "assets": {"asset_manifest": {}},
            "edit": {"edit_decisions": {}},
            "compose": {
                "render_report": {
                    "outputs": [{
                        "path": str(self.output_path),
                        "format": "mp4",
                        "resolution": "1920x1080",
                        "duration_seconds": 12,
                    }]
                },
                "final_review": {},
            },
        }
        return {"artifacts": values[request.stage], "tool_calls": []}


def make_service(tmp_path: Path, *, with_render_tools: bool = True):
    events = []
    store = FileRunStore(event_sink=events.append)
    tools = ToolRegistry()
    if with_render_tools:
        tools.register("video_compose", lambda arguments, context: {"ok": True})
        tools.register("audio_mixer", lambda arguments, context: {"ok": True})
    output = tmp_path / "renders" / "final.mp4"
    output.parent.mkdir(parents=True)
    output.write_bytes(b"fake mp4")
    runner = HybridStageRunner(
        FakeModel(output),
        tools,
        store,
        prompt_builder=FakePromptBuilder(),
        validator=NoopValidator(),
    )
    return RuntimeService(runner, store), events


def start_payload(tmp_path: Path, run_id: str = "run-1"):
    return {
        "action": "start",
        "runId": run_id,
        "projectId": "project-1",
        "message": "Make a source-led product video",
        "workspace": str(tmp_path),
        "assets": [],
    }


def test_pinned_manifest_has_poc_stage_order_and_gates():
    stages = load_hybrid_stages()
    assert tuple(stage.name for stage in stages) == STAGE_ORDER
    assert [stage.name for stage in stages if stage.human_approval_default] == [
        "idea", "script", "scene_plan"
    ]
    assert stages[-1].required_tools == ("video_compose", "audio_mixer")


def test_missing_model_configuration_is_explicit(monkeypatch):
    for key in (
        "OPENMONTAGE_MODEL_BASE_URL",
        "OPENMONTAGE_MODEL_API_KEY",
        "OPENMONTAGE_MODEL_NAME",
    ):
        monkeypatch.delenv(key, raising=False)
    with pytest.raises(ConfigurationError, match="missing OPENMONTAGE_MODEL_BASE_URL"):
        OpenAICompatibleModelClient.from_env()


def test_missing_render_backend_fails_before_creating_run(tmp_path):
    service, _ = make_service(tmp_path, with_render_tools=False)
    with pytest.raises(ConfigurationError, match="video_compose, audio_mixer"):
        service.start(start_payload(tmp_path))
    assert not (tmp_path / ".openmontage" / "runs" / "run-1").exists()


def test_run_checkpoints_approval_stages_then_completes(tmp_path):
    service, events = make_service(tmp_path)
    state = service.start(start_payload(tmp_path))
    assert state["status"] == "awaiting_approval"
    assert events[-1]["type"] == "stage.awaiting_approval"
    assert events[-1]["stage"] == "idea"

    state = service.approve({"runId": "run-1", "workspace": str(tmp_path), "stage": "idea"})
    assert state["status"] == "awaiting_approval"
    assert events[-1]["stage"] == "script"

    state = service.approve({"runId": "run-1", "workspace": str(tmp_path), "stage": "script"})
    assert state["status"] == "awaiting_approval"
    assert events[-1]["stage"] == "scene_plan"

    state = service.approve({"runId": "run-1", "workspace": str(tmp_path), "stage": "scene_plan"})
    assert state["status"] == "completed"
    assert state["output"] == {
        "kind": "video",
        "path": str((tmp_path / "renders" / "final.mp4").resolve()),
        "durationSeconds": 12,
        "width": 1920,
        "height": 1080,
    }
    assert events[-1]["type"] == "run.completed"
    assert (tmp_path / ".openmontage" / "runs" / "run-1" / "checkpoints" / "compose.json").is_file()


def test_cancel_is_persisted_and_idempotent(tmp_path):
    service, events = make_service(tmp_path)
    service.start(start_payload(tmp_path))
    state = service.cancel({"runId": "run-1", "workspace": str(tmp_path)})
    assert state["status"] == "cancelled"
    assert state["cancelRequested"] is True
    assert events[-1]["type"] == "run.cancelled"
    assert service.cancel({"runId": "run-1", "workspace": str(tmp_path)})["status"] == "cancelled"


def test_tool_registry_rejects_non_allowlisted_registration():
    with pytest.raises(ToolPolicyError, match="server allowlist"):
        ToolRegistry().register("shell", lambda arguments, context: {})


def test_bundled_brief_schema_is_enforced():
    validator = SchemaValidator()
    with pytest.raises(ArtifactValidationError, match="brief"):
        validator.validate("brief", {"version": "1.0"})
    validator.validate("brief", {
        "version": "1.0",
        "title": "A",
        "hook": "B",
        "key_points": ["C"],
        "tone": "clear",
        "style": "clean-professional",
        "target_platform": "generic",
        "target_duration_seconds": 30,
    })
