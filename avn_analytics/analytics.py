"""Analytics facts: the plain values every dashboard count needs, stored once per event.

Each game's database keeps its raw events exactly as they arrived (`events`, the whole envelope
as JSON in `payload`). Reading a value out of that JSON for every event on every page is what
made the dashboards slow, so this module keeps derived tables next to the events. They are only
ever rebuilt from the events, never the other way round, and nothing here changes an event:

- analytics_facts: one row per event with the values the dashboards read (who, which session,
  version, build, country, platform, the environment the event declared, its parameters). A
  trigger on `events` writes the row in the same transaction as the event, so every event stored
  from now on has its facts, whichever version of the app stored it. Events stored before the
  trigger existed are copied by step(), a few thousand per short transaction.
- analytics_changes: a session's environment arriving or changing, in commit order. Such a change
  re-counts that session's events (they inherit the session's environment), so background
  processing must know about it. New events are changes too; their order is the facts' `id`.
- analytics_meta: the version of these tables, and how far backfill and verification have got.

The facts hold only what the event itself said. The environment its session reported, the
environment fixes and the event dictionary are applied when facts are read, so a late
session_start, a new fix or a mapping edit changes old answers at once. Dashboards read the facts
only once every event is covered and the copied values have been checked (`ready`); until then
they read the raw events. See docs/analytics-pipeline.md.
"""

import argparse
import json
import sqlite3
import sys
from contextlib import contextmanager

from .models import timestamp

SCHEMA_VERSION = 1

# Fact column -> how it is read from an events row. The trigger and the backfill both use these,
# so facts written either way are identical. The values keep the type the JSON had.
EXTRACTED = {
    "event_id": "{row}.event_id",
    "name": "{row}.name",
    "client_ts": "{row}.client_ts",
    "server_ts": "{row}.server_ts",
    "user_id": "json_extract({row}.payload, '$.user_id')",
    "device_id": "json_extract({row}.payload, '$.device_id')",
    "session_id": "json_extract({row}.payload, '$.session_id')",
    "app_version": "json_extract({row}.payload, '$.app_version')",
    "build": "json_extract({row}.payload, '$.build')",
    "country": "json_extract({row}.payload, '$.country')",
    "platform": "json_extract({row}.payload, '$.platform')",
    "environment": "lower(json_extract({row}.payload, '$.environment'))",
    "params": "json_extract({row}.payload, '$.params')",
}
COLUMNS = ", ".join(EXTRACTED)
NOW = "strftime('%Y-%m-%dT%H:%M:%f000+00:00', 'now')"  # timestamp()'s format, in SQL

SCHEMA = f"""
CREATE TABLE IF NOT EXISTS analytics_meta (
    key TEXT PRIMARY KEY,
    value TEXT
);
CREATE TABLE IF NOT EXISTS analytics_facts (
    id INTEGER PRIMARY KEY,
    event_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    client_ts TEXT NOT NULL,
    server_ts TEXT NOT NULL,
    user_id,
    device_id,
    player AS (coalesce(user_id, device_id)) VIRTUAL,
    session_id,
    app_version,
    build,
    country,
    platform,
    environment,
    params
);
CREATE INDEX IF NOT EXISTS analytics_facts_time ON analytics_facts(client_ts);
CREATE INDEX IF NOT EXISTS analytics_facts_player
    ON analytics_facts(player, client_ts, event_id);
CREATE INDEX IF NOT EXISTS analytics_facts_session ON analytics_facts(session_id);
CREATE TABLE IF NOT EXISTS analytics_changes (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    recorded_at TEXT NOT NULL DEFAULT ({NOW})
);
CREATE TRIGGER IF NOT EXISTS analytics_facts_from_events AFTER INSERT ON events BEGIN
    INSERT OR IGNORE INTO analytics_facts ({COLUMNS})
    VALUES ({", ".join(expression.format(row="new") for expression in EXTRACTED.values())});
END;
CREATE TRIGGER IF NOT EXISTS analytics_session_added AFTER INSERT ON sessions BEGIN
    INSERT INTO analytics_changes (session_id) VALUES (new.session_id);
END;
CREATE TRIGGER IF NOT EXISTS analytics_session_changed AFTER UPDATE OF environment ON sessions
WHEN old.environment IS NOT new.environment BEGIN
    INSERT INTO analytics_changes (session_id) VALUES (new.session_id);
END;
"""
# Everything above, in the order to remove it when the schema version changes. Derived data only.
DERIVED = (
    ("TRIGGER", "analytics_facts_from_events"),
    ("TRIGGER", "analytics_session_added"),
    ("TRIGGER", "analytics_session_changed"),
    ("TABLE", "analytics_changes"),
    ("TABLE", "analytics_facts"),
    ("TABLE", "analytics_meta"),
)

