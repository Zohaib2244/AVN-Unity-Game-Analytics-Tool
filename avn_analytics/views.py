"""Exact, rebuildable dashboard answers, published only as complete generations.

Requests register bounded specifications and use fresh published answers or the live path.
The worker builds Levels in resumable player batches. New events are excluded by fact ID;
context/definition changes discard staging. No read snapshot survives a worker tick.
"""

import hashlib
import json
import sqlite3
import time
import zlib
from collections import Counter
from contextlib import contextmanager
from dataclasses import replace
from datetime import datetime

from . import analytics

VERSION = 1
EXPIRY = 86400
BATCH_PLAYERS = 20
# What one Levels step may read: a batch of players, or a single heavy player on their own.
BATCH_ROWS, BATCH_BYTES = 25_000, 16 * 1024 * 1024
SOLO_ROWS, SOLO_BYTES = 200_000, 128 * 1024 * 1024
MAX_SECONDS = 30.0
SCHEMA = """
CREATE TABLE IF NOT EXISTS analytics_views (
    key TEXT PRIMARY KEY, spec TEXT NOT NULL, touched REAL NOT NULL,
    fingerprint TEXT, watermark INTEGER, contexts INTEGER,
    source_at REAL, checked_at REAL, answer BLOB,
    stage TEXT, cursor INTEGER NOT NULL DEFAULT 0,
    error TEXT, retry_at REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS analytics_parts (
    view_key TEXT NOT NULL REFERENCES analytics_views(key) ON DELETE CASCADE,
    player TEXT NOT NULL, part BLOB NOT NULL, nrows INTEGER NOT NULL,
    PRIMARY KEY(view_key, player)
);
CREATE TABLE IF NOT EXISTS analytics_queue (
    view_key TEXT NOT NULL REFERENCES analytics_views(key) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL, player TEXT NOT NULL,
    PRIMARY KEY(view_key, ordinal)
);
"""


def install(connection):
    for statement in analytics._statements(SCHEMA):
        connection.execute(statement)
    columns = {row["name"] for row in connection.execute("PRAGMA table_info(analytics_views)")}
    if "error" not in columns:
        connection.execute("ALTER TABLE analytics_views ADD COLUMN error TEXT")
        connection.execute(
            "ALTER TABLE analytics_views ADD COLUMN retry_at REAL NOT NULL DEFAULT 0"
        )


def pack(value):
    return zlib.compress(json.dumps(value, separators=(",", ":"), default=sorted).encode())


def unpack(value):
    return json.loads(zlib.decompress(value))


def fingerprint(storage, game_id, connection):
    definitions = storage.get_dictionary(game_id)
    fixes = [
        tuple(row) for row in connection.execute("SELECT * FROM environment_fixes ORDER BY id")
    ]
    meta = analytics.read_meta(connection)
    value = [VERSION, definitions, fixes, meta.get("ready_at"), meta.get("repaired")]
    return hashlib.sha256(json.dumps(value, sort_keys=True, default=str).encode()).hexdigest()


def watermarks(connection):
    return (
        connection.execute("SELECT coalesce(max(id),0) FROM analytics_facts").fetchone()[0],
        connection.execute("SELECT coalesce(max(seq),0) FROM analytics_changes").fetchone()[0],
    )


def contexts_compatible(connection, since, watermark):
    # New sessions belonging entirely to facts after the generation's watermark cannot alter
    # its answer. Invalidating for every new session would prevent publication under steady ingest.
    return (
        connection.execute(
            "SELECT 1 FROM analytics_changes c JOIN analytics_facts f "
            "ON f.session_id=c.session_id WHERE c.seq>? AND f.id<=? LIMIT 1",
            (since, watermark),
        ).fetchone()
        is None
    )


def _running(storage, now):
    from .materialize import UNAVAILABLE_SECONDS

    with storage.connect(storage.root / "registry.sqlite3") as connection:
        row = connection.execute(
            "SELECT c.desired, c.revision, s.acknowledged_revision, s.observed, s.heartbeat_at "
            "FROM analytics_worker_control c LEFT JOIN analytics_worker_status s ON s.id=c.id"
        ).fetchone()
    return bool(
        row
        and row["desired"] == "running"
        and row["observed"] in ("running", "catching_up")
        and row["acknowledged_revision"] == row["revision"]
        and now - datetime.fromisoformat(row["heartbeat_at"]).timestamp() <= UNAVAILABLE_SECONDS
    )


