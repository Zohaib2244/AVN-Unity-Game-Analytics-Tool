"""What a game sends compared with the AVN events standard.

`status` lists, for one game, how much of each standard event it has sent and which events it
sends that the standard does not have. Those can be added to the standard as custom events (the
editor starts from what the game sent) or ignored for this game. Read live from the event database.
"""

import re
from collections import defaultdict

from . import avn_events_standard, custom_events
from .insights import HIDDEN_PARAMS, PLAYER, SDK_EVENTS

SQL_KINDS = {"integer": "int", "real": "float", "text": "string"}
MAX_UNLISTED = 50
MAX_STATES = 30
MAX_PARAMS = 30


def _init(connection):
    connection.execute("""
        CREATE TABLE IF NOT EXISTS standard_ignored (
            game_id TEXT NOT NULL,
            name TEXT NOT NULL,
            ignored_at TEXT NOT NULL,
            PRIMARY KEY (game_id, name)
        )
    """)


def ignored(storage, game_id):
    with storage.connect(storage.root / "registry.sqlite3") as registry:
        _init(registry)
        rows = registry.execute("SELECT name FROM standard_ignored WHERE game_id=?", (game_id,))
        return {row["name"] for row in rows}


def ignore(storage, game_id, name, on=True):
    from .models import timestamp

    with storage.connect(storage.root / "registry.sqlite3") as registry:
        _init(registry)
        if on:
            registry.execute(
                "INSERT OR IGNORE INTO standard_ignored (game_id, name, ignored_at) "
                "VALUES (?, ?, ?)",
                (game_id, name, timestamp()),
            )
        else:
            registry.execute(
                "DELETE FROM standard_ignored WHERE game_id=? AND name=?", (game_id, name)
            )


def _draft(connection, name):
    """The editor's starting point for an event the game sends: its states and parameters."""
    states = defaultdict(
        lambda: {"events": 0, "params": defaultdict(lambda: {"kinds": set(), "count": 0})}
    )
    rows = connection.execute(
        """SELECT json_extract(payload, '$.params.STATE') AS state, count(*) AS events
           FROM events WHERE name=? GROUP BY state""",
        (name,),
    )
    for row in rows:
        states[row["state"] if isinstance(row["state"], str) else ""]["events"] += row["events"]
    rows = connection.execute(
        """SELECT json_extract(payload, '$.params.STATE') AS state, p.key AS key, p.type AS type,
                  count(*) AS count
           FROM events, json_each(events.payload, '$.params') AS p
           WHERE name=? GROUP BY state, p.key, p.type""",
        (name,),
    )
    for row in rows:
        kind = SQL_KINDS.get(row["type"])
        state = row["state"] if isinstance(row["state"], str) else ""
        if kind is None or row["key"] in HIDDEN_PARAMS or row["key"] in custom_events.RESERVED_KEYS:
            continue
        item = states[state]["params"][row["key"]]
        item["kinds"].add(kind)
        item["count"] += row["count"]
    out, skipped = [], set()
    for label, info in sorted(states.items(), key=lambda pair: -pair[1]["events"])[:MAX_STATES]:
        if label and not custom_events.STATE.fullmatch(label):
            skipped.add(label)
            continue
        params = []
        for key, item in sorted(info["params"].items()):
            if not custom_events.KEY.fullmatch(key) or len(params) >= MAX_PARAMS:
                skipped.add(key)
                continue
            kind = (
                "float"
                if "float" in item["kinds"]
                else "int"
                if "int" in item["kinds"]
                else "string"
            )
            params.append({"key": key, "type": kind, "required": item["count"] >= info["events"]})
        out.append({"name": label, "events": info["events"], "params": params})
    return out, sorted(skipped)


def status(storage, game_id, custom):
    """{sent: {name: {events, last_seen}}, unlisted: [...], ignored: [...]} for one game."""
    storage.get_game(game_id)
    known = set(avn_events_standard.spec(custom)["events"])
    hidden = ignored(storage, game_id)
    with storage.connect(storage.game_path(game_id)) as connection:
        rows = connection.execute(
            f"""SELECT name, count(*) AS events, count(DISTINCT {PLAYER}) AS players,
                       max(client_ts) AS last_seen
                FROM events GROUP BY name"""
        ).fetchall()
        sent, unlisted, muted = {}, [], []
        for row in sorted(rows, key=lambda item: -item["events"]):
            name = row["name"]
            if name in known:
                sent[name] = {"events": row["events"], "last_seen": row["last_seen"]}
            elif name in SDK_EVENTS:
                continue
            elif name in hidden:
                muted.append({"name": name, "events": row["events"]})
            elif len(unlisted) < MAX_UNLISTED:
                item = {
                    "name": name,
                    "events": row["events"],
                    "players": row["players"],
                    "last_seen": row["last_seen"],
                    "valid_name": bool(
                        re.fullmatch(custom_events.NAME.pattern, name) and len(name) <= 40
                    ),
                }
                item["states"], item["skipped"] = (
                    _draft(connection, name) if item["valid_name"] else ([], [])
                )
                unlisted.append(item)
    return {"sent": sent, "unlisted": unlisted, "ignored": muted}
