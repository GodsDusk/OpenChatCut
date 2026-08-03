from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .contracts import JsonObject, ModelClient, ModelRequest, RunRequest, StageDefinition
from .errors import ArtifactValidationError, ConfigurationError, RunConflictError, RuntimeFailure
from .manifest import load_hybrid_stages
from .prompts import PromptBuilder
from .storage import FileRunStore, utc_now
from .tools import ToolRegistry
from .validation import SchemaValidator


class HybridStageRunner:
    def __init__(
        self,
        model: ModelClient,
        tools: ToolRegistry,
        store: FileRunStore,
        *,
        prompt_builder: PromptBuilder | None = None,
        validator: SchemaValidator | None = None,
        max_tool_rounds: int = 4,
    ):
        self.model = model
        self.tools = tools
        self.store = store
        self.prompt_builder = prompt_builder or PromptBuilder()
        self.validator = validator or SchemaValidator()
        self.stages = load_hybrid_stages()
        self.max_tool_rounds = max_tool_rounds

    def start(self, request: RunRequest) -> JsonObject:
        self._preflight(request)
        state = self.store.create(request)
        state["status"] = "running"
        self.store.emit(state, "run.started", projectId=request.project_id, pipeline="hybrid")
        return self._run_until_blocked(state)

    def continue_run(self, state: JsonObject) -> JsonObject:
        if state.get("status") not in {"running", "created"}:
            raise RunConflictError(f"run cannot continue from status '{state.get('status')}'")
        state["status"] = "running"
        return self._run_until_blocked(state)

    def _preflight(self, request: RunRequest) -> None:
        preflight = getattr(self.model, "preflight", None)
        if callable(preflight):
            preflight()
        workspace = Path(request.workspace).expanduser().resolve()
        workspace.mkdir(parents=True, exist_ok=True)
        for asset in request.assets:
            path = asset.get("path")
            if not isinstance(path, str) or not Path(path).expanduser().is_file():
                raise ConfigurationError(
                    f"server-resolved asset '{asset.get('assetId', '<unknown>')}' has no readable file"
                )
        if not request.allow_planning_only:
            required = tuple(tool for stage in self.stages for tool in stage.required_tools)
            self.tools.require(required)

    def _run_until_blocked(self, state: JsonObject) -> JsonObject:
        try:
            while int(state["currentStageIndex"]) < len(self.stages):
                self._refresh_cancellation(state)
                if state.get("cancelRequested"):
                    state["status"] = "cancelled"
                    self.store.emit(state, "run.cancelled")
                    return state
                stage = self.stages[int(state["currentStageIndex"])]
                if stage.required_tools:
                    self.tools.require(stage.required_tools)
                self._run_stage(state, stage)
                if state["status"] == "awaiting_approval":
                    return state
                if state.get("allowPlanningOnly") and stage.name == "idea":
                    state["currentStageIndex"] = 1
                    state["status"] = "completed"
                    summary = self._planning_summary(state["artifacts"].get("brief", {}))
                    self.store.save(state)
                    self.store.emit(state, "run.completed", summary=summary, artifacts=state["artifacts"])
                    return state
                state["currentStageIndex"] = int(state["currentStageIndex"]) + 1
                self.store.save(state)
            output = self._compose_output(state)
            state["status"] = "completed"
            state["output"] = output
            self.store.emit(state, "run.completed", artifacts=state["artifacts"], output=output)
            return state
        except Exception as exc:
            state["status"] = "failed"
            state["error"] = str(exc)
            self.store.emit(
                state,
                "run.failed",
                error={"code": exc.__class__.__name__, "message": str(exc)},
            )
            raise

    def _run_stage(self, state: JsonObject, stage: StageDefinition) -> None:
        self._assert_inputs(state, stage)
        self.store.emit(state, "stage.started", stage=stage.name)
        artifacts = self._produce(state, stage, mode="produce")
        review: JsonObject = {}
        for round_number in (1, 2):
            review = self._review(state, stage, artifacts, round_number)
            critical = [item for item in review.get("findings", []) if item.get("severity") == "critical"]
            decision = str(review.get("decision", "PASS")).upper()
            self.store.emit(
                state,
                "stage.reviewed",
                stage=stage.name,
                round=round_number,
                decision=decision,
                findings=review.get("findings", []),
            )
            if not critical and decision != "REVISE":
                break
            if round_number == 2:
                review["decision"] = "PASS_WITH_WARNINGS"
                break
            artifacts = self._produce(state, stage, mode="revise", review=review)
        artifact_refs: JsonObject = {}
        for name, value in artifacts.items():
            artifact_refs[name] = self.store.write_artifact(state, stage.name, name, value)
            state["artifacts"][name] = value
        awaiting = stage.human_approval_default and not bool(state.get("allowPlanningOnly"))
        checkpoint: JsonObject = {
            "version": "1.0",
            "project_id": state["projectId"],
            "pipeline_type": "hybrid",
            "stage": stage.name,
            "status": "awaiting_human" if awaiting else "completed",
            "timestamp": utc_now(),
            "checkpoint_policy": "guided",
            "human_approval_required": awaiting,
            "human_approved": not awaiting,
            "artifacts": artifact_refs,
            "review": review,
            "metadata": {"source_commit": "b97ad70ff23f9415dc5998569d65959d15df357f"},
        }
        self.validator.validate_checkpoint(checkpoint)
        checkpoint_path = self.store.write_checkpoint(state, stage.name, checkpoint)
        if awaiting:
            state["status"] = "awaiting_approval"
            self.store.emit(
                state,
                "stage.awaiting_approval",
                stage=stage.name,
                artifacts={name: artifacts[name] for name in stage.produces},
                review=review,
                checkpointPath=checkpoint_path,
            )
        else:
            self.store.emit(
                state,
                "stage.completed",
                stage=stage.name,
                artifactRefs=artifact_refs,
                checkpointPath=checkpoint_path,
            )

    def _produce(
        self,
        state: JsonObject,
        stage: StageDefinition,
        *,
        mode: str,
        review: JsonObject | None = None,
    ) -> JsonObject:
        tool_results: list[JsonObject] = []
        for tool_round in range(self.max_tool_rounds + 1):
            messages = self.prompt_builder.build(
                stage,
                mode=mode,
                user_message=self._message_with_revision(state),
                assets=list(state.get("assets", [])),
                artifacts=state["artifacts"],
                workspace=str(state["workspace"]),
                tool_results=tool_results,
                review=review,
            )
            self.store.emit(state, "model.started", stage=stage.name, mode=mode, round=tool_round + 1)
            response = self.model.complete_json(ModelRequest(
                stage=stage.name,
                mode=mode,
                messages=messages,
                tool_schemas=self.tools.schemas_for(stage.tools_available),
            ))
            calls = response.get("tool_calls", [])
            if calls:
                if tool_round >= self.max_tool_rounds:
                    raise RuntimeFailure(f"stage '{stage.name}' exceeded maximum tool rounds")
                if not isinstance(calls, list):
                    raise RuntimeFailure("model tool_calls must be an array")
                for call in calls:
                    tool_results.append(self._execute_tool(state, stage, call))
                continue
            artifacts = response.get("artifacts")
            if not isinstance(artifacts, dict):
                raise ArtifactValidationError(f"stage '{stage.name}' returned no artifacts object")
            missing = [name for name in stage.produces if name not in artifacts]
            if missing:
                raise ArtifactValidationError(
                    f"stage '{stage.name}' omitted required artifacts: {', '.join(missing)}"
                )
            selected = {name: artifacts[name] for name in stage.produces}
            for name, value in selected.items():
                self.validator.validate(name, value)
            return selected
        raise RuntimeFailure(f"stage '{stage.name}' did not finish")

    def _review(
        self,
        state: JsonObject,
        stage: StageDefinition,
        artifacts: JsonObject,
        round_number: int,
    ) -> JsonObject:
        messages = self.prompt_builder.build(
            stage,
            mode="review",
            user_message=state["message"],
            assets=list(state.get("assets", [])),
            artifacts={**state["artifacts"], **artifacts},
            workspace=str(state["workspace"]),
        )
        self.store.emit(state, "model.started", stage=stage.name, mode="review", round=round_number)
        response = self.model.complete_json(ModelRequest(stage=stage.name, mode="review", messages=messages))
        if not isinstance(response.get("findings", []), list):
            raise RuntimeFailure("review findings must be an array")
        response.setdefault("decision", "PASS")
        for finding in response["findings"]:
            if finding.get("severity") == "critical" and not finding.get("proposed_fix"):
                finding["severity"] = "investigation"
        response["round"] = round_number
        return response

    def _execute_tool(self, state: JsonObject, stage: StageDefinition, call: Any) -> JsonObject:
        if not isinstance(call, dict) or not isinstance(call.get("name"), str):
            raise RuntimeFailure("each tool call must contain a string name")
        arguments = call.get("arguments", {})
        if not isinstance(arguments, dict):
            raise RuntimeFailure("tool call arguments must be an object")
        name = call["name"]
        self.store.emit(state, "tool.started", stage=stage.name, tool=name, arguments=arguments)
        result = self.tools.execute(
            name,
            arguments,
            {
                "runId": state["runId"],
                "projectId": state["projectId"],
                "workspace": state["workspace"],
                "stage": stage.name,
                "assets": state.get("assets", []),
            },
            stage_allowlist=stage.tools_available,
        )
        self.store.emit(state, "tool.completed", stage=stage.name, tool=name, result=result)
        return {"tool": name, "arguments": arguments, "result": result}

    def _assert_inputs(self, state: JsonObject, stage: StageDefinition) -> None:
        missing = [name for name in stage.required_artifacts_in if name not in state["artifacts"]]
        if missing:
            raise RuntimeFailure(f"stage '{stage.name}' missing prior artifacts: {', '.join(missing)}")

    def _refresh_cancellation(self, state: JsonObject) -> None:
        persisted = self.store.load(str(state["workspace"]), str(state["runId"]))
        state["cancelRequested"] = bool(persisted.get("cancelRequested"))

    @staticmethod
    def _message_with_revision(state: JsonObject) -> str:
        feedback = state.pop("revisionFeedback", None)
        if feedback:
            return f"{state['message']}\n\nHuman revision feedback: {feedback}"
        return str(state["message"])

    @staticmethod
    def _compose_output(state: JsonObject) -> JsonObject:
        report = state["artifacts"].get("render_report", {})
        outputs = report.get("outputs", []) if isinstance(report, dict) else []
        if not outputs or not isinstance(outputs[0], dict):
            raise RuntimeFailure("compose produced no render output")
        item = outputs[0]
        workspace = Path(str(state["workspace"])).resolve()
        output_path = Path(str(item.get("path", "")))
        output_path = output_path.resolve() if output_path.is_absolute() else (workspace / output_path).resolve()
        if not output_path.is_relative_to(workspace):
            raise RuntimeFailure("compose output must be inside the run workspace")
        if not output_path.is_file():
            raise RuntimeFailure(f"compose output does not exist: {output_path}")
        output: JsonObject = {
            "kind": "video",
            "path": str(output_path),
            "durationSeconds": item.get("duration_seconds"),
        }
        resolution = str(item.get("resolution", ""))
        if "x" in resolution:
            width, height = resolution.lower().split("x", 1)
            if width.isdigit() and height.isdigit():
                output.update({"width": int(width), "height": int(height)})
        return output

    @staticmethod
    def _planning_summary(brief: Any) -> str:
        if not isinstance(brief, dict):
            return "OpenMontage 已完成方案分析。"
        title = str(brief.get("title") or "OpenMontage 方案")
        hook = str(brief.get("hook") or "").strip()
        points = brief.get("key_points", [])
        point_text = "；".join(str(point) for point in points[:5]) if isinstance(points, list) else ""
        return "\n".join(part for part in (title, hook, point_text) if part)
