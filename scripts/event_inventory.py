"""What one game actually sends: every event name, every parameter on it, and how the
parameters behave. Reads only, and prints totals and parameter values, never player IDs.

Run it inside the running admin container (from the folder with compose.yaml):

    GAME=<name or id> PLATFORM=android VERSION=0.0.4 docker compose exec -T \
        -e GAME -e PLATFORM -e VERSION admin python - < scripts/event_inventory.py

GAME matches the game's ID or (case-insensitively) part of its name; PLATFORM and VERSION
are optional.
Editor, development, test and debug events are left out, as the dashboards do by default.

Each parameter gets a kind worked out from its values alone (nothing about what the event means):
constant (one value), id (nearly every value different), small set (a handful of values), number,
or text. A key on three or more event names is listed again as shared. A JSON copy of everything
follows the report, between the INVENTORY-JSON markers.
"""

import json
import os
import re
import sqlite3
from collections import defaultdict
from contextlib import contextmanager

from avn_analytics import analytics
from avn_analytics.config import Settings
from avn_analytics.storage import Storage

GAME = os.environ.get("GAME", "").strip().lower()
PLATFORM = os.environ.get("PLATFORM", "").strip().lower()
VERSION = os.environ.get("VERSION", "").strip()
HIDDEN_ENVIRONMENTS = ("editor", "development", "test", "debug")
SKIPPED_KEYS = {"seq"}  # SDK bookkeeping
SMALL_SET = 20  # at most this many different values
TOP_VALUES = 15
STATE_KEY = os.environ.get("STATE_KEY", "STATE")  # the key whose values split an event's parameters
HEXISH = re.compile(r"^[0-9a-fA-F-]{16,}$")


@contextmanager
def read_only(path):
    connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5)
    connection.row_factory = sqlite3.Row
    try:
        yield connection
    finally:
        connection.close()


def kind_of(count, values, types):
    distinct = len(values)
    if distinct == 1:
        return "constant"
    if distinct <= SMALL_SET:
        return "small set"
    if types <= {"integer", "real"}:
        return "number"
    sample = list(values)[:200]
    hexish = sum(bool(HEXISH.match(value)) for value in sample) >= 0.9 * len(sample)
    if distinct > 50 and (distinct >= 0.5 * count or hexish):
        return "id"
    return "text"


def pick_game(storage):
    games = storage.list_games()
    found = [
        game
        for game in games
        if (not GAME or game["id"] == GAME or GAME in game["name"].lower())
        and (not PLATFORM or game["platform"].lower() == PLATFORM)
    ]
    if len(found) != 1:
        names = ", ".join(f"{game['name']} · {game['platform']}" for game in found or games)
        raise SystemExit(f"Set GAME (and PLATFORM) to pick one game. Matches: {names}")
    return found[0]


