"""Server-only structured debug logging for the OpenMontage POC.

Stdout is reserved for the Runtime JSONL protocol. Debug records therefore go
to stderr and, when a workspace is known, to a per-run JSONL file.
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

_REDACTED_KEYS = ("authorization", "api_key", "apikey", "password", "secret", "token")


def debug_enabled() -> bool:
    value = os.getenv("OPENMONTAGE_DEBUG_LOG", "").strip().lower()
    return value in {"1", "true", "yes", "on", "debug"}


def _max_chars() -> int:
    raw = os.getenv("OPENMONTAGE_DEBUG_MAX_CHARS", "500000").strip()
    try:
        return min(max(int(raw), 10_000), 2_000_000)
    except ValueError:
        return 500_000


def _safe(value: Any, *, key: str = "") -> Any:
    normalized = key.lower().replace("-", "_")
    if any(marker in normalized for marker in _REDACTED_KEYS):
        return "[REDACTED]"
    if isinstance(value, str):
        limit = _max_chars()
        return value if len(value) <= limit else value[:limit] + f"…[truncated {len(value) - limit} chars]"
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, dict):
        return {str(child_key): _safe(child, key=str(child_key)) for child_key, child in value.items()}
    if isinstance(value, (list, tuple)):
        return [_safe(child) for child in value]
    return str(value)


def runtime_debug(
    kind: str,
    data: Any,
    *,
    workspace: str | None = None,
    run_id: str | None = None,
    stage: str | None = None,
) -> None:
    if not debug_enabled():
        return
    record = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "kind": kind,
        "pid": os.getpid(),
        "runId": run_id,
        "stage": stage,
        "data": _safe(data),
    }
    line = json.dumps(record, ensure_ascii=False, separators=(",", ":"))
    try:
        sys.stderr.write(f"[openmontage-debug][{kind}] {line}\n")
        sys.stderr.flush()
    except OSError:
        pass
    if not workspace:
        return
    try:
        log_dir = Path(workspace).expanduser().resolve() / ".openmontage"
        log_dir.mkdir(parents=True, exist_ok=True)
        with (log_dir / "runtime-debug.jsonl").open("a", encoding="utf-8") as handle:
            handle.write(line + "\n")
    except OSError:
        # Debug logging must never change the production result.
        pass
