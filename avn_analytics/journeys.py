"""Readable player stories, journeys of many players, and per-level progress.

Built on the same live event queries as insights.py, but everything is named in plain words
(see stories.py) and long runs of level events are folded into one line.
"""

import json
from collections import Counter
from statistics import median

from fastapi import HTTPException

from . import stories
from .insights import (
    ENVIRONMENT,
    MAX_FUNNEL_EVENTS,
    PLAYER,
    SESSION,
    matches,
    where,
)

TOP_JOURNEYS = 40
TOP_EXITS = 25
JOURNEY_PLAYERS = 200
MAX_PLAYER_EVENTS = 3000
MAX_SIGNATURE = 14
START_EXIT = "__start__"


def _definitions(storage, game_id):
    return storage.get_dictionary(game_id)


def player_story(storage, game_id, player, start, end, show_hidden=False):
    """One player's events as chapters (sessions) of readable lines, plus a few totals."""
    storage.get_game(game_id)
    labeler = stories.Labeler(_definitions(storage, game_id))
    condition, args = where(start, end)
    with storage.connect(storage.game_path(game_id)) as connection:
        rows = connection.execute(
            f"""SELECT name, client_ts, {SESSION} AS session_id, {ENVIRONMENT} AS environment,
                       json_extract(payload, '$.params') AS params,
                       json_extract(payload, '$.country') AS country,
                       json_extract(payload, '$.app_version') AS app_version,
                       json_extract(payload, '$.platform') AS platform
                FROM events WHERE {condition} AND {PLAYER}=?
                ORDER BY client_ts, event_id LIMIT ?""",
            (*args, player, 20000),
        ).fetchall()
    events = [
        {
            "name": row["name"],
            "client_ts": row["client_ts"],
            "session_id": row["session_id"],
            "params": json.loads(row["params"] or "{}"),
        }
        for row in rows
    ]
    chapters = stories.story(events, labeler, show_hidden)
    last = rows[-1] if rows else None
    levels = [
        segment
        for chapter in chapters
        for segment in chapter["segments"]
        if segment["type"] == "levels"
    ]
    reached = max((s["last_level"] for s in levels), default=None)
    return {
        "player": player,
        "events": len(events),
        "sessions": len(chapters),
        "first_seen": rows[0]["client_ts"] if rows else None,
        "last_seen": last["client_ts"] if last else None,
        "highest_level": reached,
        "country": last["country"] if last else None,
        "app_version": last["app_version"] if last else None,
        "platform": last["platform"] if last else None,
        "environment": last["environment"] if last else None,
        "chapters": chapters,
    }


def _player_flows(storage, game_id, start, end, query):
    """Per player: the events between the start step and the end step, and how it ended."""
    steps = query["steps"]
    first, last = query.get("route_from", 1), query.get("route_to") or len(steps)
    if not 1 <= first < last <= len(steps):
        raise HTTPException(400, "Choose a start step that comes before the end step.")
    origin, goal = steps[first - 1], steps[last - 1]
    condition, args = where(start, end, query.get("filters"))
    window = query["window_hours"] * 3600 if query.get("window_hours") else None
    one_session = query.get("span", "session") == "session"
    ignore = set(query.get("ignore") or [])
    labeler = stories.Labeler(_definitions(storage, game_id))
    flows = []
    with storage.connect(storage.game_path(game_id)) as connection:
        total = connection.execute(
            f"SELECT count(*) FROM events WHERE {condition}", args
        ).fetchone()[0]
        if total > MAX_FUNNEL_EVENTS:
            raise HTTPException(400, "Too many events in this range. Pick fewer days.")
        rows = connection.execute(
            f"""SELECT {PLAYER} AS player, {SESSION} AS session, name, client_ts,
                       unixepoch(client_ts, 'subsec') AS ts,
                       json_extract(payload, '$.params') AS params
                FROM events WHERE {condition} ORDER BY player, client_ts, event_id""",
            args,
        )
        current, player = None, None

        def finish():
            if current is not None:
                flows.append(current)

        for row in rows:
            if row["player"] != player:
                finish()
                player, current = row["player"], None
            parsed = json.loads(row["params"]) if row["params"] else {}
            event = {
                "name": row["name"],
                "client_ts": row["client_ts"],
                "session_id": row["session"],
                "params": parsed,
            }
            if current is None:
                if matches(origin, row["name"], parsed):
                    current = {
                        "player": player,
                        "events": [],
                        "status": None,
                        "t0": row["ts"],
                        "session": row["session"],
                        "started": row["client_ts"],
                        "last": row["client_ts"],
                    }
                continue
            if current["status"]:
                continue
            if window and row["ts"] - current["t0"] > window:
                current["status"] = "stopped"
                continue
            if one_session and row["session"] != current["session"]:
                continue
            if row["name"] in ignore:
                continue
            current["last"] = row["client_ts"]
            if matches(goal, row["name"], parsed):
                current["status"] = "reached"
                continue
            current["events"].append(event)
            if len(current["events"]) >= MAX_PLAYER_EVENTS:
                current["status"] = "continued"
        finish()
    results = []
    for flow in flows:
        chapters = stories.story(flow["events"], labeler)
        signature = stories.story_signature(chapters, one_session)
        shown = signature[:MAX_SIGNATURE] + (("…",) if len(signature) > MAX_SIGNATURE else ())
        segments = [segment for chapter in chapters for segment in chapter["segments"]]
        results.append(
            {
                "player": flow["player"],
                "status": flow["status"] or "stopped",
                "last": flow["last"],
                "signature": shown,
                "exit": segments[-1].get("exit") if segments else None,
                "line": " → ".join(segment["text"] for segment in segments[:6]),
            }
        )
    return results, origin, goal


