"""All-time totals per event name and per parameter, kept up to date beside the analytics facts.

Several pages describe a game's whole history, not a date range: which events it has ever sent,
how often, by how many players, first and last seen, and which parameters each event carries with
which types and example values (Events, Event setup, Discovery, the dictionary import). Counting
those from the facts reads, and parses the parameters of, every event the game ever sent, on every
page load, so those pages slowed down as a game's history grew whatever dates were picked.

This module keeps the totals in small derived tables and adds only the facts that arrived since
(facts `id` order), in short transactions of a few thousand rows. A read is the stored totals plus a
live count of any facts newer than them, so answers are always exact and never wait for the
worker. Like the facts, these tables are derived only:

- event_name_stats: per event name and app version: events, first/last client and server time.
- event_param_stats: per event name, app version, parameter key and JSON type: events, the
  smallest and largest value.
- event_name_players: each (event name, player) pair seen, so distinct players per name are
  exact without reading every event.

A fact that is deleted or changed (deleting app versions, a verification repair) or a facts
rebuild invalidates the totals; they are then built again from the facts, a chunk at a time.
Nothing here reads or changes raw events. They are used only when the facts are ready
(insights.read_source); otherwise pages read the raw events as before.
"""

import logging
import sqlite3

from . import analytics

log = logging.getLogger(__name__)

VERSION = 1
CHUNK_ROWS = 20_000  # facts added per short write transaction
REFRESH_ROWS = 400_000  # at most this many per request; the rest is counted live this time

SCHEMA = """
CREATE TABLE IF NOT EXISTS event_stats_meta (
    key TEXT PRIMARY KEY,
    value TEXT
);
CREATE TABLE IF NOT EXISTS event_name_stats (
    name TEXT NOT NULL,
    version_slot TEXT NOT NULL,
    app_version,
    events INTEGER NOT NULL,
    first_client TEXT,
    last_client TEXT,
    first_server TEXT,
    last_server TEXT,
    PRIMARY KEY (name, version_slot)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS event_param_stats (
    name TEXT NOT NULL,
    version_slot TEXT NOT NULL,
    key TEXT NOT NULL,
    type TEXT NOT NULL,
    app_version,
    events INTEGER NOT NULL,
    low,
    high,
    PRIMARY KEY (name, version_slot, key, type)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS event_name_players (
    name TEXT NOT NULL,
    player NOT NULL,
    PRIMARY KEY (name, player)
) WITHOUT ROWID;
CREATE TRIGGER IF NOT EXISTS event_stats_fact_deleted AFTER DELETE ON analytics_facts BEGIN
    INSERT INTO event_stats_meta (key, value) VALUES ('stale', '1')
    ON CONFLICT(key) DO UPDATE SET value='1';
END;
CREATE TRIGGER IF NOT EXISTS event_stats_fact_changed AFTER UPDATE ON analytics_facts BEGIN
    INSERT INTO event_stats_meta (key, value) VALUES ('stale', '1')
    ON CONFLICT(key) DO UPDATE SET value='1';
END;
"""
DERIVED = (
    ("TRIGGER", "event_stats_fact_deleted"),
    ("TRIGGER", "event_stats_fact_changed"),
    ("TABLE", "event_name_players"),
    ("TABLE", "event_param_stats"),
    ("TABLE", "event_name_stats"),
    ("TABLE", "event_stats_meta"),
)
# quote() tells a missing version, a text version and a numeric one apart, as the facts do.
SLOT = "quote(app_version)"


def _meta(connection):
    try:
        return {
            row[0]: row[1] for row in connection.execute("SELECT key, value FROM event_stats_meta")
        }
    except sqlite3.OperationalError:
        return {}


def _set(connection, **values):
    connection.executemany(
        "INSERT INTO event_stats_meta (key, value) VALUES (?, ?)"
        " ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [(key, None if value is None else str(value)) for key, value in values.items()],
    )


