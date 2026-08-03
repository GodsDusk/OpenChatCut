from __future__ import annotations

import json
import sys
import traceback
from datetime import datetime, timezone
from typing import Any

from .service import build_default_service
from .debug import runtime_debug


def _write(value: Any) -> None:
    sys.stdout.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def main() -> int:
    try:
        line = sys.stdin.readline()
        if not line:
            raise ValueError("expected one JSON request line on stdin")
        payload = json.loads(line)
        if not isinstance(payload, dict):
            raise ValueError("request must be a JSON object")
        workspace = payload.get("workspace") if isinstance(payload.get("workspace"), str) else None
        run_id = payload.get("runId") if isinstance(payload.get("runId"), str) else None
        runtime_debug("runtime.request", payload, workspace=workspace, run_id=run_id)
        service = build_default_service(event_sink=_write)
        result = service.dispatch(payload)
        runtime_debug(
            "runtime.result",
            {"status": result.get("status") if isinstance(result, dict) else "events", "result": result},
            workspace=workspace,
            run_id=run_id,
        )
        if payload.get("action") in {"status", "events"}:
            _write({
                "runId": payload.get("runId"),
                "seq": 0,
                "type": "run.status" if payload.get("action") == "status" else "run.events",
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "data": result,
            })
        return 0
    except Exception as exc:
        run_id = None
        try:
            run_id = payload.get("runId")  # type: ignore[possibly-undefined]
        except Exception:
            pass
        debug_workspace = None
        try:
            debug_workspace = payload.get("workspace") if isinstance(payload.get("workspace"), str) else None  # type: ignore[possibly-undefined]
        except Exception:
            pass
        runtime_debug(
            "runtime.error",
            {"type": exc.__class__.__name__, "message": str(exc), "traceback": traceback.format_exc()},
            workspace=debug_workspace,
            run_id=run_id,
        )
        _write({
            "runId": run_id,
            "seq": 0,
            "type": "run.failed",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "error": {"code": exc.__class__.__name__, "message": str(exc)},
        })
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
