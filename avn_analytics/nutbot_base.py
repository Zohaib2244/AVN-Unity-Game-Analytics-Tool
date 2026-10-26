"""What NutBot's tool modules share: the error type, the argument schemas and the tool builder."""

from datetime import date


def _day(value, fallback):
    if not value:
        return fallback
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError as error:
        raise ToolError(f"“{value}” is not a date; use YYYY-MM-DD.") from error


class ToolError(Exception):
    """A problem the model can read and fix; reported as an error result, not a crash."""


FILTER_SCHEMA = {
    "type": "object",
    "description": "Optional narrowing: lists of values to keep.",
    "properties": {
        key: {"type": "array", "items": {"type": "string"}}
        for key in ("environments", "app_versions", "builds", "countries", "platforms")
    },
    "additionalProperties": False,
}
RANGE_PROPS = {
    "start": {
        "type": "string",
        "description": "First day, YYYY-MM-DD. Defaults to the dashboard's range.",
    },
    "end": {"type": "string", "description": "Last day (included), YYYY-MM-DD."},
    "filters": FILTER_SCHEMA,
    "include_test_data": {
        "type": "boolean",
        "description": "Include editor/development builds. Defaults to what the dashboard shows.",
    },
}
STEP_SCHEMA = {
    "type": "object",
    "properties": {
        "event": {"type": "string", "description": "Exact event name from list_events."},
        "param": {"type": "string", "description": "Optional parameter to test on that event."},
        "op": {
            "type": "string",
            "enum": ["eq", "ne", "gt", "gte", "lt", "lte", "contains", "exists"],
        },
        "value": {"type": "string"},
        "label": {"type": "string", "description": "A short plain-words name for the step."},
    },
    "required": ["event"],
    "additionalProperties": False,
}
STEPS = {"type": "array", "items": STEP_SCHEMA, "minItems": 2, "maxItems": 100}
GAME_ID = {
    "type": "string",
    "description": "Optional: another game you can see. Defaults to the open game.",
}


def _tool(name, description, properties, required=()):
    return {
        "name": name,
        "description": description,
        "inputSchema": {
            "type": "object",
            "properties": {"game_id": GAME_ID, **properties},
            "required": list(required),
            "additionalProperties": False,
        },
    }
