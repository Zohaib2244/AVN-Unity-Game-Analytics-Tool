"""Live game dashboards: summary, funnels and player journeys, from a game's event database.

Everything here works on game time (client_ts) and identifies a player by user_id when the game
sets one, otherwise by the per-install device_id. Filters narrow every query to an environment,
app version, build, country or platform.
"""

import json
import re
from collections import Counter
from datetime import UTC, datetime, timedelta
from statistics import median
from uuid import uuid4

from fastapi import HTTPException

from .models import timestamp

PLAYER = "coalesce(json_extract(payload, '$.user_id'), json_extract(payload, '$.device_id'))"
SESSION = "json_extract(payload, '$.session_id')"
# The environment of an event: sent with the batch, else recorded for its session from
# session_start, else "editor" for Unity Editor builds; anything older is "unknown".
ENVIRONMENT = (
    "coalesce(lower(json_extract(payload, '$.environment')),"
    " (SELECT environment FROM sessions WHERE sessions.session_id=json_extract(events.payload,"
    " '$.session_id')),"
    " CASE WHEN json_extract(payload, '$.platform')='editor' THEN 'editor' END, 'unknown')"
)
DIMENSIONS = {
    "environment": ENVIRONMENT,
    "app_version": "coalesce(json_extract(payload, '$.app_version'), 'unknown')",
    "build": "coalesce(json_extract(payload, '$.build'), 'unknown')",
    "country": "coalesce(json_extract(payload, '$.country'), 'unknown')",
    "platform": "coalesce(json_extract(payload, '$.platform'), 'unknown')",
}
FILTER_FIELDS = {
    "environments": "environment",
    "app_versions": "app_version",
    "builds": "build",
    "countries": "country",
    "platforms": "platform",
}
HIDDEN_PARAMS = {"seq"}  # SDK bookkeeping, not something to analyze
# Sent automatically by the Unity SDK and documented in the skill itself.
SDK_EVENTS = {"first_open", "session_start", "session_end"}
PARAM_TYPES = {"text": "string", "integer": "number", "real": "number"}  # as json_each reports
STALE_DAYS = 30
MAX_FUNNEL_EVENTS = 5_000_000
MAX_JOURNEY_EVENTS = 5_000
DROPPED_SAMPLE = 50
BREAKDOWN_SEGMENTS = 12
ROUTE_PLAYERS = 200
TOP_ROUTES = 60
TOP_EXITS = 25
START_EXIT = "__start__"  # stopped with nothing done after the start step
OTHER = "Other events"


def where(start, end, filters=None, column="client_ts"):
    """SQL condition and arguments for the day range plus any filters.

    column picks which timestamp bounds the range (client_ts by default; exports can use server_ts).
    """
    clauses, args = [f"{column}>=? AND {column}<?"], [start, end]
    filters = filters or {}
    for field, dimension in FILTER_FIELDS.items():
        values = filters.get(field) or []
        if values:
            clauses.append(f"{DIMENSIONS[dimension]} IN ({','.join('?' * len(values))})")
            args += values
    excluded = filters.get("exclude_environments") or []
    if excluded:
        clauses.append(f"{ENVIRONMENT} NOT IN ({','.join('?' * len(excluded))})")
        args += excluded
    return " AND ".join(clauses), args


def facets(storage, game_id, start, end):
    """Every value of each filterable dimension in the range, unfiltered, for the filter menus."""
    storage.get_game(game_id)
    condition, args = where(start, end)
    result = {}
    with storage.connect(storage.game_path(game_id)) as connection:
        for dimension, expression in DIMENSIONS.items():
            result[dimension] = [
                dict(row)
                for row in connection.execute(
                    f"SELECT {expression} AS value, count(*) AS events FROM events "
                    f"WHERE {condition} GROUP BY value ORDER BY events DESC LIMIT 100",
                    args,
                )
            ]
    return result