def journeys(storage, game_id, start, end, query):
    """Players grouped by the shape of what they did between two funnel steps."""
    storage.get_game(game_id)
    flows, origin, goal = _player_flows(storage, game_id, start, end, query)
    total = len(flows)
    groups = Counter((flow["signature"], flow["status"]) for flow in flows)
    statuses = Counter(flow["status"] for flow in flows)
    exits = Counter(flow["exit"] or START_EXIT for flow in flows if flow["status"] == "stopped")
    return {
        "from": origin,
        "to": goal,
        "started": total,
        "reached": statuses["reached"],
        "stopped": statuses["stopped"],
        "continued": statuses["continued"],
        "distinct": len(groups),
        "journeys": [
            {
                "steps": list(signature),
                "status": status,
                "players": count,
                "percent": round(100 * count / total, 1),
            }
            for (signature, status), count in groups.most_common(TOP_JOURNEYS)
        ],
        "exits": [
            {
                "label": label,
                "players": count,
                "percent": round(100 * count / total, 1),
                "percent_of_stopped": round(100 * count / statuses["stopped"], 1),
            }
            for label, count in exits.most_common(TOP_EXITS)
        ],
    }


def journey_players(storage, game_id, start, end, query):
    """The players behind one journey or one exit, latest first."""
    storage.get_game(game_id)
    flows, _, _ = _player_flows(storage, game_id, start, end, query)
    target = query["target"]
    chosen = []
    for flow in flows:
        if target.get("exit") is not None:
            hit = flow["status"] == "stopped" and (flow["exit"] or START_EXIT) == target["exit"]
        elif target.get("steps") is not None:
            hit = list(flow["signature"]) == target["steps"] and flow["status"] == target.get(
                "status"
            )
        else:
            hit = False
        if hit:
            chosen.append(
                {
                    "player": flow["player"],
                    "status": flow["status"],
                    "last_seen": flow["last"],
                    "line": flow["line"],
                }
            )
    chosen.sort(key=lambda item: item["last_seen"], reverse=True)
    return {"total": len(chosen), "players": chosen[:JOURNEY_PLAYERS]}


def _percentile(values, share):
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(share * len(ordered)))]


def level_progress(storage, game_id, start, end, filters=None):
    """Per level: who started, who finished, tries, fails, time, power-ups, where players quit."""
    storage.get_game(game_id)
    labeler = stories.Labeler(_definitions(storage, game_id))
    condition, args = where(start, end, filters)
    levels = {}

    def entry(number):
        return levels.setdefault(
            number,
            {
                "level": number,
                "started": set(),
                "completed": set(),
                "attempts": 0,
                "completions": 0,
                "fails": 0,
                "restarts": 0,
                "seconds": [],
                "quit": 0,
                "powerups": Counter(),
            },
        )

    with storage.connect(storage.game_path(game_id)) as connection:
        total = connection.execute(
            f"SELECT count(*) FROM events WHERE {condition}", args
        ).fetchone()[0]
        if total > MAX_FUNNEL_EVENTS:
            raise HTTPException(400, "Too many events in this range. Pick fewer days.")
        rows = connection.execute(
            f"""SELECT {PLAYER} AS player, {SESSION} AS session, name,
                       unixepoch(client_ts, 'subsec') AS ts,
                       json_extract(payload, '$.params') AS params
                FROM events WHERE {condition} ORDER BY player, client_ts, event_id""",
            args,
        )
        player, opened, last_level = None, {}, None

        def close_player():
            if last_level is not None and last_level[1] in ("started", "restarted", "failed"):
                entry(last_level[0])["quit"] += 1

        for row in rows:
            if row["player"] != player:
                close_player()
                player, opened, last_level = row["player"], {}, None
            params = json.loads(row["params"]) if row["params"] else {}
            info = labeler.level_info(row["name"], params)
            if info is None:
                for key, value in params.items():
                    number = stories._int(value) if stories.LEVELISH_KEY.search(key) else None
                    if number is not None:
                        entry(number)["powerups"][labeler.label(row["name"], params)] += 1
                        break
                continue
            verb, number = info
            item = entry(number)
            last_level = (number, verb)
            if verb in ("started", "restarted"):
                item["started"].add(row["player"])
                item["attempts"] += 1
                if verb == "restarted":
                    item["restarts"] += 1
                opened[number] = (row["ts"], row["session"])
            elif verb == "completed":
                item["completed"].add(row["player"])
                item["completions"] += 1
                began = opened.pop(number, None)
                if began and began[1] == row["session"] and 0 <= row["ts"] - began[0] <= 3600:
                    item["seconds"].append(row["ts"] - began[0])
            elif verb == "failed":
                item["fails"] += 1
        close_player()
    result = []
    for number in sorted(levels):
        item = levels[number]
        started, completed = len(item["started"]), len(item["completed"])
        seconds = item["seconds"]
        result.append(
            {
                "level": number,
                "started": started,
                "completed": completed,
                "completion": round(100 * completed / started, 1) if started else None,
                "attempts": item["attempts"],
                "tries_per_player": round(item["attempts"] / started, 2) if started else None,
                "fails": item["fails"],
                "restarts": item["restarts"],
                "median_seconds": round(median(seconds), 1) if seconds else None,
                "p90_seconds": round(_percentile(seconds, 0.9), 1) if seconds else None,
                "quit": item["quit"],
                "quit_percent": round(100 * item["quit"] / started, 1) if started else None,
                "powerups": sum(item["powerups"].values()),
                "top_powerups": [
                    {"text": text, "count": count}
                    for text, count in item["powerups"].most_common(3)
                ],
            }
        )
    return {"levels": result}