def answer(storage, game_id, kind, parts, compute):
    if storage.settings.analytics_read_mode != "prepared":
        return compute()
    storage.get_game(game_id)
    normalized = json.loads(json.dumps(parts))
    filters_at = 2 if kind == "levels" else 1
    normalized[filters_at] = {
        field: sorted(set(values))
        for field, values in (normalized[filters_at] or {}).items()
        if values
    }
    spec = json.dumps([kind, normalized], sort_keys=True, separators=(",", ":"))
    key = hashlib.sha256(spec.encode()).hexdigest()
    now = time.time()
    with storage.connect(storage.game_path(game_id)) as connection:
        row = connection.execute("SELECT * FROM analytics_views WHERE key=?", (key,)).fetchone()
        # Do not write on every read. A minute granularity is enough for LRU/expiry.
        if row is None or now - row["touched"] > 60:
            connection.execute(
                "INSERT INTO analytics_views(key,spec,touched) VALUES(?,?,?) "
                "ON CONFLICT(key) DO UPDATE SET touched=excluded.touched",
                (key, spec, now),
            )
            connection.execute(
                "DELETE FROM analytics_views WHERE key IN (SELECT key FROM analytics_views "
                "ORDER BY touched DESC, key LIMIT -1 OFFSET ?)",
                (storage.settings.analytics_active_views,),
            )
        eligible = (
            row is not None
            and row["answer"] is not None
            and analytics.facts_ready(connection)
            and now - row["source_at"] <= storage.settings.analytics_freshness_seconds
            and row["fingerprint"] == fingerprint(storage, game_id, connection)
            # Context changes reinterpret old events; unlike new events they cannot be stale.
            and contexts_compatible(connection, row["contexts"], row["watermark"])
        )
    if eligible and _running(storage, now):
        result = unpack(row["answer"])
        if kind == "levels":
            return restore_scan(result)
        # Confidence is presentation state, so a threshold edit needs no event rebuild.
        threshold = storage.analytics_thresholds(game_id)["retention_min_users"]
        result["context"].update(
            minimum_players=threshold, low_sample=0 < result["players"] < threshold
        )
        return result
    return compute()


def restore_scan(scan):
    scan["levels"] = {int(key): value for key, value in scan["levels"].items()}
    scan["transitions"] = {int(key): value for key, value in scan["transitions"].items()}
    for level in scan["levels"].values():
        for field in ("other", "powerups"):
            level[field] = Counter(level[field])
    return scan


def backlog(storage, connection, now):
    rows = connection.execute("SELECT source_at, answer FROM analytics_views").fetchall()
    seconds = now.timestamp()
    ages = [seconds - row["source_at"] for row in rows if row["source_at"] is not None]
    waiting = sum(
        row["answer"] is None
        or seconds - row["source_at"] > storage.settings.analytics_refresh_seconds
        for row in rows
    )
    return {"views": len(rows), "views_waiting": waiting, "lag_seconds": max(ages, default=0)}


class Cancelled(Exception):
    pass


class Snapshot:
    """Route a computation's game reads through one bounded SQLite snapshot."""

    def __init__(self, storage, game_id, connection):
        self.base = storage
        self.path = storage.game_path(game_id)
        self.connection = connection
        self.settings = replace(storage.settings, analytics_read_mode="facts", read_cache_seconds=0)

    def get_dictionary(self, game_id):
        return type(self.base).get_dictionary(self, game_id)

    def __getattr__(self, name):
        return getattr(self.base, name)

    @contextmanager
    def connect(self, path):
        if path == self.path:
            yield self.connection
        else:
            with self.base.connect(path) as connection:
                yield connection


def _guard(worker, revision, began):
    if worker.should_stop(revision):
        raise Cancelled()
    worker._write_status()
    if time.monotonic() - began >= MAX_SECONDS:
        raise TimeoutError("Prepared computation exceeded its 30-second snapshot budget")


