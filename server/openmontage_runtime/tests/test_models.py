from __future__ import annotations

import json
import urllib.request

from server.openmontage_runtime.contracts import ModelRequest
from server.openmontage_runtime.models import OpenAICompatibleModelClient


class FakeHttpResponse:
    status = 200
    headers: dict[str, str] = {}

    def __init__(self, payload: dict):
        self.body = json.dumps(payload, ensure_ascii=False).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def read(self):
        return self.body


def completion(content: str) -> FakeHttpResponse:
    return FakeHttpResponse({"choices": [{"message": {"content": content}}]})


def test_retries_plain_text_response_with_explicit_json_correction(monkeypatch, tmp_path):
    responses = iter([
        completion("我需要先检查这张图片。"),
        completion('{"artifacts":{"brief":{}},"tool_calls":[]}'),
    ])
    requests: list[urllib.request.Request] = []

    def fake_urlopen(request, timeout):
        requests.append(request)
        return next(responses)

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    client = OpenAICompatibleModelClient(
        base_url="https://model.example/v1",
        api_key="test-key",
        model="test-model",
    )

    result = client.complete_json(ModelRequest(
        stage="idea",
        mode="produce",
        messages=[{"role": "user", "content": "Return JSON"}],
        workspace=str(tmp_path),
    ))

    assert result == {"artifacts": {"brief": {}}, "tool_calls": []}
    assert len(requests) == 2
    retry_body = json.loads(requests[1].data)
    assert retry_body["response_format"] == {"type": "json_object"}
    assert "Return exactly one valid JSON object" in retry_body["messages"][-1]["content"]