def summary(storage, game_id, start, end, filters):
    """Totals, a daily series and breakdowns for the game overview."""
    storage.get_game(game_id)
    condition, args = where(start, end, filters)
    with storage.connect(storage.game_path(game_id)) as connection:
        totals = dict(
            connection.execute(
                f"SELECT count(*) AS events, count(DISTINCT {PLAYER}) AS players, "
                f"count(DISTINCT {SESSION}) AS sessions FROM events WHERE {condition}",
                args,
            ).fetchone()
        )
        new_players = connection.execute(
            f"SELECT count(DISTINCT {PLAYER}) FROM events WHERE {condition} AND name='first_open'",
            args,
        ).fetchone()[0]
        days = [
            dict(row)
            for row in connection.execute(
                f"SELECT substr(client_ts, 1, 10) AS day, count(*) AS events, "
                f"count(DISTINCT {PLAYER}) AS players, count(DISTINCT {SESSION}) AS sessions "
                f"FROM events WHERE {condition} GROUP BY day ORDER BY day",
                args,
            )
        ]
        breakdowns = {
            dimension: [
                dict(row)
                for row in connection.execute(
                    f"SELECT {expression} AS value, count(*) AS events, "
                    f"count(DISTINCT {PLAYER}) AS players FROM events WHERE {condition} "
                    "GROUP BY value ORDER BY players DESC, events DESC LIMIT 15",
                    args,
                )
            ]
            for dimension, expression in DIMENSIONS.items()
        }
        top_events = [
            dict(row)
            for row in connection.execute(
                f"SELECT name, count(*) AS events, count(DISTINCT {PLAYER}) AS players "
                f"FROM events WHERE {condition} GROUP BY name ORDER BY events DESC LIMIT 15",
                args,
            )
        ]
    return {
        **totals,
        "new_players": new_players,
        "days": days,
        "breakdowns": breakdowns,
        "top_events": top_events,
    }


def catalog(storage, game_id, start, end, filters=None):
    """Event names in the range, with their parameter keys and the most common values of each."""
    storage.get_game(game_id)
    condition, args = where(start, end, filters)
    with storage.connect(storage.game_path(game_id)) as connection:
        events = {
            row["name"]: {"name": row["name"], "count": row["count"], "params": {}}
            for row in connection.execute(
                f"SELECT name, count(*) AS count FROM events WHERE {condition} "
                "GROUP BY name ORDER BY count DESC",
                args,
            )
        }
        for row in connection.execute(
            f"""SELECT name, p.key AS key, p.value AS value, count(*) AS count
                FROM events, json_each(events.payload, '$.params') AS p
                WHERE {condition} GROUP BY name, p.key, p.value ORDER BY count DESC""",
            args,
        ):
            if row["key"] in HIDDEN_PARAMS or row["name"] not in events:
                continue
            param = events[row["name"]]["params"].setdefault(
                row["key"], {"key": row["key"], "count": 0, "values": []}
            )
            param["count"] += row["count"]
            if len(param["values"]) < 50:
                param["values"].append(str(row["value"]))
    for event in events.values():
        event["params"] = sorted(event["params"].values(), key=lambda item: -item["count"])
    return {"events": list(events.values())}


def discovery(storage, game_id):
    """What the game really sends, set against the dictionary, so the gaps can be filled in.

    Looks at every stored event (all environments, so a dev-build run is enough to discover a
    new event) and returns the events and parameters that are missing a description, plus the
    defined events that have stopped arriving. SDK events are never reported as missing.
    """
    storage.get_game(game_id)
    definitions = storage.get_dictionary(game_id)
    with storage.connect(storage.game_path(game_id)) as connection:
        observed = {
            row["name"]: {
                "name": row["name"],
                "count": row["count"],
                "first_seen": row["first_seen"],
                "last_seen": row["last_seen"],
                "params": {},
            }
            for row in connection.execute(
                """SELECT name, count(*) AS count, min(server_ts) AS first_seen,
                          max(server_ts) AS last_seen FROM events GROUP BY name"""
            )
        }
        for row in connection.execute(
            """SELECT name, p.key AS key, p.type AS type, count(*) AS count,
                      min(p.value) AS low, max(p.value) AS high
               FROM events, json_each(events.payload, '$.params') AS p
               GROUP BY name, p.key, p.type"""
        ):
            if row["key"] in HIDDEN_PARAMS or row["type"] not in PARAM_TYPES:
                continue
            param = observed[row["name"]]["params"].setdefault(
                row["key"], {"key": row["key"], "count": 0, "types": [], "examples": []}
            )
            param["count"] += row["count"]
            kind = PARAM_TYPES[row["type"]]
            if kind not in param["types"]:
                param["types"].append(kind)
            for value in (row["low"], row["high"]):
                example = str(value)[:60]
                if len(param["examples"]) < 3 and example not in param["examples"]:
                    param["examples"].append(example)
    missing = []
    for name, event in observed.items():
        defined = definitions.get(name)
        if defined is None and name in SDK_EVENTS:
            continue
        undescribed = [
            param
            for key, param in event["params"].items()
            if key not in (defined or {}).get("params", {})
        ]
        if defined is not None and not undescribed:
            continue
        missing.append(
            {
                **{key: value for key, value in event.items() if key != "params"},
                "description": defined["description"] if defined else "",
                "defined": defined is not None,
                "params": sorted(undescribed, key=lambda item: -item["count"]),
            }
        )
    missing.sort(key=lambda item: (item["defined"], -item["count"]))
    cutoff = timestamp(datetime.now(UTC) - timedelta(days=STALE_DAYS))
    activity = {
        name: {"count": event["count"], "last_seen": event["last_seen"]}
        for name, event in observed.items()
        if name in definitions
    }
    return {
        "missing": missing,
        "events_seen": len(observed),
        "activity": activity,
        "stale": [
            name
            for name in definitions
            if name not in activity or activity[name]["last_seen"] < cutoff
        ],
        "stale_days": STALE_DAYS,
    }