def _space(storage):
    total = 0
    for game in storage.list_games():
        path = storage.game_path(game["id"])
        if not path.exists():
            continue
        with storage.connect(path) as connection:
            total += connection.execute(
                "SELECT coalesce(sum(length(coalesce(answer,''))+length(coalesce(stage,'')) "
                "+length(spec)+256),0) "
                "FROM analytics_views"
            ).fetchone()[0]
            total += connection.execute(
                "SELECT coalesce(sum(length(part)+length(player)+256),0) FROM analytics_parts"
            ).fetchone()[0]
            total += connection.execute(
                "SELECT coalesce(sum(length(player)+256),0) FROM analytics_queue"
            ).fetchone()[0]
    return total


def refresh(worker, game_id, revision):
    storage = worker.storage
    now = time.time()
    path = storage.game_path(game_id)
    with storage.connect(path) as connection:
        connection.execute("DELETE FROM analytics_views WHERE touched<?", (now - EXPIRY,))
        row = connection.execute(
            "SELECT * FROM analytics_views WHERE retry_at<=? "
            "AND (checked_at IS NULL OR checked_at<?) "
            "ORDER BY coalesce(checked_at,0), touched DESC LIMIT 1",
            (now, now - storage.settings.analytics_refresh_seconds),
        ).fetchone()
    if row is None or worker.should_stop(revision):
        return False
    if _space(storage) >= storage.settings.analytics_storage_bytes:
        # Evict derived answers only; the next request still has the exact live path.
        with storage.connect(path) as connection:
            connection.execute("DELETE FROM analytics_views WHERE key=?", (row["key"],))
        return True
    began = time.monotonic()
    worker.job = (game_id, "preparing " + json.loads(row["spec"])[0])
    worker._write_status()
    try:
        return _refresh(worker, game_id, revision, dict(row), began)
    except Cancelled:
        return False
    except Exception as error:
        if isinstance(error, sqlite3.OperationalError) and str(error) == "interrupted":
            if time.monotonic() - began < MAX_SECONDS:
                return False
            error = TimeoutError("Prepared computation exceeded its snapshot budget")
        with storage.connect(path) as connection:
            connection.execute(
                "UPDATE analytics_views SET error=?,retry_at=? WHERE key=?",
                (f"{type(error).__name__}: {str(error)[:300]}", time.time() + 60, row["key"]),
            )
        raise error


def _level_contributions(connection, key, queued, parts, reader, check, max_rows, max_bytes):
    """Each queued player's packed Levels contribution, read within the row and byte allowance."""
    from . import journeys

    start, end, filters, scope, mark = parts
    contributions = []
    for player, events in journeys.player_rows(
        connection,
        [item["player"] for item in queued],
        start,
        end,
        filters,
        mark,
        check=check,
        max_rows=max_rows,
        max_bytes=max_bytes,
    ):
        check()
        if len(events) > journeys.MAX_FUNNEL_EVENTS:
            raise ValueError("Levels history exceeds the existing event limit")
        counted = journeys.counted_rows(player, events, scope)
        value = (
            journeys.player_levels(*counted, scope, start, reader)
            if counted
            else {"progress": {}, "groups": {}, "observed": []}
        )
        contributions.append((key, player, pack(value), len(events)))
    return contributions


def _fenced(connection, worker, row):
    """A resumed/superseded worker cannot overwrite another worker's staging or publication."""
    meta = analytics.read_meta(connection)
    until = meta.get("lease_until")
    if (
        meta.get("lease_owner") != worker.identity
        or not until
        or datetime.fromisoformat(until) <= worker.clock()
    ):
        return False
    current = connection.execute(
        "SELECT stage,cursor FROM analytics_views WHERE key=?", (row["key"],)
    ).fetchone()
    return bool(
        current is not None
        and current["stage"] == row["stage"]
        and current["cursor"] == row["cursor"]
    )