def install(connection):
    """Create the tables (empty: refresh() fills them). Needs the facts tables to exist."""
    if not connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='analytics_facts'"
    ).fetchone():
        return
    meta = _meta(connection)
    if meta and meta.get("version") == str(VERSION) and _has_triggers(connection):
        return
    if not connection.in_transaction:
        connection.execute("BEGIN IMMEDIATE")
    for kind, name in DERIVED:
        connection.execute(f"DROP {kind} IF EXISTS {name}")
    for statement in analytics._statements(SCHEMA):
        connection.execute(statement)
    # Empty totals through fact 0 describe the current facts: readers count them all live.
    facts_installed_at = analytics.read_meta(connection).get("installed_at")
    _set(connection, version=VERSION, through=0, stale=0, facts_installed_at=facts_installed_at)


def _has_triggers(connection):
    # The facts table being rebuilt drops the triggers on it; then the totals must be rebuilt too.
    found = connection.execute(
        "SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN"
        " ('event_stats_fact_deleted', 'event_stats_fact_changed')"
    ).fetchone()[0]
    return found == 2


def _usable(connection, meta):
    """Stored totals still describe facts 1..through (nothing deleted, changed or rebuilt)."""
    facts = analytics.read_meta(connection)
    return (
        meta.get("version") == str(VERSION)
        and meta.get("stale") != "1"
        and meta.get("facts_installed_at") == facts.get("installed_at")
        and _has_triggers(connection)
    )


def _reset(connection):
    for table in ("event_name_players", "event_param_stats", "event_name_stats"):
        connection.execute(f"DELETE FROM {table}")
    facts = analytics.read_meta(connection)
    _set(connection, through=0, stale=0, facts_installed_at=facts.get("installed_at"))


def _add(connection, low_id, high_id):
    """Add facts low_id < id <= high_id to the stored totals (inside the caller's transaction)."""
    args = (low_id, high_id)
    connection.execute(
        f"""INSERT INTO event_name_stats (name, version_slot, app_version, events, first_client,
                                          last_client, first_server, last_server)
            SELECT name, {SLOT}, app_version, count(*), min(client_ts), max(client_ts),
                   min(server_ts), max(server_ts)
            FROM analytics_facts WHERE id > ? AND id <= ? GROUP BY name, {SLOT}
            ON CONFLICT(name, version_slot) DO UPDATE SET
                events = events + excluded.events,
                first_client = min(first_client, excluded.first_client),
                last_client = max(last_client, excluded.last_client),
                first_server = min(first_server, excluded.first_server),
                last_server = max(last_server, excluded.last_server)""",
        args,
    )
    connection.execute(
        f"""INSERT INTO event_param_stats (name, version_slot, key, type, app_version, events,
                                           low, high)
            SELECT name, {SLOT}, p.key, p.type, app_version, count(*), min(p.value), max(p.value)
            FROM analytics_facts, json_each(analytics_facts.params) AS p
            WHERE analytics_facts.id > ? AND analytics_facts.id <= ?
            GROUP BY name, {SLOT}, p.key, p.type
            ON CONFLICT(name, version_slot, key, type) DO UPDATE SET
                events = events + excluded.events,
                low = CASE WHEN low IS NULL THEN excluded.low WHEN excluded.low IS NULL THEN low
                           ELSE min(low, excluded.low) END,
                high = CASE WHEN high IS NULL THEN excluded.high
                            WHEN excluded.high IS NULL THEN high
                            ELSE max(high, excluded.high) END""",
        args,
    )
    connection.execute(
        """INSERT OR IGNORE INTO event_name_players (name, player)
           SELECT DISTINCT name, player FROM analytics_facts
           WHERE id > ? AND id <= ? AND player IS NOT NULL""",
        args,
    )