def _number(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def matches(step, name, params):
    """Whether an event satisfies a funnel step (event name, then an optional param condition)."""
    if name != step["event"]:
        return False
    key = step.get("param")
    if not key:
        return True
    if key not in params:
        return False
    operator, wanted, actual = step.get("op") or "eq", step.get("value", ""), params[key]
    if operator == "exists" or (operator == "eq" and wanted == ""):
        return True
    if operator in ("eq", "ne"):
        left, right = _number(actual), _number(wanted)
        same = left == right if left is not None and right is not None else str(actual) == wanted
        return same if operator == "eq" else not same
    if operator == "contains":
        return wanted.lower() in str(actual).lower()
    left, right = _number(actual), _number(wanted)
    if left is None or right is None:
        return False
    return {"gt": left > right, "gte": left >= right, "lt": left < right, "lte": left <= right}[
        operator
    ]


def _times(seconds):
    if not seconds:
        return None
    ordered = sorted(seconds)

    def percentile(share):
        return round(ordered[min(len(ordered) - 1, int(share * len(ordered)))], 1)

    return {
        "count": len(ordered),
        "average": round(sum(ordered) / len(ordered), 1),
        "p25": percentile(0.25),
        "median": round(median(ordered), 1),
        "p75": percentile(0.75),
        "p90": percentile(0.9),
        "min": round(ordered[0], 1),
        "max": round(ordered[-1], 1),
    }


def funnel(storage, game_id, start, end, query):
    """Players who did step 1, then step 2 after it, and so on, in game-time order.

    Each player (or each session, with scope="session") moves through the steps greedily: the
    first event matching the next step counts. With a window, later steps must happen within
    that many hours of step 1. Per player, the furthest-reaching attempt is kept.
    """
    storage.get_game(game_id)
    steps = query["steps"]
    condition, args = where(start, end, query.get("filters"))
    names = sorted({step["event"] for step in steps})
    marks = ",".join("?" * len(names))
    window = query["window_hours"] * 3600 if query.get("window_hours") else None
    by_session = query.get("scope") == "session"
    breakdown = query.get("breakdown")
    segment_sql = DIMENSIONS[breakdown] if breakdown else "NULL"
    attempts = {}  # (player, session or None) -> {"times": [...], "segment": ...}
    with storage.connect(storage.game_path(game_id)) as connection:
        total = connection.execute(
            f"SELECT count(*) FROM events WHERE {condition} AND name IN ({marks})",
            (*args, *names),
        ).fetchone()[0]
        if total > MAX_FUNNEL_EVENTS:
            raise HTTPException(400, "Too many events in this range for a funnel. Pick fewer days.")
        rows = connection.execute(
            f"""SELECT {PLAYER} AS player, {SESSION} AS session, name,
                       unixepoch(client_ts, 'subsec') AS ts, client_ts,
                       json_extract(payload, '$.params') AS params, {segment_sql} AS segment
                FROM events WHERE {condition} AND name IN ({marks})
                ORDER BY player, client_ts, event_id""",
            (*args, *names),
        )
        for row in rows:
            key = (row["player"], row["session"] if by_session else None)
            attempt = attempts.get(key)
            done = len(attempt["times"]) if attempt else 0
            if done == len(steps):
                continue
            if window and done and row["ts"] - attempt["times"][0] > window:
                continue
            if not matches(steps[done], row["name"], json.loads(row["params"] or "{}")):
                continue
            if attempt is None:
                attempt = attempts[key] = {"times": [], "segment": row["segment"]}
            attempt["times"].append(row["ts"])
            attempt["last"] = row["client_ts"]
    best = {}
    for (player, _), attempt in attempts.items():
        kept = best.get(player)
        if kept is None or len(attempt["times"]) > len(kept["times"]):
            best[player] = attempt
    reached = [0] * len(steps)
    gaps = [[] for _ in steps]
    dropped = [[] for _ in steps]
    complete = []
    segments = {}
    for player, attempt in best.items():
        times = attempt["times"]
        for index in range(len(times)):
            reached[index] += 1
            if index:
                gaps[index].append(times[index] - times[index - 1])
        if len(times) < len(steps):
            dropped[len(times) - 1].append({"player": player, "last_seen": attempt["last"]})
        elif len(steps) > 1:
            complete.append(times[-1] - times[0])
        if breakdown:
            counts = segments.setdefault(str(attempt["segment"]), [0] * len(steps))
            for index in range(len(times)):
                counts[index] += 1
    result = []
    for index, step in enumerate(steps):
        previous = reached[index - 1] if index else reached[0]
        sample = sorted(dropped[index], key=lambda item: item["last_seen"], reverse=True)
        result.append(
            {
                **step,
                "players": reached[index],
                "of_first": round(100 * reached[index] / reached[0], 1) if reached[0] else 0,
                "of_previous": round(100 * reached[index] / previous, 1) if previous else 0,
                "time_from_previous": _times(gaps[index]),
                "dropped": len(dropped[index]) if index < len(steps) - 1 else 0,
                "dropped_sample": sample[:DROPPED_SAMPLE] if index < len(steps) - 1 else [],
            }
        )
    ordered = sorted(segments.items(), key=lambda item: -item[1][0])
    return {
        "steps": result,
        "time_to_complete": _times(complete),
        "breakdown": breakdown,
        "segments": [{"value": value, "players": counts} for value, counts in ordered][
            :BREAKDOWN_SEGMENTS
        ],
        "segments_total": len(ordered),
    }


DETAIL_MAX_VALUES = 40  # a parameter with more distinct values than this is too noisy to show
DETAIL_MAX_PARAMS = 3
DETAIL_SKIP = re.compile(r"(time|duration|second|score|timestamp|_ts$|^ts$|^name$|id$)", re.I)
# Names that usually say where or what, so they come first when only a few parameters are shown.
DETAIL_FIRST = re.compile(
    r"(level|stage|started|completed|failed|state|status|type|mode|difficulty|result|reason|source|tier)",
    re.I,
)


def _detail_stats(connection, condition, args):
    """event -> {param: distinct values} for every non-hidden parameter in the range."""
    stats = {}
    for row in connection.execute(
        f"""SELECT name, p.key AS key, count(DISTINCT p.value) AS distinct_values,
                   count(*) AS uses
            FROM events, json_each(events.payload, '$.params') AS p
            WHERE {condition} GROUP BY name, p.key""",
        args,
    ):
        if row["key"] not in HIDDEN_PARAMS:
            stats.setdefault(row["name"], {})[row["key"]] = (row["distinct_values"], row["uses"])
    return stats


def _detail_choice(stats, query):
    """Which parameters to show per event: automatic (few distinct values) plus overrides."""
    include = {(item["event"], item["param"]) for item in query.get("detail_include") or []}
    exclude = {(item["event"], item["param"]) for item in query.get("detail_exclude") or []}
    auto = query.get("details", "auto") == "auto"
    chosen = {}
    for event, params in stats.items():
        ranked = sorted(
            params.items(),
            key=lambda item: (
                (event, item[0]) not in include,
                not DETAIL_FIRST.search(item[0]),
                -item[1][1],
                item[0],
            ),
        )
        keys = [
            key
            for key, (distinct, _) in ranked
            if (event, key) not in exclude
            and (
                (event, key) in include
                or (
                    auto
                    and event not in SDK_EVENTS  # session_start etc. carry device data, not context
                    and re.match(r"[A-Za-z]", key)
                    and distinct <= DETAIL_MAX_VALUES
                    and not DETAIL_SKIP.search(key)
                )
            )
        ]
        if keys:
            chosen[event] = keys[:DETAIL_MAX_PARAMS]
    return chosen


def _short(value):
    text = str(value)
    return text if len(text) <= 24 else text[:23] + "…"


def _route_paths(storage, game_id, start, end, query):
    """Each player's route from the start step to the end step.

    A player's route begins at their first event matching the start step and lists the events
    they did after it, in game-time order, until an event matches the end step ("reached"), the
    window or session ends ("stopped"), or max_depth events have passed ("continued"). Each
    event also carries a short "details" text with its useful parameter values (Started=5).
    """
    storage.get_game(game_id)
    steps = query["steps"]
    first, last = query.get("route_from", 1), query.get("route_to") or len(steps)
    if not 1 <= first < last <= len(steps):
        raise HTTPException(400, "Choose a start step that comes before the end step.")
    origin, goal = steps[first - 1], steps[last - 1]
    condition, args = where(start, end, query.get("filters"))
    window = query["window_hours"] * 3600 if query.get("window_hours") else None
    by_session = query.get("scope") == "session"
    ignore = set(query.get("ignore") or [])
    split = {item["event"]: item["param"] for item in query.get("split") or []}
    depth, collapse = query["max_depth"], query.get("collapse", True)
    with storage.connect(storage.game_path(game_id)) as connection:
        total = connection.execute(
            f"SELECT count(*) FROM events WHERE {condition}", args
        ).fetchone()[0]
        if total > MAX_FUNNEL_EVENTS:
            raise HTTPException(400, "Too many events in this range. Pick fewer days.")
        stats = _detail_stats(connection, condition, args)
        chosen = _detail_choice(stats, query)
        parse = {origin["event"], goal["event"], *split, *chosen}
        rows = connection.execute(
            f"""SELECT {PLAYER} AS player, {SESSION} AS session, name,
                       unixepoch(client_ts, 'subsec') AS ts, client_ts,
                       CASE WHEN name IN ({",".join("?" * len(parse))})
                            THEN json_extract(payload, '$.params') END AS params
                FROM events WHERE {condition} ORDER BY player, client_ts, event_id""",
            (*parse, *args),
        )
        paths, current, player, seen = [], None, None, set()

        def finish():
            if current is not None:
                status = current["status"] or "stopped"
                paths.append(
                    (
                        current["player"],
                        tuple(current["path"]),
                        status,
                        current["last"],
                        tuple(current["details"]),
                    )
                )

        for row in rows:
            if row["player"] != player:
                finish()
                player, current = row["player"], None
            parsed = json.loads(row["params"]) if row["params"] else {}
            if current is None:
                if matches(origin, row["name"], parsed):
                    current = {
                        "player": player,
                        "path": [],
                        "details": [],
                        "status": None,
                        "t0": row["ts"],
                        "session": row["session"],
                        "last": row["client_ts"],
                    }
                continue
            if current["status"]:
                continue
            if window and row["ts"] - current["t0"] > window:
                current["status"] = "stopped"
                continue
            if by_session and row["session"] != current["session"]:
                continue
            if row["name"] in ignore:
                continue
            current["last"] = row["client_ts"]
            if matches(goal, row["name"], parsed):
                current["status"] = "reached"
                continue
            label = row["name"]
            seen.add(label)
            if label in split:
                value = parsed.get(split[label])
                label = f"{label} · {split[label]}={value}" if value is not None else label
            if collapse and current["path"] and current["path"][-1] == label:
                continue
            shown = [
                f"{key}={_short(parsed[key])}"
                for key in chosen.get(row["name"], [])
                if key in parsed and key != split.get(row["name"])
            ]
            current["path"].append(label)
            current["details"].append(", ".join(shown))
            if len(current["path"]) >= depth:
                current["status"] = "continued"
        finish()
    meta = {
        "detail_params": [
            {
                "event": event,
                "params": [
                    {"key": key, "distinct": distinct, "on": key in chosen.get(event, [])}
                    for key, (distinct, _) in sorted(stats[event].items())
                ],
            }
            for event in sorted((seen & stats.keys()) - SDK_EVENTS)
        ]
    }
    return paths, origin, goal, meta


def _node(kind, layer, label=""):
    return f"{kind}:{layer}:{label}"


def _route_graph(paths, depth, per_layer):
    """Layered graph of the routes: nodes per hop, top labels kept, the rest grouped as Other."""
    counts = [Counter() for _ in range(depth + 1)]
    for _, path, _, _, _ in paths:
        for layer, label in enumerate(path, start=1):
            counts[layer][label] += 1
    keep = [{label for label, _ in layer.most_common(per_layer)} for layer in counts]
    sequences = []
    for player, path, status, last, details in paths:
        nodes = [_node("start", 0)]
        for layer, label in enumerate(path, start=1):
            nodes.append(_node("event", layer, label if label in keep[layer] else OTHER))
        end_layer = len(path) + 1
        nodes.append(_node(status, end_layer))
        sequences.append((player, path, status, last, details, nodes))
    node_players, link_players, labels = Counter(), Counter(), {}
    for _, _, _, _, _, nodes in sequences:
        for node in nodes:
            node_players[node] += 1
        for source, target in zip(nodes, nodes[1:], strict=False):
            link_players[(source, target)] += 1
    names = {"start": "Start", "reached": "Reached the end", "stopped": "Stopped here"}
    names["continued"] = "Kept going"
    for node in node_players:
        kind, _, label = node.split(":", 2)
        labels[node] = names.get(kind, label)
    return sequences, node_players, link_players, labels


def _top_values(counter, limit=4):
    return [{"text": text, "players": count} for text, count in counter.most_common(limit) if text]


def routes(storage, game_id, start, end, query):
    """Sankey data (nodes and links) and the most common whole routes between two steps."""
    paths, origin, goal, meta = _route_paths(storage, game_id, start, end, query)
    sequences, node_players, link_players, labels = _route_graph(
        paths, query["max_depth"], query["per_layer"]
    )
    node_values = {}
    for _, _, _, _, details, nodes in sequences:
        for node, detail in zip(nodes[1:], details, strict=False):
            node_values.setdefault(node, Counter())[detail] += 1
    nodes = []
    ordered = sorted(
        node_players.items(), key=lambda item: (int(item[0].split(":", 2)[1]), -item[1])
    )
    for node, count in ordered:
        kind, layer, _ = node.split(":", 2)
        nodes.append(
            {
                "id": node,
                "kind": kind,
                "layer": int(layer),
                "label": labels[node],
                "players": count,
                "values": _top_values(node_values.get(node, Counter())),
            }
        )
    links = [
        {"source": source, "target": target, "players": count}
        for (source, target), count in link_players.most_common()
    ]
    total = len(paths)
    whole = Counter((path, status) for _, path, status, _, _ in paths)
    step_values = {}
    for _, path, status, _, details in paths:
        counters = step_values.setdefault((path, status), [Counter() for _ in path])
        for counter, detail in zip(counters, details, strict=False):
            counter[detail] += 1
    top = [
        {
            "path": list(path),
            "status": status,
            "players": count,
            "percent": round(100 * count / total, 1),
            "values": [_top_values(counter) for counter in step_values[(path, status)]],
        }
        for (path, status), count in whole.most_common(TOP_ROUTES)
    ]
    statuses = Counter(status for _, _, status, _, _ in paths)
    exits = Counter(
        path[-1] if path else START_EXIT for _, path, status, _, _ in paths if status == "stopped"
    )
    return {
        "from": origin,
        "to": goal,
        "started": total,
        "reached": statuses["reached"],
        "stopped": statuses["stopped"],
        "continued": statuses["continued"],
        "distinct_routes": len(whole),
        "nodes": nodes,
        "links": links,
        "top_routes": top,
        "exits": [
            {
                "label": label,
                "players": count,
                "percent": round(100 * count / total, 1),
                "percent_of_stopped": round(100 * count / statuses["stopped"], 1),
            }
            for label, count in exits.most_common(TOP_EXITS)
        ],
        **meta,
    }


def route_players(storage, game_id, start, end, query):
    """Players on a node, a link, an exit or a whole route of the routes graph, latest first."""
    paths, _, _, _ = _route_paths(storage, game_id, start, end, query)
    sequences, _, _, _ = _route_graph(paths, query["max_depth"], query["per_layer"])
    target = query["target"]
    chosen = []
    for player, path, status, last, details, nodes in sequences:
        if target.get("node"):
            hit = target["node"] in nodes
        elif target.get("link"):
            source, destination = target["link"]
            hit = any(
                a == source and b == destination for a, b in zip(nodes, nodes[1:], strict=False)
            )
        elif target.get("exit") is not None:
            last_event = path[-1] if path else START_EXIT
            hit = status == "stopped" and last_event == target["exit"]
        elif target.get("route") is not None:
            hit = list(path) == target["route"] and status == target.get("status")
        else:
            hit = False
        if hit:
            chosen.append(
                {
                    "player": player,
                    "status": status,
                    "last_seen": last,
                    "route": list(path),
                    "details": list(details),
                }
            )
    chosen.sort(key=lambda item: item["last_seen"], reverse=True)
    return {"total": len(chosen), "players": chosen[:ROUTE_PLAYERS]}


def players(storage, game_id, start, end, filters=None, search="", limit=50, offset=0):
    """Players active in the range, most recently seen first."""
    storage.get_game(game_id)
    condition, args = where(start, end, filters)
    having, extra = "", ()
    if search:
        having, extra = "HAVING player LIKE ?", (f"%{search}%",)
    with storage.connect(storage.game_path(game_id)) as connection:
        total = connection.execute(
            f"SELECT count(*) FROM (SELECT {PLAYER} AS player FROM events WHERE {condition} "
            f"GROUP BY player {having})",
            (*args, *extra),
        ).fetchone()[0]
        rows = connection.execute(
            f"""SELECT {PLAYER} AS player, count(*) AS events,
                       count(DISTINCT {SESSION}) AS sessions,
                       min(client_ts) AS first_seen, max(client_ts) AS last_seen,
                       max(json_extract(payload, '$.platform')) AS platform,
                       max(json_extract(payload, '$.app_version')) AS app_version,
                       max(json_extract(payload, '$.country')) AS country,
                       max({ENVIRONMENT}) AS environment,
                       max(json_extract(payload, '$.user_id') IS NOT NULL) AS has_user_id
                FROM events WHERE {condition} GROUP BY player {having}
                ORDER BY last_seen DESC LIMIT ? OFFSET ?""",
            (*args, *extra, limit, offset),
        )
        return {"total": total, "players": [dict(row) for row in rows]}


def journey(storage, game_id, player, start, end):
    """Every event of one player in the range, in game-time order (filters don't apply)."""
    storage.get_game(game_id)
    condition, args = where(start, end)
    with storage.connect(storage.game_path(game_id)) as connection:
        rows = connection.execute(
            f"""SELECT name, client_ts, server_ts, payload, {ENVIRONMENT} AS environment
                FROM events WHERE {condition} AND {PLAYER}=?
                ORDER BY client_ts, event_id LIMIT ?""",
            (*args, player, MAX_JOURNEY_EVENTS + 1),
        ).fetchall()
    events = []
    for row in rows[:MAX_JOURNEY_EVENTS]:
        payload = json.loads(row["payload"])
        params = {
            key: value
            for key, value in (payload.get("params") or {}).items()
            if key not in HIDDEN_PARAMS
        }
        events.append(
            {
                "name": row["name"],
                "client_ts": row["client_ts"],
                "server_ts": row["server_ts"],
                "session_id": payload.get("session_id"),
                "params": params,
                "app_version": payload.get("app_version"),
                "build": payload.get("build"),
                "platform": payload.get("platform"),
                "country": payload.get("country"),
                "environment": row["environment"],
            }
        )
    return {"player": player, "events": events, "truncated": len(rows) > MAX_JOURNEY_EVENTS}


def saved_funnels(storage, game_id):
    storage.get_game(game_id)
    with storage.connect(storage.game_path(game_id)) as connection:
        return [
            {"id": row["id"], "name": row["name"], "updated_at": row["updated_at"]}
            | json.loads(row["definition"])
            for row in connection.execute("SELECT * FROM funnels ORDER BY name COLLATE NOCASE")
        ]


def save_funnel(storage, game_id, funnel_id, saved):
    storage.get_game(game_id)
    funnel_id = funnel_id or str(uuid4())
    definition = {key: value for key, value in saved.items() if key != "name"}
    with storage.connect(storage.game_path(game_id)) as connection:
        connection.execute(
            """INSERT INTO funnels VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
               name=excluded.name, definition=excluded.definition,
               updated_at=excluded.updated_at""",
            (funnel_id, saved["name"], json.dumps(definition), timestamp()),
        )
    return {"id": funnel_id, **saved}


def delete_funnel(storage, game_id, funnel_id):
    storage.get_game(game_id)
    with storage.connect(storage.game_path(game_id)) as connection:
        if connection.execute("DELETE FROM funnels WHERE id=?", (funnel_id,)).rowcount == 0:
            raise HTTPException(404, "Funnel not found")
