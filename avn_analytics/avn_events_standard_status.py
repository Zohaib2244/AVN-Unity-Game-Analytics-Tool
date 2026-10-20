"""What a game sends compared with the AVN events standard.

`status` lists, for one game, how much of each standard event it has sent and which events it
sends that the standard does not have. Those can be added to the standard as custom events (the
editor starts from what the game sent) or ignored for this game. Read live from the event database.

Everything can be limited to one app version, or to that version and the ones first seen after it
(old builds keep sending their own events long after nobody plays them). Versions are ordered by
when each was first seen, so odd version strings never have to be parsed.
"""

import re
from collections import defaultdict

from . import avn_events_standard, custom_events
from .insights import HIDDEN_PARAMS, PLAYER, SDK_EVENTS

SQL_KINDS = {"integer": "int", "real": "float", "text": "string"}
MAX_UNLISTED = 50
MAX_STATES = 30
MAX_PARAMS = 30
VERSION = "coalesce(json_extract(payload, '$.app_version'), 'unknown')"
LATEST = "@latest"  # the newest version that has players


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


def _draft(connection, name, scope="", args=()):
    """The editor's starting point for an event the game sends: its states and parameters."""
    states = defaultdict(
        lambda: {"events": 0, "params": defaultdict(lambda: {"kinds": set(), "count": 0})}
    )
    rows = connection.execute(
        f"""SELECT json_extract(payload, '$.params.STATE') AS state, count(*) AS events
           FROM events WHERE name=? {scope} GROUP BY state""",
        (name, *args),
    )
    for row in rows:
        states[row["state"] if isinstance(row["state"], str) else ""]["events"] += row["events"]
    rows = connection.execute(
        f"""SELECT json_extract(payload, '$.params.STATE') AS state, p.key AS key, p.type AS type,
                  count(*) AS count
           FROM events, json_each(events.payload, '$.params') AS p
           WHERE name=? {scope} GROUP BY state, p.key, p.type""",
        (name, *args),
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


def versions(connection):
    """Every app version the game has sent, newest first (by first event)."""
    rows = connection.execute(
        f"""SELECT {VERSION} AS version, count(*) AS events,
                   count(DISTINCT {PLAYER}) AS players,
                   min(client_ts) AS first_seen, max(client_ts) AS last_seen
            FROM events GROUP BY version"""
    ).fetchall()
    found = [dict(row) for row in rows]
    found.sort(key=lambda item: (item["first_seen"] or "", item["version"]), reverse=True)
    return found


def _in_scope(found, version, newer):
    """(versions to look at, versions first seen before them); (None, set()) for all of them.

    Raises LookupError for a version the game never sent.
    """
    if not version:
        return None, set()
    if version == LATEST:
        version = next((item["version"] for item in found if item["players"]), None)
        if version is None:
            return None, set()
    chosen = next((item for item in found if item["version"] == version), None)
    if chosen is None:
        raise LookupError(f"No such version: {version}")
    start = chosen["first_seen"] or ""
    older = {item["version"] for item in found if (item["first_seen"] or "") < start}
    if not newer:
        return {version}, older
    return {item["version"] for item in found if (item["first_seen"] or "") >= start}, older


def _clause(scope):
    """SQL and arguments that keep only the events of the versions in `scope`."""
    if scope is None:
        return "", ()
    marks = ", ".join("?" for _ in scope)
    return f"AND {VERSION} IN ({marks})", tuple(sorted(scope))


def _totals(connection):
    """{name: events} over every version."""
    rows = connection.execute("SELECT name, count(*) AS events FROM events GROUP BY name")
    return {row["name"]: row["events"] for row in rows}


def _older_only(connection, totals, known, hidden, older):
    """Events only versions older than the chosen ones sent: [{name, events}]."""
    if not older:
        return []
    names = {}
    for side, op in (("old", "IN"), ("other", "NOT IN")):
        marks = ", ".join("?" for _ in older)
        rows = connection.execute(
            f"SELECT DISTINCT name FROM events WHERE {VERSION} {op} ({marks})", tuple(sorted(older))
        )
        names[side] = {row["name"] for row in rows}
    skip = names["other"] | known | hidden | SDK_EVENTS
    return [
        {"name": name, "events": events}
        for name, events in sorted(totals.items(), key=lambda pair: -pair[1])
        if name in names["old"] and name not in skip
    ]


def status(storage, game_id, custom, version="", newer=False):
    """{sent, unlisted, ignored, versions, older_only, ...} for one game.

    `version` limits every count to that app version ("@latest" for the newest one with players);
    with `newer` the versions first seen after it are included too. Raises LookupError for a
    version the game never sent.
    """
    storage.get_game(game_id)
    known = set(avn_events_standard.spec(custom)["events"])
    hidden = ignored(storage, game_id)
    with storage.connect(storage.game_path(game_id)) as connection:
        found = versions(connection)
        scope, before = _in_scope(found, version, newer)
        clause, args = _clause(scope)
        rows = connection.execute(
            f"""SELECT name, count(*) AS events, count(DISTINCT {PLAYER}) AS players,
                       max(client_ts) AS last_seen
                FROM events WHERE 1=1 {clause} GROUP BY name""",
            args,
        ).fetchall()
        where = {}
        for row in connection.execute(
            f"SELECT name, {VERSION} AS version FROM events GROUP BY name, version"
        ):
            where.setdefault(row["name"], []).append(row["version"])
        totals = _totals(connection)
        order = {item["version"]: index for index, item in enumerate(found)}
        sent, unlisted, total = {}, [], 0
        for row in sorted(rows, key=lambda item: -item["events"]):
            name = row["name"]
            if name in known:
                sent[name] = {"events": row["events"], "last_seen": row["last_seen"]}
            elif name in SDK_EVENTS:
                continue
            elif name in hidden:
                continue
            else:
                total += 1
                if len(unlisted) >= MAX_UNLISTED:
                    continue
                item = {
                    "name": name,
                    "events": row["events"],
                    "players": row["players"],
                    "last_seen": row["last_seen"],
                    "versions": sorted(where.get(name, []), key=lambda v: order.get(v, 0)),
                    "valid_name": bool(
                        re.fullmatch(custom_events.NAME.pattern, name) and len(name) <= 40
                    ),
                }
                item["states"], item["skipped"] = (
                    _draft(connection, name, clause, args) if item["valid_name"] else ([], [])
                )
                unlisted.append(item)
        older = _older_only(connection, totals, known, hidden, before)
        muted = [
            {"name": name, "events": events}
            for name, events in sorted(totals.items(), key=lambda pair: -pair[1])
            if name in hidden and name not in known
        ]
    chosen = sorted(scope, key=lambda v: order.get(v, 0)) if scope is not None else []
    return {
        "sent": sent,
        "unlisted": unlisted,
        "total_unlisted": total,
        "ignored": muted,
        "versions": found,
        "scope": chosen,
        "older_only": older,
    }


def ignore_older(storage, game_id, version, newer):
    """Ignore every event that only versions outside the chosen ones sent; returns how many."""
    storage.get_game(game_id)
    known = set(avn_events_standard.spec(custom_events.load(storage))["events"])
    hidden = ignored(storage, game_id)
    with storage.connect(storage.game_path(game_id)) as connection:
        _, before = _in_scope(versions(connection), version, newer)
        older = _older_only(connection, _totals(connection), known, hidden, before)
    names = [item["name"] for item in older]
    for name in names:
        ignore(storage, game_id, name)
    return len(names)
