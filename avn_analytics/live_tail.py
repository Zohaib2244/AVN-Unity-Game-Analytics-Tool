"""Live events: what a game is sending right now, newest last, for checking an SDK integration.

Read only. Events are paged by the table's rowid, which only grows as events are stored, so a
cursor (`after`) returns exactly the events stored since the last look. Every event is shown,
editor and development builds included, since those are what an integration test sends.

Narrowed to one player (user ID or device ID), the first look reads only the newest
SCAN_ROWS events, so it stays quick on a large game; later looks only read what arrived since.
"""

import json

MAX_EVENTS = 200
SCAN_ROWS = 50_000


def _event(row):
    try:
        payload = json.loads(row["payload"])
    except ValueError:
        payload = {}
    params = payload.get("params")
    return {
        "cursor": row["rowid"],
        "event_id": row["event_id"],
        "name": row["name"],
        "client_ts": row["client_ts"],
        "server_ts": row["server_ts"],
        "user_id": payload.get("user_id"),
        "device_id": payload.get("device_id"),
        "session_id": payload.get("session_id"),
        "app_version": payload.get("app_version"),
        "environment": payload.get("environment"),
        "params": params if isinstance(params, dict) else {},
    }


def tail(storage, game_id, after=None, player=None, limit=100):
    """Events stored after the `after` cursor (or the newest `limit` when it is None).

    Returns {"events": [... oldest first], "cursor": the cursor to pass next time,
    "scanned_from": the oldest rowid looked at on a first look narrowed to a player, else None}.
    """
    limit = max(1, min(int(limit), MAX_EVENTS))
    player = (player or "").strip() or None
    with storage.connect(storage.game_path(game_id)) as connection:
        newest = connection.execute("SELECT COALESCE(MAX(rowid), 0) FROM events").fetchone()[0]
        clauses, args = [], []
        scanned_from = None
        if after is not None:
            clauses.append("rowid > ?")
            args.append(int(after))
        elif player:
            scanned_from = max(0, newest - SCAN_ROWS)
            clauses.append("rowid > ?")
            args.append(scanned_from)
        if player:
            clauses.append(
                "(json_extract(payload, '$.user_id') = ?"
                " OR json_extract(payload, '$.device_id') = ?)"
            )
            args += [player, player]
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        if after is None:  # the first look: the newest events, shown oldest first
            sql = (
                "SELECT rowid, event_id, name, client_ts, server_ts, payload FROM events "
                f"{where} ORDER BY rowid DESC LIMIT ?"
            )
            rows = list(reversed(connection.execute(sql, [*args, limit]).fetchall()))
        else:
            sql = (
                "SELECT rowid, event_id, name, client_ts, server_ts, payload FROM events "
                f"{where} ORDER BY rowid LIMIT ?"
            )
            rows = connection.execute(sql, [*args, limit]).fetchall()
    events = [_event(row) for row in rows]
    if after is None:
        cursor = newest  # nothing older is wanted again, whatever the player filter matched
    else:
        # a full page may have more behind it; otherwise everything up to `newest` was read
        cursor = events[-1]["cursor"] if len(events) == limit else max(int(after), newest)
    return {"events": events, "cursor": cursor, "scanned_from": scanned_from}
