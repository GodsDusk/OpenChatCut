from __future__ import annotations

import json
import subprocess

from server.openmontage_runtime.tools import bundled_worker_command


def test_bundled_worker_starts_outside_project_directory(tmp_path):
    completed = subprocess.run(
        bundled_worker_command(),
        input=json.dumps({"action": "describe", "tools": []}),
        text=True,
        capture_output=True,
        cwd=tmp_path,
        timeout=10,
        check=False,
    )

    assert completed.returncode == 0, completed.stderr
    assert json.loads(completed.stdout)["tools"] == {}

