from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Mapping, Protocol, Sequence

JsonObject = dict[str, Any]
EventSink = Callable[[JsonObject], None]


@dataclass(frozen=True)
class StageDefinition:
    name: str
    skill: str
    produces: tuple[str, ...]
    required_artifacts_in: tuple[str, ...] = ()
    optional_artifacts_in: tuple[str, ...] = ()
    tools_available: tuple[str, ...] = ()
    required_tools: tuple[str, ...] = ()
    checkpoint_required: bool = True
    human_approval_default: bool = False
    review_focus: tuple[str, ...] = ()
    success_criteria: tuple[str, ...] = ()


@dataclass(frozen=True)
class RunRequest:
    run_id: str
    project_id: str
    message: str
    workspace: str
    assets: tuple[JsonObject, ...] = ()
    allow_planning_only: bool = False


@dataclass(frozen=True)
class ModelRequest:
    stage: str
    mode: str
    messages: Sequence[JsonObject]
    tool_schemas: Sequence[JsonObject] = field(default_factory=tuple)


class ModelClient(Protocol):
    def complete_json(self, request: ModelRequest) -> JsonObject: ...


class ToolExecutor(Protocol):
    def __call__(self, arguments: Mapping[str, Any], context: Mapping[str, Any]) -> JsonObject: ...


class ComposeAdapter(Protocol):
    """Boundary to the real media/render worker; the model never invokes a shell."""

    def execute(self, tool_name: str, arguments: Mapping[str, Any], context: Mapping[str, Any]) -> JsonObject: ...
