from __future__ import annotations

import json
import os
import re
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .contracts import EventSink, JsonObject, RunRequest
from .errors import RunConflictError, RunNotFoundError

_SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class FileRunStore:
    def __init__(self, event_sink: EventSink | None = None):
        self.event_sink = event_sink
        self._lock = threading.RLock()

    def _run_dir(self, workspace: str, run_id: str) -> Path:
        if not _SAFE_ID.fullmatch(run_id):
            raise RunConflictError("runId must be 1-128 safe identifier characters")
        root = Path(workspace).expanduser().resolve()
        return root / ".openmontage" / "runs" / run_id

    def create(self, request: RunRequest) -> JsonObject:
        run_dir = self._run_dir(request.workspace, request.run_id)
        with self._lock:
            if (run_dir / "state.json").exists():
                raise RunConflictError(f"run '{request.run_id}' already exists")
            run_dir.mkdir(parents=True, exist_ok=True)
            (run_dir / "checkpoints").mkdir(exist_ok=True)
            (run_dir / "artifacts").mkdir(exist_ok=True)
            state: JsonObject = {
                "version": "1.0",
                "runId": request.run_id,
                "projectId": request.project_id,
                "message": request.message,
                "workspace": str(Path(request.workspace).expanduser().resolve()),
                "assets": list(request.assets),
                "allowPlanningOnly": request.allow_planning_only,
                "status": "created",
                "currentStageIndex": 0,
                "artifacts": {},
                "eventSeq": 0,
                "cancelRequested": False,
                "createdAt": utc_now(),
                "updatedAt": utc_now(),
            }
            self.save(state)
            return state

    def load(self, workspace: str, run_id: str) -> JsonObject:
        path = self._run_dir(workspace, run_id) / "state.json"
        if not path.is_file():
            raise RunNotFoundError(f"run '{run_id}' was not found in workspace")
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise RunConflictError(f"run '{run_id}' has unreadable state: {exc}") from exc
        if not isinstance(value, dict):
            raise RunConflictError(f"run '{run_id}' state is not an object")
        return value

    def save(self, state: JsonObject) -> None:
        run_dir = self._run_dir(str(state["workspace"]), str(state["runId"]))
        run_dir.mkdir(parents=True, exist_ok=True)
        state["updatedAt"] = utc_now()
        self._atomic_json(run_dir / "state.json", state)

    def write_artifact(self, state: JsonObject, stage: str, name: str, value: Any) -> str:
        path = self._run_dir(str(state["workspace"]), str(state["runId"])) / "artifacts" / f"{stage}.{name}.json"
        self._atomic_json(path, value)
        return str(path)

    def write_checkpoint(self, state: JsonObject, stage: str, checkpoint: JsonObject) -> str:
        path = self._run_dir(str(state["workspace"]), str(state["runId"])) / "checkpoints" / f"{stage}.json"
        self._atomic_json(path, checkpoint)
        return str(path)

    def read_checkpoint(self, state: JsonObject, stage: str) -> JsonObject | None:
        path = self._run_dir(str(state["workspace"]), str(state["runId"])) / "checkpoints" / f"{stage}.json"
        if not path.is_file():
            return None
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else None

    def emit(self, state: JsonObject, event_type: str, **payload: Any) -> JsonObject:
        with self._lock:
            state["eventSeq"] = int(state.get("eventSeq", 0)) + 1
            event: JsonObject = {
                "runId": state["runId"],
                "seq": state["eventSeq"],
                "type": event_type,
                "timestamp": utc_now(),
                **payload,
            }
            path = self._run_dir(str(state["workspace"]), str(state["runId"])) / "events.jsonl"
            with path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(event, ensure_ascii=False) + "\n")
                handle.flush()
                os.fsync(handle.fileno())
            self.save(state)
        if self.event_sink:
            self.event_sink(event)
        return event

    def events(self, workspace: str, run_id: str, after_seq: int = 0) -> list[JsonObject]:
        path = self._run_dir(workspace, run_id) / "events.jsonl"
        if not path.is_file():
            self.load(workspace, run_id)
            return []
        result = []
        for line in path.read_text(encoding="utf-8").splitlines():
            item = json.loads(line)
            if int(item.get("seq", 0)) > after_seq:
                result.append(item)
        return result

    @staticmethod
    def _atomic_json(path: Path, value: Any) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
            temporary = Path(handle.name)
        temporary.replace(path)
