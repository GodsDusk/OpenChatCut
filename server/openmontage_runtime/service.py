from __future__ import annotations

import os
from typing import Any

from .contracts import EventSink, JsonObject, RunRequest
from .errors import RunConflictError
from .models import OpenAICompatibleModelClient
from .runner import HybridStageRunner
from .storage import FileRunStore
from .tools import SubprocessToolAdapter, ToolRegistry, bundled_worker_command


class RuntimeService:
    def __init__(self, runner: HybridStageRunner, store: FileRunStore):
        self.runner = runner
        self.store = store

    def start(self, payload: JsonObject) -> JsonObject:
        request = RunRequest(
            run_id=self._required(payload, "runId"),
            project_id=self._required(payload, "projectId"),
            message=self._required(payload, "message"),
            workspace=self._required(payload, "workspace"),
            assets=tuple(payload.get("assets", [])),
            allow_planning_only=bool(payload.get("allowPlanningOnly", False)),
        )
        return self.runner.start(request)

    def approve(self, payload: JsonObject) -> JsonObject:
        state = self._load(payload)
        if state.get("status") != "awaiting_approval":
            raise RunConflictError(f"run is not awaiting approval (status={state.get('status')})")
        stage = self.runner.stages[int(state["currentStageIndex"])]
        requested_stage = payload.get("stage")
        if requested_stage and requested_stage != stage.name:
            raise RunConflictError(f"run is awaiting approval for '{stage.name}', not '{requested_stage}'")
        checkpoint = self.store.read_checkpoint(state, stage.name)
        if not checkpoint:
            raise RunConflictError(f"missing checkpoint for stage '{stage.name}'")
        checkpoint["status"] = "completed"
        checkpoint["human_approved"] = True
        checkpoint.setdefault("metadata", {})["approval_feedback"] = payload.get("feedback")
        self.store.write_checkpoint(state, stage.name, checkpoint)
        self.store.emit(state, "stage.approved", stage=stage.name, feedback=payload.get("feedback"))
        state["currentStageIndex"] = int(state["currentStageIndex"]) + 1
        state["status"] = "running"
        self.store.save(state)
        return self.runner.continue_run(state)

    def revise(self, payload: JsonObject) -> JsonObject:
        state = self._load(payload)
        if state.get("status") != "awaiting_approval":
            raise RunConflictError(f"run is not awaiting revision (status={state.get('status')})")
        feedback = self._required(payload, "feedback")
        stage = self.runner.stages[int(state["currentStageIndex"])]
        for name in stage.produces:
            state["artifacts"].pop(name, None)
        state["revisionFeedback"] = feedback
        state["status"] = "running"
        self.store.emit(state, "stage.revision_requested", stage=stage.name, feedback=feedback)
        return self.runner.continue_run(state)

    def cancel(self, payload: JsonObject) -> JsonObject:
        state = self._load(payload)
        if state.get("status") in {"completed", "failed", "cancelled"}:
            return state
        state["cancelRequested"] = True
        state["status"] = "cancelled"
        self.store.emit(state, "run.cancelled", reason=payload.get("feedback"))
        return state

    def status(self, payload: JsonObject) -> JsonObject:
        return self._load(payload)

    def events(self, payload: JsonObject) -> list[JsonObject]:
        return self.store.events(
            self._required(payload, "workspace"),
            self._required(payload, "runId"),
            int(payload.get("afterSeq", 0)),
        )

    def dispatch(self, payload: JsonObject) -> JsonObject | list[JsonObject]:
        action = str(payload.get("action", "start"))
        handlers = {
            "start": self.start,
            "approve": self.approve,
            "revise": self.revise,
            "cancel": self.cancel,
            "status": self.status,
            "events": self.events,
        }
        if action not in handlers:
            raise RunConflictError(f"unknown runtime action '{action}'")
        return handlers[action](payload)

    def _load(self, payload: JsonObject) -> JsonObject:
        return self.store.load(
            self._required(payload, "workspace"),
            self._required(payload, "runId"),
        )

    @staticmethod
    def _required(payload: JsonObject, key: str) -> str:
        value = payload.get(key)
        if not isinstance(value, str) or not value.strip():
            raise RunConflictError(f"'{key}' is required")
        return value.strip()


def build_default_service(event_sink: EventSink | None = None) -> RuntimeService:
    model = OpenAICompatibleModelClient.from_env()
    store = FileRunStore(event_sink=event_sink)
    registry = ToolRegistry()
    command = os.getenv("OPENMONTAGE_TOOL_COMMAND", "").strip()
    adapter = SubprocessToolAdapter(command or bundled_worker_command())
    adapter.bind(registry, tuple(sorted({
        tool
        for stage in HybridStageRunner(model, registry, store).stages
        for tool in stage.tools_available
    })))
    runner = HybridStageRunner(model, registry, store)
    return RuntimeService(runner, store)
