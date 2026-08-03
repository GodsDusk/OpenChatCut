from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from typing import Any

from .service import build_default_service


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
        service = build_default_service(event_sink=_write)
        result = service.dispatch(payload)
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
