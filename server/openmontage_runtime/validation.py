from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .errors import ArtifactValidationError
from .manifest import RESOURCE_ROOT


class SchemaValidator:
    def __init__(self, schema_root: Path | None = None):
        self.schema_root = schema_root or RESOURCE_ROOT / "schemas" / "artifacts"

    def validate(self, artifact_name: str, value: Any) -> None:
        path = self.schema_root / f"{artifact_name}.schema.json"
        if not path.is_file():
            raise ArtifactValidationError(f"no schema bundled for artifact '{artifact_name}'")
        schema = json.loads(path.read_text(encoding="utf-8"))
        errors: list[str] = []
        self._walk(schema, value, "$", errors)
        if errors:
            raise ArtifactValidationError(
                f"artifact '{artifact_name}' failed schema validation: " + "; ".join(errors[:8])
            )

    def validate_checkpoint(self, value: Any) -> None:
        path = RESOURCE_ROOT / "schemas" / "checkpoints" / "checkpoint.schema.json"
        schema = json.loads(path.read_text(encoding="utf-8"))
        errors: list[str] = []
        self._walk(schema, value, "$", errors)
        if errors:
            raise ArtifactValidationError(
                "checkpoint failed schema validation: " + "; ".join(errors[:8])
            )

    def _walk(self, schema: dict[str, Any], value: Any, path: str, errors: list[str]) -> None:
        alternatives = schema.get("oneOf")
        if isinstance(alternatives, list):
            matches = 0
            for alternative in alternatives:
                if not isinstance(alternative, dict):
                    continue
                branch_errors: list[str] = []
                self._walk(alternative, value, path, branch_errors)
                if not branch_errors:
                    matches += 1
            if matches != 1:
                errors.append(f"{path} must match exactly one allowed schema")
            return
        expected = schema.get("type")
        checks = {
            "object": lambda x: isinstance(x, dict),
            "array": lambda x: isinstance(x, list),
            "string": lambda x: isinstance(x, str),
            "number": lambda x: isinstance(x, (int, float)) and not isinstance(x, bool),
            "integer": lambda x: isinstance(x, int) and not isinstance(x, bool),
            "boolean": lambda x: isinstance(x, bool),
            "null": lambda x: x is None,
        }
        if expected in checks and not checks[expected](value):
            errors.append(f"{path} must be {expected}")
            return
        if "const" in schema and value != schema["const"]:
            errors.append(f"{path} must equal {schema['const']!r}")
        if "enum" in schema and value not in schema["enum"]:
            errors.append(f"{path} must be one of {schema['enum']!r}")
        if isinstance(value, str) and len(value) < schema.get("minLength", 0):
            errors.append(f"{path} is too short")
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            if "minimum" in schema and value < schema["minimum"]:
                errors.append(f"{path} is below minimum {schema['minimum']}")
            if "maximum" in schema and value > schema["maximum"]:
                errors.append(f"{path} exceeds maximum {schema['maximum']}")
        if isinstance(value, list):
            if len(value) < schema.get("minItems", 0):
                errors.append(f"{path} needs at least {schema['minItems']} items")
            item_schema = schema.get("items")
            if isinstance(item_schema, dict):
                for index, item in enumerate(value):
                    self._walk(item_schema, item, f"{path}[{index}]", errors)
        if isinstance(value, dict):
            for key in schema.get("required", []):
                if key not in value:
                    errors.append(f"{path}.{key} is required")
            properties = schema.get("properties", {})
            for key, item in value.items():
                if key in properties:
                    self._walk(properties[key], item, f"{path}.{key}", errors)
                elif schema.get("additionalProperties") is False:
                    errors.append(f"{path}.{key} is not allowed")
