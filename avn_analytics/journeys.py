"""Readable player stories, journeys of many players, and per-level progress.

Built on the same live event queries as insights.py, but everything is named in plain words
(see stories.py) and long runs of level events are folded into one line.
"""

import json
import re
import threading
import time
from collections import Counter
from statistics import median

from fastapi import HTTPException

from . import stories
from .insights import (
    ENVIRONMENT,
    IDENTIFIED,
    MAX_FUNNEL_EVENTS,
    PLAYER,
    SESSION,
    _AverageSessionLength,
    matches,
    where,
)

TOP_JOURNEYS = 40
TOP_EXITS = 25
JOURNEY_PLAYERS = 200
MAX_PLAYER_EVENTS = 3000
MAX_SIGNATURE = 14
START_EXIT = "__start__"
# Events counted as power-ups on a level: any event with one of these in its name that also
# carries a level number (a parameter with "level" in its name, e.g. LEVEL_NUMBER).
POWERUP_NAME = re.compile(r"power.?up|booster|boost", re.I)
# The groups of players behind one level's numbers (see level_players).
LEVEL_GROUPS = (
    "total_drop",
    "left",
    "finished_stopped",
    "kept_going",
    "unknown_progress",
    "stuck",
    "started",
    "returning",
    "missing_history",
)
LEVEL_PLAYER_SORTS = ("exit_at", "tries", "fails")
# Whose levels to count: everyone active in the range, or new players within their first session.
LEVEL_SCOPES = ("all", "first_session")
STUCK_TRIES = 3
LAST_ACTIONS = 8
# Not something the player did: SDK bookkeeping and the app going to the background.
NOT_AN_ACTION = {"session_start", "session_end", "first_open", "APP_ANALYSIS"}
AD_EVENT = re.compile(r"^ads?(_|$)", re.I)
# The filters that decide whether a player's earlier history counts (the rest pick the cohort).
HISTORY_FILTERS = ("environments", "exclude_environments", "platforms")
LEVEL_CACHE_SECONDS = 60
LEVEL_CACHE_ENTRIES = 12
_level_cache = {}
_level_cache_lock = threading.Lock()


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
        latest_info = connection.execute(
            f"""SELECT client_ts, payload, {ENVIRONMENT} AS environment
                FROM events WHERE {PLAYER}=? ORDER BY client_ts DESC, event_id DESC LIMIT 1""",
            (player,),
        ).fetchone()
        latest_profile = connection.execute(
            f"""SELECT client_ts, json_extract(payload, '$.params') AS params
                FROM events WHERE {PLAYER}=? AND name='session_start'
                ORDER BY client_ts DESC, event_id DESC LIMIT 1""",
            (player,),
        ).fetchone()
    events = [
        {
            "name": row["name"],
            "client_ts": row["client_ts"],
            "session_id": row["session_id"],
            "params": json.loads(row["params"] or "{}"),
            "app_version": row["app_version"],
        }
        for row in rows
    ]
    shown = events
    chapters = stories.story(shown, labeler, show_hidden)
    last = rows[-1] if rows else None
    latest_payload = json.loads(latest_info["payload"]) if latest_info else {}
    profile = json.loads(latest_profile["params"] or "{}") if latest_profile else {}
    total_play_seconds = round(sum(chapter["seconds"] for chapter in chapters), 1)
    levels = [
        segment
        for chapter in chapters
        for segment in chapter["segments"]
        if segment["type"] == "levels"
    ]
    reached = max((s["last_level"] for s in levels), default=None)
    return {
        "player": player,
        "events": len(shown),
        "sessions": len(chapters),
        "first_seen": shown[0]["client_ts"] if shown else None,
        "last_seen": shown[-1]["client_ts"] if shown else None,
        "highest_level": reached,
        "country": last["country"] if last else None,
        "app_version": last["app_version"] if last else None,
        "platform": last["platform"] if last else None,
        "environment": last["environment"] if last else None,
        "total_play_seconds": total_play_seconds,
        "average_session_seconds": round(total_play_seconds / len(chapters), 1)
        if chapters
        else None,
        "info": {
            "user_id": latest_payload.get("user_id"),
            "device_id": latest_payload.get("device_id"),
            "app_version": latest_payload.get("app_version"),
            "build": latest_payload.get("build"),
            "platform": latest_payload.get("platform"),
            "environment": latest_info["environment"] if latest_info else None,
            "country": latest_payload.get("country"),
            "updated_at": latest_info["client_ts"] if latest_info else None,
            "profile_updated_at": latest_profile["client_ts"] if latest_profile else None,
            "properties": profile,
        },
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
                       json_extract(payload, '$.params') AS params,
                       json_extract(payload, '$.app_version') AS app_version
                FROM events WHERE {condition} AND {IDENTIFIED}
                ORDER BY player, client_ts, event_id""",
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
                "app_version": row["app_version"],
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


def _history_filters(filters):
    return {key: value for key, value in (filters or {}).items() if key in HISTORY_FILTERS}


def _first_sessions(connection, start, end, filters):
    """New players in their first session, as (player, rows, latest).

    A new player's first event is in the range and matches the filters; rows are the events of
    the session that event belongs to, and latest is the player's last event up to the range end
    (so a later session shows they came back).
    """
    condition, args = where(start, end, filters)
    history, history_args = where("0001-01-01", end, _history_filters(filters))
    rows = connection.execute(
        f"""WITH firsts AS (
                SELECT {PLAYER} AS player, min(client_ts) AS first_ts FROM events
                WHERE {history} AND {IDENTIFIED}
                GROUP BY {PLAYER} HAVING first_ts>=?
            ),
            selected AS (SELECT event_id FROM events WHERE {condition} AND {IDENTIFIED})
            SELECT {PLAYER} AS player, {SESSION} AS session_id, event_id, name, client_ts,
                   unixepoch(client_ts, 'subsec') AS ts,
                   json_extract(payload, '$.params') AS params,
                   json_extract(payload, '$.params.duration_seconds') AS duration_seconds,
                   json_extract(payload, '$.app_version') AS app_version,
                   json_extract(payload, '$.country') AS country,
                   event_id IN (SELECT event_id FROM selected) AS selected
            FROM events WHERE {history} AND {IDENTIFIED}
              AND {PLAYER} IN (SELECT player FROM firsts)
            ORDER BY player, client_ts, event_id LIMIT ?""",
        (*history_args, start, *args, *history_args, MAX_FUNNEL_EVENTS + 1),
    )

    def first_session(player, events):
        if events and events[0]["selected"]:
            session = events[0]["session_id"]
            return player, [row for row in events if row["session_id"] == session], events[-1]
        return None

    player, events = None, []
    for count, row in enumerate(rows, 1):
        if count > MAX_FUNNEL_EVENTS:
            raise HTTPException(400, "Too many events in this range. Pick fewer days.")
        if row["player"] != player:
            if found := first_session(player, events):
                yield found
            player, events = row["player"], []
        events.append(row)
    if found := first_session(player, events):
        yield found


def _check_scope(scope):
    if scope not in LEVEL_SCOPES:
        raise HTTPException(400, "Unknown scope")


def level_progress(storage, game_id, start, end, filters=None, scope="all"):
    """Per level: who started, who finished, tries, fails, time, power-ups, where players quit.

    scope "first_session" counts only new players, within their first session.
    """
    storage.get_game(game_id)
    _check_scope(scope)
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
                "other": Counter(),
            },
        )

    with storage.connect(storage.game_path(game_id)) as connection:
        anonymous_events = connection.execute(
            f"SELECT count(*) FROM events WHERE {condition} AND NOT ({IDENTIFIED})", args
        ).fetchone()[0]
        total = connection.execute(
            f"SELECT count(*) FROM events WHERE {condition} AND {IDENTIFIED}", args
        ).fetchone()[0]
        if total > MAX_FUNNEL_EVENTS:
            raise HTTPException(400, "Too many events in this range. Pick fewer days.")
        if scope == "first_session":
            rows = (
                row
                for _, session, _ in _first_sessions(connection, start, end, filters)
                for row in session
            )
        else:
            rows = connection.execute(
                f"""SELECT {PLAYER} AS player, {SESSION} AS session_id, name,
                           unixepoch(client_ts, 'subsec') AS ts,
                           json_extract(payload, '$.params') AS params,
                           json_extract(payload, '$.app_version') AS app_version
                    FROM events WHERE {condition} AND {IDENTIFIED}
                    ORDER BY player, client_ts, event_id""",
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
            info = labeler.level_info(row["name"], params, row["app_version"])
            if info is None:
                for key, value in params.items():
                    number = stories._int(value) if stories.LEVELISH_KEY.search(key) else None
                    if number is not None:
                        bucket = "powerups" if POWERUP_NAME.search(row["name"]) else "other"
                        entry(number)[bucket][
                            labeler.label(row["name"], params, row["app_version"])
                        ] += 1
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
                opened[number] = (row["ts"], row["session_id"])
            elif verb == "completed":
                item["completed"].add(row["player"])
                item["completions"] += 1
                began = opened.pop(number, None)
                if began and began[1] == row["session_id"] and 0 <= row["ts"] - began[0] <= 3600:
                    item["seconds"].append(row["ts"] - began[0])
            elif verb == "failed":
                item["fails"] += 1
        close_player()
    transitions = _level_transitions(storage, game_id, start, end, filters, scope)
    result = []
    threshold = storage.analytics_thresholds(game_id)["levels_min_players"]
    for number in sorted(levels):
        item = levels[number]
        started = len(item["started"])
        if not started:
            # Only finishes or other events carrying this level number (an ad or menu sent with
            # LEVEL=0, say): nobody played it, so it is not a row.
            continue
        transition = transitions.get(number, {}).get("summary")
        completed = transition["matched_completed"] if transition else 0
        seconds = item["seconds"]
        result.append(
            {
                "level": number,
                "started": started,
                "completed": completed,
                "observed_completed": len(item["completed"]),
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
                "other_events": sum(item["other"].values()),
                "top_other": [
                    {"text": text, "count": count} for text, count in item["other"].most_common(3)
                ],
                "low_sample": started < threshold,
                "transition": transition,
            }
        )
    return {
        "levels": result,
        "context": {
            "anonymous_events": anonymous_events,
            "minimum_players": threshold,
            "low_sample_levels": sum(1 for item in result if item["low_sample"]),
            "transition_basis": "Selected starters, followed across versions until range end"
            if scope == "all"
            else "New players, within their first session",
            "scope": scope,
        },
    }


def _last_action(events, index, labeler):
    """What the player did last in the session of events[index], from that event on.

    A session whose last app event sent the app to the background because of an ad is put down to
    that ad, even when the game logged the ad just before the level start.
    """
    session = events[index][0]["session_id"]
    end = last = index
    while end + 1 < len(events) and events[end + 1][0]["session_id"] == session:
        end += 1
        row = events[end][0]
        if row["name"] not in NOT_AN_ACTION and not labeler.hidden(row["name"]):
            last = end

    def read(position):
        row = events[position][0]
        return row, json.loads(row["params"]) if row["params"] else {}

    for position in range(end, last, -1):
        row, params = read(position)
        if row["name"] != "APP_ANALYSIS":
            continue
        if stories.param_text(params, "STATE") == "Background" and (
            stories.param_text(params, "CAUSE") == "Ad"
        ):
            for earlier in range(position - 1, -1, -1):
                ad, ad_params = read(earlier)
                if ad["session_id"] != session:
                    break
                if AD_EVENT.match(ad["name"]):
                    return stories.action_text(labeler, ad["name"], ad_params, ad["app_version"])
            return "Left during an ad"
        break  # the app was last in the foreground, or left for another reason
    row, params = read(last)
    return stories.action_text(labeler, row["name"], params, row["app_version"])


def _level_transitions(storage, game_id, start, end, filters, scope="all"):
    """Match selected starters to subsequent progress, retaining historical entry context.

    scope "first_session" follows new players within their first session only.
    """
    labeler = stories.Labeler(_definitions(storage, game_id))
    condition, args = where(start, end, filters)
    history_condition, history_args = where("0001-01-01", end, _history_filters(filters))
    levels = {}
    observed_starts = set()

    def entry(number):
        return levels.setdefault(number, {name: [] for name in LEVEL_GROUPS})

    def finish(player, events, latest=None):
        if not events:
            return
        latest = latest or events[-1][0]
        session_lengths = {}
        for row, _ in events:
            length = session_lengths.setdefault(row["session_id"], _AverageSessionLength())
            length.step(row["session_id"], row["name"], row["duration_seconds"], row["client_ts"])
        selected_starts = {}
        first_starts = {}
        for index, (row, info) in enumerate(events):
            if info and info[0] in ("started", "restarted"):
                first_starts.setdefault(info[1], index)
                observed_starts.add(info[1])
                if row["selected"] or scope == "first_session":
                    selected_starts.setdefault(info[1], index)
        for number, began in selected_starts.items():
            initial = events[began][0]
            progress = [
                (index, row, info)
                for index, (row, info) in enumerate(events)
                if row["client_ts"] >= initial["client_ts"] and info
            ]
            own = [(index, row, info) for index, row, info in progress if info[1] == number]
            completed = any(info[0] == "completed" for _, _, info in own)
            continued = any(
                info[1] == number + 1 and info[0] in ("started", "restarted")
                for index, row, info in progress
                if row["client_ts"] >= initial["client_ts"]
            )
            higher = any(info[1] > number for index, row, info in progress)
            tries = sum(info[0] in ("started", "restarted") for _, _, info in own)
            fails = sum(info[0] == "failed" for _, _, info in own)
            last_index, last, _ = own[-1]
            record = {
                "player": player,
                "tries": tries,
                "fails": fails,
                "completed": completed,
                "exit_at": last["client_ts"],
                "exit_event": last["event_id"],
                "last_action": _last_action(events, last_index, labeler),
                "session_seconds": round(session_lengths[last["session_id"]].finalize(), 1),
                "last_seen": latest["client_ts"],
                # Any later session counts, even the same day.
                "came_back": latest["client_ts"] > last["client_ts"]
                and latest["session_id"] != last["session_id"],
                "app_version": latest["app_version"],
                "start_version": initial["app_version"],
                "country": latest["country"],
                "history": "Observed start",
            }
            groups = entry(number)
            groups["started"].append(record)
            if continued:
                groups["kept_going"].append(record)
            else:
                groups["total_drop"].append(record)
                category = (
                    "unknown_progress" if higher else "finished_stopped" if completed else "left"
                )
                groups[category].append(record)
            if not completed and not higher and (tries >= STUCK_TRIES or fails >= STUCK_TRIES):
                groups["stuck"].append(record)
            previous = selected_starts.get(number - 1)
            if number <= 0 or (
                previous is not None and events[previous][0]["client_ts"] <= initial["client_ts"]
            ):
                continue
            prior = events[:began]
            recorded_history = first_starts.get(number - 1, began) < began or any(
                row["client_ts"] < start
                or (
                    row["app_version"]
                    and initial["app_version"]
                    and row["app_version"] != initial["app_version"]
                )
                or (info and info[1] < number)
                for row, info in prior
            )
            category = "returning" if recorded_history else "missing_history"
            entrant = {
                **record,
                "history": (
                    "Earlier activity recorded; outside the previous start cohort"
                    if recorded_history
                    else "Earlier level history unavailable; install or upgrade is unknown"
                ),
            }
            if number > 1:
                record["history"] = entrant["history"]
                record["entry_context"] = category
            entry(number - 1)[category].append(entrant)

    def read(row):
        params = json.loads(row["params"]) if row["params"] else {}
        return row, labeler.level_info(row["name"], params, row["app_version"])

    with storage.connect(storage.game_path(game_id)) as connection:
        if scope == "first_session":
            for player, session, latest in _first_sessions(connection, start, end, filters):
                finish(player, [read(row) for row in session], latest)
        else:
            rows = connection.execute(
                f"""WITH selected AS (
                        SELECT event_id, {PLAYER} AS player FROM events
                        WHERE {condition} AND {IDENTIFIED}
                    )
                    SELECT {PLAYER} AS player, {SESSION} AS session_id, event_id, name,
                           client_ts,
                           json_extract(payload, '$.params') AS params,
                           json_extract(payload, '$.params.duration_seconds') AS duration_seconds,
                           json_extract(payload, '$.app_version') AS app_version,
                           json_extract(payload, '$.country') AS country,
                           event_id IN (SELECT event_id FROM selected) AS selected
                    FROM events
                    WHERE {history_condition} AND {IDENTIFIED}
                      AND {PLAYER} IN (SELECT player FROM selected)
                    ORDER BY player, client_ts, event_id
                    LIMIT ?""",
                (*args, *history_args, MAX_FUNNEL_EVENTS + 1),
            )
            player, events = None, []
            for count, row in enumerate(rows, 1):
                if count > MAX_FUNNEL_EVENTS:
                    raise HTTPException(400, "Too much player history. Pick fewer players or days.")
                if row["player"] != player:
                    finish(player, events)
                    player, events = row["player"], []
                events.append(read(row))
            finish(player, events)
    result = {}
    for number, groups in levels.items():
        started = len(groups["started"])
        available = number + 1 in observed_starts and started > 0
        counts = {name: len(members) for name, members in groups.items()}
        result[number] = {
            "groups": groups,
            "summary": {
                **counts,
                "next_level": number + 1,
                "available": available,
                "drop_percent": round(100 * counts["total_drop"] / started, 1)
                if available
                else None,
                "matched_completed": sum(row["completed"] for row in groups["started"]),
                "entrants": counts["returning"] + counts["missing_history"],
                "starters_returning": sum(
                    row.get("entry_context") == "returning" for row in groups["started"]
                ),
                "starters_missing_history": sum(
                    row.get("entry_context") == "missing_history" for row in groups["started"]
                ),
                "net_change": len(levels.get(number + 1, {}).get("started", [])) - started
                if available
                else None,
            },
        }
    return result


def _scan_level(storage, game_id, start, end, filters, level, scope="all"):
    transitions = _level_transitions(storage, game_id, start, end, filters, scope)
    return transitions.get(level, {}).get("groups", {name: [] for name in LEVEL_GROUPS})


def level_players(
    storage,
    game_id,
    start,
    end,
    filters,
    level,
    group="total_drop",
    offset=0,
    limit=50,
    sort="exit_at",
    scope="all",
    last_action=None,
):
    """The players in one group of one level (see _scan_level), plus the size of every group.

    last_actions counts what the group's players did last on the level; last_action keeps only
    the players whose last action was that one. The scan is cached for a minute so switching
    groups, pages or last actions doesn't read the events again.
    """
    storage.get_game(game_id)
    if group not in LEVEL_GROUPS:
        raise HTTPException(400, "Unknown group")
    if sort not in LEVEL_PLAYER_SORTS:
        raise HTTPException(400, "Unknown sort")
    _check_scope(scope)
    key = (
        str(storage.game_path(game_id)),
        start,
        end,
        json.dumps(filters or {}, sort_keys=True),
        level,
        scope,
    )
    now = time.monotonic()
    with _level_cache_lock:
        cached = _level_cache.get(key)
    if cached is None or now - cached[0] > LEVEL_CACHE_SECONDS:
        groups = _scan_level(storage, game_id, start, end, filters, level, scope)
        with _level_cache_lock:
            _level_cache[key] = (now, groups)
            for stale in sorted(_level_cache, key=lambda item: _level_cache[item][0])[
                : max(0, len(_level_cache) - LEVEL_CACHE_ENTRIES)
            ]:
                _level_cache.pop(stale, None)
    else:
        groups = cached[1]
    members = groups[group]
    last_actions = Counter(item["last_action"] for item in members)
    if last_action is not None:
        members = [item for item in members if item["last_action"] == last_action]
    members = sorted(
        members, key=lambda item: (item[sort], item["exit_at"], item["player"]), reverse=True
    )
    return {
        "level": level,
        "group": group,
        "counts": {name: len(items) for name, items in groups.items()},
        "last_actions": [
            {"text": text, "players": count}
            for text, count in sorted(last_actions.items(), key=lambda item: (-item[1], item[0]))[
                :LAST_ACTIONS
            ]
        ],
        "total": len(members),
        "offset": offset,
        "players": members[offset : offset + limit],
    }