def _refresh(worker, game_id, revision, row, began):
    from . import insights, journeys, stories

    storage, key = worker.storage, row["key"]
    kind, parts = json.loads(row["spec"])
    path = storage.game_path(game_id)
    remaining = storage.settings.analytics_storage_bytes - _space(storage)
    source_started = time.time()
    with storage.connect(path) as connection:
        connection.execute("BEGIN")
        # A separate registry connection checks controls/keeps the heartbeat alive. It never
        # executes SQL on this game connection from inside SQLite's callback.
        checked = began

        def interrupt():
            nonlocal checked
            if time.monotonic() - checked < 0.1:
                return 0
            checked = time.monotonic()
            try:
                _guard(worker, revision, began)
            except (Cancelled, TimeoutError):
                return 1
            return 0

        connection.set_progress_handler(interrupt, 10000)
        snapshot = Snapshot(storage, game_id, connection)
        digest = fingerprint(snapshot, game_id, connection)
        mark, contexts = watermarks(connection)
        if (
            row["fingerprint"] == digest
            and row["watermark"] == mark
            and contexts_compatible(connection, row["contexts"], row["watermark"])
        ):
            result = None
            stage = None
        elif kind == "summary":
            days, filters, offset = parts
            result = insights.summary(snapshot, game_id, *days, filters, offset)
            stage = None
        else:
            start, end, filters, scope = parts
            stage = json.loads(row["stage"]) if row["stage"] else None
            if stage:
                if stage["fingerprint"] != digest or not contexts_compatible(
                    connection, stage["contexts"], stage["watermark"]
                ):
                    stage = None
                else:
                    stage["contexts"] = contexts
            if stage is None:
                players = journeys.scanned_players(
                    connection, start, end, filters, scope, mark, max_players=100_000
                )
                # A published generation retains per-player contributions. Only identities with
                # newer facts need recomputing; context/definition changes require a full rebuild.
                incremental = (
                    row["answer"] is not None
                    and row["fingerprint"] == digest
                    and contexts_compatible(connection, row["contexts"], row["watermark"])
                    and row["stage"] is None
                )
                removed = []
                if incremental:
                    cohort = set(players)
                    changed = {
                        item[0]
                        for item in connection.execute(
                            "SELECT DISTINCT player FROM analytics_facts WHERE id>? AND id<=? "
                            "AND player IS NOT NULL",
                            (row["watermark"], mark),
                        )
                    }
                    removed = [
                        item[0]
                        for item in connection.execute(
                            "SELECT player FROM analytics_parts WHERE view_key=?", (key,)
                        )
                        if item[0] not in cohort
                    ]
                    players = [player for player in players if player in changed]
                condition, args = insights.where(start, end, filters, source=insights.FACTS)
                anonymous, selected = connection.execute(
                    f"SELECT count(*) FILTER(WHERE player IS NULL), "
                    f"count(*) FILTER(WHERE player IS NOT NULL) FROM analytics_facts "
                    f"WHERE {condition} AND id<=?",
                    (*args, mark),
                ).fetchone()
                stage = {
                    "fingerprint": digest,
                    "watermark": mark,
                    "contexts": contexts,
                    "source_at": time.time(),
                    "anonymous_events": anonymous,
                    "too_many": selected > journeys.MAX_FUNNEL_EVENTS,
                    "history_rows": 0,
                }
                # Never persist a partial answer for a query the live path refuses.
                if stage["too_many"] and scope != "first_session":
                    raise ValueError("Levels exceeds the existing event limit; narrow the dates")
                if sum(len(str(player).encode()) + 256 for player in players) > remaining:
                    raise ValueError("Prepared answers exceed the derived storage budget")
                _guard(worker, revision, began)
                connection.rollback()
                connection.set_progress_handler(None, 0)
                connection.execute("BEGIN IMMEDIATE")
                if not _fenced(connection, worker, row):
                    return False
                if not incremental:
                    connection.execute("DELETE FROM analytics_parts WHERE view_key=?", (key,))
                elif removed:
                    connection.executemany(
                        "DELETE FROM analytics_parts WHERE view_key=? AND player=?",
                        ((key, player) for player in removed),
                    )
                connection.execute("DELETE FROM analytics_queue WHERE view_key=?", (key,))
                connection.executemany(
                    "INSERT INTO analytics_queue VALUES(?,?,?)",
                    ((key, index, player) for index, player in enumerate(players)),
                )
                connection.execute(
                    "UPDATE analytics_views SET stage=?, cursor=0 WHERE key=?",
                    (json.dumps(stage), key),
                )
                return True
            mark = stage["watermark"]
            queued = connection.execute(
                "SELECT ordinal, player FROM analytics_queue WHERE view_key=? AND ordinal>=? "
                "ORDER BY ordinal LIMIT ?",
                (key, row["cursor"], BATCH_PLAYERS),
            ).fetchall()
            if queued:
                reader = journeys._Reader(stories.Labeler(snapshot.get_dictionary(game_id)))
                while True:
                    # Players with long histories can push a batch past its allowance: halve the
                    # batch until it fits, so one heavy player never stalls the view.
                    alone = len(queued) == 1
                    try:
                        contributions = _level_contributions(
                            connection,
                            key,
                            queued,
                            (start, end, filters, scope, mark),
                            reader,
                            lambda: _guard(worker, revision, began),
                            SOLO_ROWS if alone else BATCH_ROWS,
                            SOLO_BYTES if alone else BATCH_BYTES,
                        )
                        break
                    except journeys.BatchTooBig:
                        if alone:
                            raise
                        queued = queued[: len(queued) // 2]
                if (
                    sum(len(item[2]) + len(str(item[1]).encode()) + 256 for item in contributions)
                    > remaining
                ):
                    raise ValueError("Prepared answers exceed the derived storage budget")
                _guard(worker, revision, began)
                connection.rollback()
                connection.set_progress_handler(None, 0)
                connection.execute("BEGIN IMMEDIATE")
                if not _fenced(connection, worker, row):
                    return False
                connection.executemany(
                    "DELETE FROM analytics_parts WHERE view_key=? AND player=?",
                    ((key, item["player"]) for item in queued),
                )
                connection.executemany(
                    "INSERT OR REPLACE INTO analytics_parts VALUES(?,?,?,?)", contributions
                )
                connection.execute(
                    "UPDATE analytics_views SET cursor=?,stage=? WHERE key=?",
                    (queued[-1]["ordinal"] + 1, json.dumps(stage), key),
                )
                return True
            count = connection.execute(
                "SELECT coalesce(sum(nrows),0) FROM analytics_parts WHERE view_key=?", (key,)
            ).fetchone()[0]
            if count > journeys.MAX_FUNNEL_EVENTS:
                raise ValueError("Levels history exceeds the existing event limit")
            totals = journeys._LevelTotals()
            decoded_bytes = 0
            for part in connection.execute(
                "SELECT part FROM analytics_parts WHERE view_key=? ORDER BY player", (key,)
            ):
                _guard(worker, revision, began)
                raw = zlib.decompress(part[0])
                decoded_bytes += len(raw)
                if decoded_bytes > 64 * 1024 * 1024:
                    raise ValueError("Prepared Levels exceeds the bounded reducer memory budget")
                value = json.loads(raw)
                for field in ("progress", "groups"):
                    value[field] = {int(k): v for k, v in value[field].items()}
                totals.add(value)
            result = {
                "levels": totals.levels,
                "transitions": totals.transitions(),
                "anonymous_events": stage["anonymous_events"],
                "too_many": stage["too_many"],
            }
        payload = pack(result) if result is not None else row["answer"]
        if len(payload) > remaining:
            raise ValueError("Prepared answers exceed the derived storage budget")
        source_at = stage["source_at"] if stage else source_started
        _guard(worker, revision, began)
        connection.rollback()
        connection.set_progress_handler(None, 0)
        connection.execute("BEGIN IMMEDIATE")
        # Fence publication against changed interpretation, context, and a lost worker lease.
        if (
            fingerprint(storage, game_id, connection) != digest
            or not contexts_compatible(connection, contexts, mark)
            or not _fenced(connection, worker, row)
        ):
            return False
        connection.execute(
            "UPDATE analytics_views SET answer=?,fingerprint=?,watermark=?,contexts=?,"
            "source_at=?,checked_at=?,stage=NULL,cursor=0,error=NULL,retry_at=0 WHERE key=?",
            (payload, digest, mark, watermarks(connection)[1], source_at, time.time(), key),
        )
        connection.execute("DELETE FROM analytics_queue WHERE view_key=?", (key,))
    return True


def has_errors(storage, game_id):
    with storage.connect(storage.game_path(game_id)) as connection:
        return (
            connection.execute(
                "SELECT 1 FROM analytics_views WHERE error IS NOT NULL LIMIT 1"
            ).fetchone()
            is not None
        )
