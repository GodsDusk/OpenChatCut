from __future__ import annotations

from typing import Callable

from .contracts import JsonObject
from .errors import RuntimeFailure
from .service import RuntimeService, build_default_service


def create_app(service_factory: Callable[[], RuntimeService] = build_default_service):
    """Create an optional FastAPI adapter without making FastAPI a runtime import requirement."""
    try:
        from fastapi import FastAPI, HTTPException
    except ImportError as exc:
        raise RuntimeError(
            "FastAPI adapter requested but fastapi is not installed; use the JSONL CLI or install fastapi"
        ) from exc

    app = FastAPI(title="OpenChatCut OpenMontage Hybrid Runtime", version="0.1.0")

    def invoke(action: str, payload: JsonObject):
        try:
            return service_factory().dispatch({**payload, "action": action})
        except RuntimeFailure as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.post("/runs")
    def start(payload: JsonObject):
        return invoke("start", payload)

    @app.post("/runs/{run_id}/actions")
    def action(run_id: str, payload: JsonObject):
        action_name = str(payload.get("action", ""))
        return invoke(action_name, {**payload, "runId": run_id})

    @app.get("/runs/{run_id}")
    def status(run_id: str, workspace: str):
        return invoke("status", {"runId": run_id, "workspace": workspace})

    @app.get("/runs/{run_id}/events")
    def events(run_id: str, workspace: str, after_seq: int = 0):
        return invoke("events", {"runId": run_id, "workspace": workspace, "afterSeq": after_seq})

    return app