def refresh(connection, max_rows=REFRESH_ROWS, chunk_rows=CHUNK_ROWS):
    """Bring the stored totals up to date, a chunk per short transaction; returns `through`.

    Stops after max_rows facts: whatever is newer is counted live by the readers this time.
    Safe to run from several processes at once (each chunk re-reads where the totals are).
    """
    if not analytics.facts_ready(connection):
        return None
    if connection.in_transaction:
        connection.commit()
    if not _meta(connection) or not _has_triggers(connection):
        install(connection)
        connection.commit()
    done = 0
    while True:
        connection.execute("BEGIN IMMEDIATE")
        try:
            meta = _meta(connection)
            if not _usable(connection, meta):
                _reset(connection)
                meta = _meta(connection)
            through = int(meta.get("through") or 0)
            newest = connection.execute(
                "SELECT coalesce(max(id), 0) FROM analytics_facts"
            ).fetchone()[0]
            if through >= newest or done >= max_rows:
                connection.commit()
                return through
            upper = min(newest, through + chunk_rows)
            _add(connection, through, upper)
            _set(connection, through=upper)
            connection.commit()
            done += upper - through
        except BaseException:
            connection.rollback()
            raise


def current(connection):
    """`through` when the stored totals may be read with this connection, else None."""
    meta = _meta(connection)
    if not meta or not _usable(connection, meta):
        return None
    return int(meta.get("through") or 0)


def refreshed(storage, game_id):
    """Refresh the game's totals in a connection of its own; quietly skips when busy."""
    try:
        with storage.connect(storage.game_path(game_id)) as connection:
            connection.isolation_level = None  # refresh() manages its own transactions
            refresh(connection)
    except sqlite3.OperationalError as error:
        # Locked or interrupted: readers count whatever is newer live this time.
        log.info("event totals not refreshed for %s: %s", game_id, error)


def name_totals(connection, app_version=""):
    """name -> {events, first_seen, last_seen (client time), first_server, last_server} for all
    time (or one app version), exact: stored totals plus the newer facts. None if unavailable."""
    through = current(connection)
    if through is None:
        return None
    totals = {}
    scope = "(? = '' OR app_version = ?)"
    for row in connection.execute(
        f"""SELECT name, sum(events), min(first_client), max(last_client), min(first_server),
                   max(last_server)
            FROM (SELECT name, app_version, events, first_client, last_client, first_server,
                         last_server FROM event_name_stats
                  UNION ALL
                  SELECT name, app_version, count(*), min(client_ts), max(client_ts),
                         min(server_ts), max(server_ts)
                  FROM analytics_facts WHERE id > ? GROUP BY name, {SLOT})
            WHERE {scope} GROUP BY name""",
        (through, app_version, app_version),
    ):
        totals[row[0]] = {
            "events": row[1],
            "first_seen": row[2],
            "last_seen": row[3],
            "first_server": row[4],
            "last_server": row[5],
        }
    return totals


def name_players(connection):
    """name -> distinct players for all time, exact. None if unavailable."""
    through = current(connection)
    if through is None:
        return None
    return {
        row[0]: row[1]
        for row in connection.execute(
            """SELECT name, count(*) FROM (
                   SELECT name, player FROM event_name_players
                   UNION
                   SELECT name, player FROM analytics_facts WHERE id > ? AND player IS NOT NULL)
               GROUP BY name""",
            (through,),
        )
    }


def param_totals(connection, app_version=""):
    """[(name, key, type, events, low, high)] for all time (or one app version), exact.
    None if unavailable."""
    through = current(connection)
    if through is None:
        return None
    scope = "(? = '' OR app_version = ?)"
    return connection.execute(
        f"""SELECT name, key, type, sum(events) AS count, min(low) AS low, max(high) AS high
            FROM (SELECT name, key, type, app_version, events, low, high FROM event_param_stats
                  UNION ALL
                  SELECT name, p.key, p.type, app_version, count(*), min(p.value), max(p.value)
                  FROM analytics_facts, json_each(analytics_facts.params) AS p
                  WHERE analytics_facts.id > ? GROUP BY name, {SLOT}, p.key, p.type)
            WHERE {scope} GROUP BY name, key, type""",
        (through, app_version, app_version),
    ).fetchall()


def versions(connection):
    """Every app version the game has sent (missing ones as 'unknown'), or None if unavailable."""
    through = current(connection)
    if through is None:
        return None
    return [
        row[0]
        for row in connection.execute(
            """SELECT DISTINCT coalesce(app_version, 'unknown') FROM (
                   SELECT app_version FROM event_name_stats
                   UNION ALL
                   SELECT app_version FROM analytics_facts WHERE id > ?)""",
            (through,),
        )
    ]