BACKFILL_ROWS = 5000  # events copied per transaction
VERIFY_ROWS = 20000  # events or facts checked per transaction


def read_meta(connection):
    return {row[0]: row[1] for row in connection.execute("SELECT key, value FROM analytics_meta")}


def _set(connection, **values):
    connection.executemany(
        "INSERT INTO analytics_meta (key, value) VALUES (?, ?)"
        " ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [(key, None if value is None else str(value)) for key, value in values.items()],
    )


def _begin(connection):
    if not connection.in_transaction:
        connection.execute("BEGIN IMMEDIATE")


def install(connection):
    """Create the facts tables and triggers (cheap: copying older events is step()'s job).

    Atomic with recording which events already existed, so every event is either copied by the
    backfill (it was there before) or written by the trigger (it arrived after).
    """
    _begin(connection)
    exists = connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='analytics_meta'"
    ).fetchone()
    if exists:
        version = read_meta(connection).get("schema_version")
        if version == str(SCHEMA_VERSION):
            return
        for kind, name in DERIVED:  # an older layout: rebuild it from the raw events
            connection.execute(f"DROP {kind} IF EXISTS {name}")
    for statement in _statements(SCHEMA):
        connection.execute(statement)
    until = connection.execute("SELECT coalesce(max(rowid), 0) FROM events").fetchone()[0]
    now = timestamp()
    _set(
        connection,
        schema_version=SCHEMA_VERSION,
        installed_at=now,
        backfill_until=until,
        backfill_cursor=0,
        phase="backfill" if until else "ready",
        verify_cursor=0,
        verify_until=None,
        ready=0 if until else 1,
        ready_at=None if until else now,
        repaired=0,
    )


def _statements(script):
    """Split a schema script into statements, keeping each trigger body whole."""
    statements, current = [], []
    for line in script.strip().splitlines():
        current.append(line)
        text = "\n".join(current).strip()
        if sqlite3.complete_statement(text):
            statements.append(text)
            current = []
    return statements


def facts_ready(connection):
    """Whether every event has verified facts, so the dashboards may read them."""
    row = connection.execute("SELECT value FROM analytics_meta WHERE key='ready'").fetchone()
    return bool(row) and row[0] == "1"


def _insert_from_events(connection, condition, args=()):
    values = ", ".join(expression.format(row="events") for expression in EXTRACTED.values())
    return connection.execute(
        f"INSERT OR IGNORE INTO analytics_facts ({COLUMNS}) SELECT {values} FROM events"
        f" WHERE {condition} ORDER BY events.rowid",
        args,
    ).rowcount


def step(connection, backfill_rows=BACKFILL_ROWS, verify_rows=VERIFY_ROWS):
    """Do the next bounded piece of work in one short transaction; returns progress().

    Work goes backfill (copy older events) -> coverage (every event has facts; missing ones are
    added) -> values (each fact matches its event; a wrong one is rewritten) -> ready. Running it
    again after an interruption carries on from the stored cursors and repeats nothing.
    """
    _begin(connection)
    meta = read_meta(connection)
    phase = meta["phase"]
    if phase == "backfill":
        cursor, until = int(meta["backfill_cursor"]), int(meta["backfill_until"])
        upper = min(until, cursor + backfill_rows)
        _insert_from_events(connection, "events.rowid > ? AND events.rowid <= ?", (cursor, upper))
        _set(connection, backfill_cursor=upper)
        if upper >= until:
            end = connection.execute("SELECT coalesce(max(rowid), 0) FROM events").fetchone()[0]
            _set(connection, phase="coverage", verify_cursor=0, verify_until=end)
    elif phase == "coverage":
        cursor, until = int(meta["verify_cursor"]), int(meta["verify_until"])
        upper = min(until, cursor + verify_rows)
        added = _insert_from_events(
            connection,
            "events.rowid > ? AND events.rowid <= ? AND NOT EXISTS (SELECT 1 FROM analytics_facts"
            " AS fact WHERE fact.event_id = events.event_id)",
            (cursor, upper),
        )
        _set(connection, verify_cursor=upper, repaired=int(meta["repaired"]) + added)
        if upper >= until:
            end = connection.execute("SELECT coalesce(max(id), 0) FROM analytics_facts").fetchone()
            _set(connection, phase="values", verify_cursor=0, verify_until=end[0])
    elif phase == "values":
        cursor, until = int(meta["verify_cursor"]), int(meta["verify_until"])
        upper = min(until, cursor + verify_rows)
        differs = " OR ".join(
            f"fact.{column} IS NOT {expression.format(row='events')}"
            for column, expression in EXTRACTED.items()
        )
        wrong = [
            row[0]
            for row in connection.execute(
                f"SELECT fact.id FROM analytics_facts AS fact JOIN events"
                f" ON events.event_id = fact.event_id WHERE fact.id > ? AND fact.id <= ?"
                f" AND ({differs})",
                (cursor, upper),
            )
        ]
        if wrong:  # rewrite them from their events; their new ids queue them for processing
            marks = ",".join("?" * len(wrong))
            event_ids = [
                row[0]
                for row in connection.execute(
                    f"SELECT event_id FROM analytics_facts WHERE id IN ({marks})", wrong
                )
            ]
            connection.execute(f"DELETE FROM analytics_facts WHERE id IN ({marks})", wrong)
            _insert_from_events(
                connection, f"events.event_id IN ({','.join('?' * len(event_ids))})", event_ids
            )
        _set(connection, verify_cursor=upper, repaired=int(meta["repaired"]) + len(wrong))
        if upper >= until:
            _set(connection, phase="ready", ready=1, ready_at=timestamp())
    return progress(connection)