def main():
    storage = Storage(Settings.from_env())
    game = pick_game(storage)
    with read_only(storage.game_path(game["id"])) as connection:
        if not analytics.facts_ready(connection):
            raise SystemExit("This game's analytics facts aren't ready yet; nothing read.")
        marks = ",".join("?" for _ in HIDDEN_ENVIRONMENTS)
        condition = f"coalesce(lower(environment),'') NOT IN ({marks})"
        args = list(HIDDEN_ENVIRONMENTS)
        if VERSION:
            condition += " AND app_version=?"
            args.append(VERSION)
        totals = connection.execute(
            f"SELECT count(*) AS events, count(DISTINCT player) AS players,"
            f" min(client_ts) AS first, max(client_ts) AS last"
            f" FROM analytics_facts WHERE {condition}",
            args,
        ).fetchone()
        names = {
            row["name"]: {"events": row["events"], "players": row["players"], "params": {}}
            for row in connection.execute(
                f"SELECT name, count(*) AS events, count(DISTINCT player) AS players"
                f" FROM analytics_facts WHERE {condition} GROUP BY name ORDER BY events DESC",
                args,
            )
        }
        found = defaultdict(lambda: {"count": 0, "values": defaultdict(int), "types": set()})
        for row in connection.execute(
            f"SELECT name, p.key AS key, p.type AS type, p.value AS value, count(*) AS n"
            f" FROM analytics_facts, json_each(analytics_facts.params) AS p"
            f" WHERE {condition} GROUP BY name, p.key, p.type, p.value",
            args,
        ):
            if row["key"] in SKIPPED_KEYS:
                continue
            item = found[(row["name"], row["key"])]
            item["count"] += row["n"]
            item["values"][str(row["value"])] += row["n"]
            item["types"].add(row["type"])
        # The same parameters again, split by the value of STATE_KEY on each event.
        states = defaultdict(dict)
        for row in connection.execute(
            f"SELECT name, json_extract(params, '$.{STATE_KEY}') AS state, count(*) AS n"
            f" FROM analytics_facts WHERE {condition} GROUP BY name, state",
            args,
        ):
            if row["state"] is not None:
                states[row["name"]][str(row["state"])] = {"events": row["n"], "params": {}}
        for row in connection.execute(
            f"SELECT name, json_extract(params, '$.{STATE_KEY}') AS state, p.key AS key,"
            f" count(*) AS n FROM analytics_facts, json_each(analytics_facts.params) AS p"
            f" WHERE {condition} AND json_extract(params, '$.{STATE_KEY}') IS NOT NULL"
            f" GROUP BY name, state, p.key",
            args,
        ):
            if row["key"] in SKIPPED_KEYS or row["key"] == STATE_KEY:
                continue
            state = states[row["name"]][str(row["state"])]
            state["params"][row["key"]] = round(row["n"] / state["events"], 4)
        # How the environment column (what "test builds hidden" filters on) is filled, all events.
        environments = [
            dict(row)
            for row in connection.execute(
                "SELECT environment, count(*) AS events FROM analytics_facts"
                + (" WHERE app_version=?" if VERSION else "")
                + " GROUP BY environment ORDER BY events DESC",
                [VERSION] if VERSION else [],
            )
        ]

    shared = defaultdict(list)
    for (name, key), item in found.items():
        kind = kind_of(item["count"], item["values"], item["types"])
        ranked = sorted(item["values"].items(), key=lambda pair: -pair[1])
        entry = {
            "on_share": round(item["count"] / names[name]["events"], 4),
            "events": item["count"],
            "distinct": len(item["values"]),
            "types": sorted(item["types"]),
            "kind": kind,
            "top": [] if kind == "id" else ranked[:TOP_VALUES],
        }
        if kind == "number":
            numbers = [float(value) for value in item["values"]]
            entry["range"] = [min(numbers), max(numbers)]
        names[name]["params"][key] = entry
        shared[key].append(name)

    print(
        f"{game['name']} · {game['platform']} · app version {VERSION or 'all'} · test builds hidden"
    )
    print(
        f"{totals['events']:,} events · {totals['players']:,} players"
        f" · {totals['first']} → {totals['last']}\n"
    )
    for name, info in names.items():
        print(f"{name}  ·  {info['events']:,} events · {info['players']:,} players")
        params = sorted(info["params"].items(), key=lambda pair: -pair[1]["events"])
        if not params:
            print("    (no parameters)")
        for key, entry in params:
            share = f"{entry['on_share']:.0%}"
            detail = ""
            if entry["kind"] == "number":
                low, high = entry["range"]
                detail = f" · {low:g}–{high:g}"
            if entry["top"]:
                detail += " · " + ", ".join(
                    f"{value} ({count:,})" for value, count in entry["top"][:8]
                )
                if entry["distinct"] > 8:
                    detail += ", …"
            print(
                f"    {key:<22} on {share:>4} · {entry['distinct']:>6,} values"
                f" · {entry['kind']}{detail}"
            )
        print()
    print("Keys on three or more event names:")
    for key, where in sorted(shared.items(), key=lambda pair: -len(pair[1])):
        if len(where) >= 3:
            print(f"    {key:<22} {len(where)} events: {', '.join(sorted(where))}")
    print(f"\nParameters by {STATE_KEY} (share of that state's events carrying each key):")
    for name, by_state in states.items():
        print(f"{name}")
        for state, info in sorted(by_state.items(), key=lambda pair: -pair[1]["events"]):
            keys = sorted(info["params"].items(), key=lambda pair: (-pair[1], pair[0]))
            listed = ", ".join(
                key if share >= 0.995 else f"{key} {share:.0%}" for key, share in keys
            )
            print(f"    {state:<14} {info['events']:>7,}  {listed or '(nothing else)'}")
    print("\nEnvironment column, all events of this version (test builds are hidden by this):")
    for row in environments:
        print(f"    {str(row['environment']):<14} {row['events']:>9,}")
    print("\n----- INVENTORY-JSON -----")
    print(
        json.dumps(
            {
                "game": game["name"],
                "platform": game["platform"],
                "version": VERSION,
                "totals": dict(totals),
                "events": names,
                "shared": shared,
                "states": states,
                "environments": environments,
            }
        )
    )
    print("----- END INVENTORY-JSON -----")


if __name__ == "__main__":
    main()
