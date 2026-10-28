"""Deleting the events an app version sent, for builds nobody needs any more.

The one place raw events are removed on purpose; everything else in the app keeps them. The
owner picks versions on Game settings → Data and types the bundle ID. Removal walks the events in
short rowid windows, each its own transaction, so collection keeps writing between them; every
window removes an event and its facts together, so the facts audit (two counts) stays equal.
Prepared answers are dropped at the end because their watermarks can't see removed facts.

Freed pages stay in the file and new events reuse them, so the file stops growing rather than
shrinking.
"""

import logging
import threading

from fastapi import HTTPException

from . import analytics

logger = logging.getLogger(__name__)

WINDOW = 20_000  # event rowids looked at per transaction
VERSION = "json_extract(payload, '$.app_version')"
_running = {}  # game id -> the versions being deleted, while a deletion runs
_lock = threading.Lock()


def versions(storage, game_id):
    """Each app version the game has events from, newest first, and what a deletion would take."""
    storage.get_game(game_id)
    with storage.connect(storage.game_path(game_id)) as connection:
        if analytics.facts_ready(connection):
            source, version, player = "analytics_facts", "app_version", "player"
        else:
            source, version = "events", VERSION
            player = (
                "coalesce(json_extract(payload,'$.user_id'),json_extract(payload,'$.device_id'))"
            )
        rows = connection.execute(
            f"""SELECT {version} AS app_version, count(*) AS events,
                       count(DISTINCT {player}) AS players,
                       min(client_ts) AS first_seen, max(client_ts) AS last_seen
                FROM {source} WHERE {version} IS NOT NULL GROUP BY 1"""
        ).fetchall()
    with _lock:
        deleting = sorted(_running.get(game_id, ()))
    return {"versions": [dict(row) for row in rows], "deleting": deleting}


def start(storage, game_id, chosen, confirm, done=None):
    """Check the request and delete in a background thread; returns at once."""
    game = storage.get_game(game_id)
    if confirm != game["bundle_id"]:
        raise HTTPException(400, "Type the game's bundle ID to confirm deletion")
    chosen = sorted({version for version in chosen if version})
    if not chosen:
        raise HTTPException(400, "Choose at least one version")
    with _lock:
        if game_id in _running:
            raise HTTPException(409, "Already deleting events for this game")
        _running[game_id] = set(chosen)

    def run():
        try:
            removed = delete(storage, game_id, chosen)
            if done:
                done(removed)
        except Exception:
            logger.exception("deleting versions of game %s failed", game_id)
        finally:
            with _lock:
                _running.pop(game_id, None)

    threading.Thread(target=run, name=f"delete-versions-{game_id}", daemon=True).start()
    return {"status": "deleting", "versions": chosen}


def delete(storage, game_id, chosen):
    """Remove these versions' events and their facts, a window at a time; returns the count."""
    marks = ",".join("?" * len(chosen))
    removed = 0
    with storage.connect(storage.game_path(game_id)) as connection:
        end = connection.execute("SELECT coalesce(max(rowid),0) FROM events").fetchone()[0]
        for low in range(0, end, WINDOW):
            connection.execute("BEGIN IMMEDIATE")
            try:
                ids = [
                    row[0]
                    for row in connection.execute(
                        f"SELECT event_id FROM events WHERE rowid>? AND rowid<=? "
                        f"AND {VERSION} IN ({marks})",
                        (low, low + WINDOW, *chosen),
                    )
                ]
                if ids:
                    found = ",".join("?" * len(ids))
                    connection.execute(f"DELETE FROM events WHERE event_id IN ({found})", ids)
                    connection.execute(
                        f"DELETE FROM analytics_facts WHERE event_id IN ({found})", ids
                    )
                    removed += len(ids)
                connection.commit()
            except BaseException:
                connection.rollback()
                raise
        connection.execute("BEGIN IMMEDIATE")
        for table in ("analytics_queue", "analytics_parts", "analytics_views"):
            connection.execute(f"DELETE FROM {table}")
        connection.commit()
    storage.reads.clear()
    storage.scans.clear()
    return removed