def audit(connection):
    """Start the checks again if any event lacks facts (cheap: compares two counts)."""
    events = connection.execute("SELECT count(*) FROM events").fetchone()[0]
    facts = connection.execute("SELECT count(*) FROM analytics_facts").fetchone()[0]
    if events == facts:
        return False
    _begin(connection)
    end = connection.execute("SELECT coalesce(max(rowid), 0) FROM events").fetchone()[0]
    _set(connection, phase="coverage", verify_cursor=0, verify_until=end, ready=0, ready_at=None)
    return True


def progress(connection):
    meta = read_meta(connection)
    phase = meta["phase"]
    if phase == "backfill":
        done, total = int(meta["backfill_cursor"]), int(meta["backfill_until"])
    elif phase in ("coverage", "values"):
        done, total = int(meta["verify_cursor"]), int(meta["verify_until"] or 0)
    else:
        done = total = 0
    return {
        "phase": phase,
        "ready": meta.get("ready") == "1",
        "done": done,
        "total": total,
        "repaired": int(meta.get("repaired") or 0),
        "installed_at": meta.get("installed_at"),
        "ready_at": meta.get("ready_at"),
    }


def prepare_all(storage, game_id, *, dry_run=False):
    """Backfill and verify one game to the end (the command line's job; normally the worker's)."""
    with storage.connect(storage.game_path(game_id)) as connection:
        state = progress(connection)
        if dry_run:
            missing = connection.execute(
                "SELECT count(*) FROM events WHERE NOT EXISTS (SELECT 1 FROM analytics_facts"
                " AS fact WHERE fact.event_id = events.event_id)"
            ).fetchone()[0]
            return {**state, "events_without_facts": missing}
    while not state["ready"]:
        with storage.connect(storage.game_path(game_id)) as connection:
            state = step(connection)
    return state


def main(arguments=None):
    """python -m avn_analytics.analytics status|prepare [--game ID] [--dry-run]"""
    from .config import Settings
    from .storage import Storage

    parser = argparse.ArgumentParser(prog="python -m avn_analytics.analytics")
    parser.add_argument("command", choices=("status", "prepare"))
    parser.add_argument("--game", help="one game's id (default: every game)")
    parser.add_argument("--dry-run", action="store_true", help="count, change nothing")
    options = parser.parse_args(arguments)

    class ReadOnlyStorage(Storage):
        @contextmanager
        def connect(self, path):
            connection = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)
            connection.row_factory = sqlite3.Row
            try:
                connection.execute("PRAGMA query_only=ON")
                yield connection
            finally:
                connection.close()

    report_only = options.command == "status" or options.dry_run
    storage = (ReadOnlyStorage if report_only else Storage)(Settings.from_env())
    if report_only:
        if not (storage.root / "registry.sqlite3").is_file():
            print(
                "Registry not found; status/dry-run does not create an installation",
                file=sys.stderr,
            )
            return 1
    else:
        storage.initialize()
    games = [game for game in storage.list_games() if options.game in (None, game["id"])]
    for game in games:
        if report_only:
            with storage.connect(storage.game_path(game["id"])) as connection:
                installed = connection.execute(
                    "SELECT 1 FROM sqlite_master WHERE name='analytics_meta'"
                ).fetchone()
                if installed:
                    result = prepare_all(storage, game["id"], dry_run=True)
                else:
                    total = connection.execute("SELECT count(*) FROM events").fetchone()[0]
                    result = {
                        "phase": "not_installed",
                        "ready": False,
                        "done": 0,
                        "total": total,
                        "events_without_facts": total,
                    }
        else:
            result = prepare_all(storage, game["id"])
        print(json.dumps({"game": game["id"], "name": game["name"], **result}))
    return 0 if games or options.game is None else 1


if __name__ == "__main__":
    sys.exit(main())
