"""Events added to the AVN events standard from the website.

They live in the registry database, next to the built-in standard in `avn_events_standard/`, and are
merged into the spec, the guide and the downloads as the `custom` tier. The stored shape is the
one the editor uses (lists of states and parameters); `avn_events_standard.spec` turns it into the
spec format.
"""

import json
import re

from .models import timestamp

NAME = re.compile(r"[A-Z][A-Z0-9_]*")
STATE = re.compile(r"[A-Z][A-Za-z0-9]*")
KEY = re.compile(r"[A-Z][A-Z0-9_]*")
RESERVED_KEYS = {"STATE", "LEVEL_NUMBER"}
MAX_EVENTS = 100


class CustomEventError(ValueError):
    """The event breaks a naming rule of the standard; the message says which."""


def init(connection):
    connection.execute("""
        CREATE TABLE IF NOT EXISTS custom_events (
            name TEXT PRIMARY KEY,
            body TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
    """)


def validate(name, body, taken):
    """Check `name` and the editor-shaped `body` (a dict); return the body to store."""
    if not NAME.fullmatch(name) or len(name) > 40:
        raise CustomEventError(
            f"Event name {name!r} must be UPPER_SNAKE: capital letters, digits and _, "
            "starting with a letter (at most 40 characters)."
        )
    if name in taken:
        raise CustomEventError(f"{name} already exists in the standard.")
    seen_states = set()
    for state in body["states"]:
        label = state["name"]
        if not STATE.fullmatch(label) or len(label) > 40:
            raise CustomEventError(
                f"State {label!r} of {name} must be PascalCase: letters and digits, "
                "starting with a capital letter."
            )
        if label in seen_states:
            raise CustomEventError(f"{name} has the state {label} twice.")
        seen_states.add(label)
        seen_keys = set()
        for param in state["params"]:
            key = param["key"]
            if not KEY.fullmatch(key) or len(key) > 40:
                raise CustomEventError(
                    f"Parameter {key!r} of {name} {label} must be UPPER_SNAKE: capital letters, "
                    "digits and _, starting with a letter."
                )
            if key in RESERVED_KEYS:
                raise CustomEventError(f"{key} is added to every event already; remove it.")
            if key in seen_keys:
                raise CustomEventError(f"{name} {label} has the parameter {key} twice.")
            seen_keys.add(key)
            values = param["values"]
            if any(not value.strip() for value in values) or len(set(values)) != len(values):
                raise CustomEventError(
                    f"Values of {key} in {name} {label} must be unique and not empty."
                )
            if values and param["type"] != "string":
                raise CustomEventError(
                    f"{key} in {name} {label} has values, so its type must be string."
                )
    return body


def load(storage):
    """All custom events as {name: stored body}, oldest first."""
    with storage.connect(storage.root / "registry.sqlite3") as registry:
        init(registry)
        rows = registry.execute("SELECT name, body FROM custom_events ORDER BY created_at, name")
        return {row["name"]: json.loads(row["body"]) for row in rows}


def save(storage, name, body, builtin):
    with storage.connect(storage.root / "registry.sqlite3") as registry:
        init(registry)
        registry.execute("BEGIN IMMEDIATE")
        existing = {row["name"] for row in registry.execute("SELECT name FROM custom_events")}
        if name not in existing and len(existing) >= MAX_EVENTS:
            raise CustomEventError(f"At most {MAX_EVENTS} custom events.")
        validate(name, body, set(builtin))
        now = timestamp()
        registry.execute(
            "INSERT INTO custom_events (name, body, created_at, updated_at) VALUES (?, ?, ?, ?) "
            "ON CONFLICT(name) DO UPDATE SET body=excluded.body, updated_at=excluded.updated_at",
            (name, json.dumps(body, sort_keys=True), now, now),
        )


def delete(storage, name):
    with storage.connect(storage.root / "registry.sqlite3") as registry:
        init(registry)
        return registry.execute("DELETE FROM custom_events WHERE name=?", (name,)).rowcount > 0
