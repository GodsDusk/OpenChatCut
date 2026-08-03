class RuntimeFailure(RuntimeError):
    """Base error surfaced as a structured run.failed event."""


class ConfigurationError(RuntimeFailure):
    """The runtime cannot start because a required backend capability is missing."""


class RunNotFoundError(RuntimeFailure):
    """No persisted run exists for the requested identifier."""


class RunConflictError(RuntimeFailure):
    """The requested state transition is not valid for the current run."""


class ArtifactValidationError(RuntimeFailure):
    """A model-produced artifact does not satisfy its OpenMontage schema."""


class ToolPolicyError(RuntimeFailure):
    """A model attempted to call a tool outside the stage allowlist."""
