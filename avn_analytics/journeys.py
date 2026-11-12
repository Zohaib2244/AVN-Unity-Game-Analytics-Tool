"""Readable player stories, journeys of many players, and per-level progress.

Built on the same live event queries as insights.py, but everything is named in plain words
(see stories.py) and long runs of level events are folded into one line.
"""

import json
import re
from bisect import bisect_left, bisect_right
from collections import Counter
from datetime import datetime
from statistics import median

from fastapi import HTTPException

from . import level_exits, stories
from .insights import (
    IDENTIFIED,
    MAX_FUNNEL_EVENTS,
    PLAYER,
    SDK_EVENTS,
    SESSION,
    matches,
    read_source,
    where,
)
from .session_state import SessionState

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
    "straight_on",
    "came_back_later",
    "unknown_progress",
    "stuck",
    "failed",
    "failed_left",
    "failed_kept_playing",
    "started",
    "returning",
    "missing_history",
)
LEVEL_PLAYER_SORTS = ("exit_at", "tries", "fails")
# Whose levels to count: everyone active in the range, or new players within their first session.
LEVEL_SCOPES = ("all", "first_session")
STUCK_TRIES = 3
LAUNCH_WITHIN = 6  # how far into the next session its Launch event can be
LAST_ACTIONS = 8
# Not something the player did: SDK bookkeeping and the app going to the background.
NOT_AN_ACTION = {"session_start", "session_end", "first_open", "APP_ANALYSIS"}
# The filters that decide whether a player's earlier history counts (the rest pick the cohort).
HISTORY_FILTERS = ("environments", "exclude_environments", "platforms", "exclude_platforms")


class _Reader:
    """What one scan remembers about each kind of event (name, raw parameters, version).

    Most events repeat the same name and parameters, so working out what one means (its level
    moment, the words for it) once per kind instead of once per event saves most of the time.
    The remembered values are shared and must not be changed.
    """

    def __init__(self, labeler):
        self.labeler = labeler
        self._params = {}
        self._levels = {}
        self._actions = {}
        self._texts = {}
        self._labels = {}

    def params(self, raw):
        found = self._params.get(raw)
        if found is None:
            found = self._params[raw] = json.loads(raw) if raw else {}
        return found

    def level(self, name, raw_params, app_version):
        """(params, level_info) of an event."""
        key = (name, raw_params, app_version)
        found = self._levels.get(key)
        if found is None:
            params = self.params(raw_params)
            found = self._levels[key] = (
                params,
                self.labeler.level_info(name, params, app_version),
            )
        return found

    def action(self, row):
        """stories.action_text of a row."""
        key = (row["name"], row["params"], row["app_version"])
        found = self._actions.get(key)
        if found is None:
            found = self._actions[key] = stories.action_text(
                self.labeler, row["name"], self.params(row["params"]), row["app_version"]
            )
        return found

    def label(self, row):
        """The labeler's label of a row."""
        key = (row["name"], row["params"], row["app_version"])
        found = self._labels.get(key)
        if found is None:
            found = self._labels[key] = self.labeler.label(
                row["name"], self.params(row["params"]), row["app_version"]
            )
        return found

    def text(self, row):
        """stories.event_text of a row."""
        key = (row["name"], row["params"])
        found = self._texts.get(key)
        if found is None:
            found = self._texts[key] = stories.event_text(row["name"], self.params(row["params"]))
        return found


def _definitions(storage, game_id):
    return storage.get_dictionary(game_id)


SNAPSHOT_EVENTS = {"device": "DEVICE_ANALYSIS"}


def player_story(storage, game_id, player, start, end, show_hidden=False):
    """One player's events as chapters (sessions) of readable lines, plus a few totals."""
    storage.get_game(game_id)
    labeler = stories.Labeler(_definitions(storage, game_id))
    with storage.connect(storage.game_path(game_id)) as connection:
        source = read_source(storage, connection)
        condition, args = where(start, end, source=source)
        table, value = source.table, source.envelope
        rows = connection.execute(
            f"""SELECT name, client_ts, server_ts, {source.session} AS session_id,
                       {source.environment} AS environment, {source.params} AS params,
                       {value("country")} AS country, {value("app_version")} AS app_version,
                       {value("platform")} AS platform
                FROM {table} WHERE {condition} AND {source.player}=?
                ORDER BY client_ts, event_id LIMIT ?""",
            (*args, player, 20000),
        ).fetchall()
        envelope = ("user_id", "device_id", "app_version", "build", "platform", "country")
        latest_info = connection.execute(
            f"""SELECT client_ts, {source.environment} AS environment,
                       {", ".join(f"{value(name)} AS {name}" for name in envelope)}
                FROM {table} WHERE {source.player}=?
                ORDER BY client_ts DESC, event_id DESC LIMIT 1""",
            (player,),
        ).fetchone()
        latest_profile = connection.execute(
            f"""SELECT client_ts, {source.params} AS params
                FROM {table} WHERE {source.player}=? AND name='session_start'
                ORDER BY client_ts DESC, event_id DESC LIMIT 1""",
            (player,),
        ).fetchone()
        # The game's own latest snapshot of the device (AVN events standard), whichever date
        # range is picked. The player's save is on the summary page (player_summary.py).
        snapshots = {}
        for key, name in SNAPSHOT_EVENTS.items():
            found = connection.execute(
                f"""SELECT client_ts, {source.params} AS params
                    FROM {table} WHERE {source.player}=? AND name=?
                      AND json_extract({source.params}, '$.STATE')='Snapshot'
                    ORDER BY client_ts DESC, event_id DESC LIMIT 1""",
                (player, name),
            ).fetchone()
            if found:
                values = json.loads(found["params"] or "{}")
                values.pop("STATE", None)
                values.pop("seq", None)
                snapshots[key] = {"at": found["client_ts"], "values": values}
    events = [
        {
            "name": row["name"],
            "client_ts": row["client_ts"],
            "server_ts": row["server_ts"],
            "session_id": row["session_id"],
            "params": json.loads(row["params"] or "{}"),
            "app_version": row["app_version"],
        }
        for row in rows
    ]
    shown = events
    chapters = stories.story(shown, labeler, show_hidden)
    last = rows[-1] if rows else None
    latest_payload = dict(latest_info) if latest_info else {}
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
            "snapshots": snapshots,
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


class _TooMuch(Exception):
    """A level scan would read more than MAX_FUNNEL_EVENTS rows: of the range, or of history."""

    def __init__(self, kind):
        super().__init__(kind)
        self.kind = kind


TOO_MUCH = {
    "range": "Too many events in this range. Pick fewer days.",
    "history": "Too much player history. Pick fewer players or days.",
}


def _level_columns(source):
    return f"""{source.player} AS player, {source.session} AS session_id, event_id, name,
               client_ts, server_ts, unixepoch(client_ts, 'subsec') AS ts,
               {source.params} AS params, {source.param("seq")} AS seq,
               {source.envelope("app_version")} AS app_version,
               {source.envelope("country")} AS country"""


def _first_sessions(connection, start, end, filters, source):
    """New players in their first session, as (player, rows, latest).

    A new player's first event is in the range and matches the filters; rows are the events of
    the session that event belongs to, and latest is the player's last event up to the range end
    (so a later session shows they came back).
    """
    condition, args = where(start, end, filters, source=source)
    history, history_args = where("0001-01-01", end, _history_filters(filters), source=source)
    table, player = source.table, source.player
    rows = connection.execute(
        f"""WITH firsts AS (
                SELECT {player} AS player, min(client_ts) AS first_ts FROM {table}
                WHERE {history} AND {source.identified}
                GROUP BY {player} HAVING first_ts>=?
            ),
            selected AS (SELECT event_id FROM {table} WHERE {condition} AND {source.identified})
            SELECT {_level_columns(source)},
                   event_id IN (SELECT event_id FROM selected) AS selected
            FROM {table} WHERE {history} AND {source.identified}
              AND {player} IN (SELECT player FROM firsts)
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
            raise _TooMuch("range")
        if row["player"] != player:
            if found := first_session(player, events):
                yield found
            player, events = row["player"], []
        events.append(row)
    if found := first_session(player, events):
        yield found


def _histories(connection, start, end, filters, source):
    """Every event of the players active in the range, up to its end, as (player, rows, None).

    A row is `selected` when it is in the range and passes every filter; the rest are the history
    that tells whether a player came from the previous level. History passes only the filters that
    say whether a player's events count at all (environment, platform; see HISTORY_FILTERS).
    """
    condition, args = where(start, end, filters, source=source)
    history, history_args = where("0001-01-01", end, _history_filters(filters), source=source)
    table, player = source.table, source.player
    rows = connection.execute(
        f"""WITH selected AS (
                SELECT event_id, {player} AS player FROM {table}
                WHERE {condition} AND {source.identified}
            )
            SELECT {_level_columns(source)},
                   event_id IN (SELECT event_id FROM selected) AS selected
            FROM {table}
            WHERE {history} AND {source.identified} AND {player} IN (SELECT player FROM selected)
            ORDER BY player, client_ts, event_id
            LIMIT ?""",
        (*args, *history_args, MAX_FUNNEL_EVENTS + 1),
    )
    player, events = None, []
    for count, row in enumerate(rows, 1):
        if count > MAX_FUNNEL_EVENTS:
            raise _TooMuch("history")
        if row["player"] != player:
            if events:
                yield player, events, None
            player, events = row["player"], []
        events.append(row)
    if events:
        yield player, events, None


LEVEL_BATCH = 200  # players whose facts are read per query


class BatchTooBig(ValueError):
    """player_rows read more than its row or byte allowance; retry with fewer players."""


def scanned_players(connection, start, end, filters, scope, until=None, max_players=None):
    """The players a facts level scan covers, in player order (before deciding who counts).

    scope "all": players with an identified event in the range that passes the filters.
    "first_session": players whose first event passing the history filters is in the range.
    until: only facts up to this id (a prepared answer's watermark).
    """
    from .insights import FACTS

    limit, limit_args = ("AND id<=?", [until]) if until is not None else ("", [])
    if scope == "first_session":
        history, args = where("0001-01-01", end, _history_filters(filters), source=FACTS)
        query = f"""SELECT player FROM analytics_facts WHERE {history} AND player IS NOT NULL
                    {limit} GROUP BY player HAVING min(client_ts)>=? ORDER BY player"""
        args = [*args, *limit_args, start]
    else:
        condition, args = where(start, end, filters, source=FACTS)
        query = f"""SELECT DISTINCT player FROM analytics_facts
                    WHERE {condition} AND player IS NOT NULL {limit} ORDER BY player"""
        args = [*args, *limit_args]
    if max_players is not None:
        query += " LIMIT ?"
        args = [*args, max_players + 1]
    players = [row[0] for row in connection.execute(query, args)]
    if max_players is not None and len(players) > max_players:
        raise ValueError("Prepared Levels exceeds the bounded player budget")
    return players


def player_rows(
    connection, players, start, end, filters, until=None, check=None, max_rows=None, max_bytes=None
):
    """(player, rows) for these players, read from their facts, in player order.

    rows are a player's events up to the range end that pass the history filters, in time order,
    each `selected` when it is in the range and passes every filter (see counted_rows for which
    of them a scan counts).
    """
    from .insights import FACTS

    condition, args = where(start, end, filters, source=FACTS)
    history, history_args = where("0001-01-01", end, _history_filters(filters), source=FACTS)
    limit, limit_args = ("AND id<=?", [until]) if until is not None else ("", [])
    read = 0
    used_bytes = 0
    for offset in range(0, len(players), LEVEL_BATCH):
        batch = players[offset : offset + LEVEL_BATCH]
        rows = connection.execute(
            f"""SELECT {_level_columns(FACTS)}, ({condition}) AS selected
                FROM analytics_facts
                WHERE player IN ({",".join("?" * len(batch))}) AND {history} {limit}
                ORDER BY player, client_ts, event_id""",
            (*args, *batch, *history_args, *limit_args),
        )
        player, events = None, []
        for row in rows:
            read += 1
            if check and read % 1024 == 0:
                check()
            if max_rows is not None and read > max_rows:
                raise BatchTooBig("A player batch exceeds the prepared history memory budget")
            if max_bytes is not None:
                used_bytes += 1024 + sum(
                    len(value.encode()) for value in row if isinstance(value, str)
                )
                if used_bytes > max_bytes:
                    raise BatchTooBig("A player batch exceeds the prepared history memory budget")
            if row["player"] != player:
                if events:
                    yield player, events
                player, events = row["player"], []
            events.append(row)
        if events:
            yield player, events


def counted_rows(player, events, scope):
    """(player, rows, latest) as player_levels takes them, or None when the player doesn't count.

    scope "all": a player counts with any selected event. "first_session": a player counts when
    their very first event is selected; rows are that event's session and latest their last event.
    """
    if scope == "first_session":
        if not events[0]["selected"]:
            return None
        session = events[0]["session_id"]
        return player, [row for row in events if row["session_id"] == session], events[-1]
    if any(row["selected"] for row in events):
        return player, events, None
    return None


def _check_scope(scope):
    if scope not in LEVEL_SCOPES:
        raise HTTPException(400, "Unknown scope")


def _new_progress():
    return {
        "started": False,
        "completed": False,
        "attempts": 0,
        "completions": 0,
        "fails": 0,
        "restarts": 0,
        "seconds": [],
        "quit": 0,
        "powerups": None,  # a Counter once the level has one
        "other": None,
    }


def player_levels(player, rows, latest, scope, start, reader):
    """One player's part of the level dashboards, from their rows in time order.

    progress: per level number, what the table counts for this player (from the selected rows;
    in first-session scope, every row of the session). groups: per level number, this player's
    record in each group of level_players. observed: the level numbers they started at all.
    _LevelTotals adds the parts of all players up into the answers.
    """
    progress = {}
    opened, last_level = {}, None
    events = []
    seen = _Features()
    for row in rows:
        params, info = reader.level(row["name"], row["params"], row["app_version"])
        events.append((row, info))
        seen.step(len(events) - 1, row, params, info, last_level, scope == "first_session")
        if scope != "first_session" and not row["selected"]:
            continue
        if info is None:
            for key, value in params.items():
                number = stories._int(value) if stories.LEVELISH_KEY.search(key) else None
                if number is not None:
                    bucket = "powerups" if POWERUP_NAME.search(row["name"]) else "other"
                    item = progress.setdefault(number, _new_progress())
                    counts = item[bucket] = item[bucket] or Counter()
                    counts[reader.label(row)] += 1
                    break
            continue
        verb, number = info
        item = progress.setdefault(number, _new_progress())
        last_level = (number, verb)
        if verb in ("started", "restarted"):
            item["started"] = True
            item["attempts"] += 1
            if verb == "restarted":
                item["restarts"] += 1
            opened[number] = (row["ts"], row["session_id"])
        elif verb == "completed":
            item["completed"] = True
            item["completions"] += 1
            began = opened.pop(number, None)
            if began and began[1] == row["session_id"] and 0 <= row["ts"] - began[0] <= 3600:
                item["seconds"].append(row["ts"] - began[0])
        elif verb == "failed":
            item["fails"] += 1
    if last_level is not None and last_level[1] in ("started", "restarted", "failed"):
        progress.setdefault(last_level[0], _new_progress())["quit"] += 1
    groups, observed = _player_transitions(player, events, latest, scope, start, reader)
    return {
        "progress": progress,
        "groups": groups,
        "observed": observed,
        "features": seen.finish(events, groups),
    }


# What a level's numbers can be split by: (event, state, parameter) -> the kind of thing counted.
FEATURE_EVENTS = {
    ("AD_ANALYSIS", "Show"): (("ads", "FORMAT"), ("ad_placement", "PLACEMENT")),
    ("POWERUP_ANALYSIS", "Used"): (("powerups", "POWERUP"),),
}


class _Features:
    """What happened on each level (ads shown, powerups used, fail reasons) for one player, with
    where the player's last meaningful event was, so the dashboards can say how often each thing
    happened and what players who met it did next.

    An event belongs to the level it names (LEVEL_NUMBER); one that names none, such as an
    interstitial after a result, belongs to the level the player was last on.
    """

    def __init__(self):
        self.counts = {}  # level -> {"kind|value": count}
        self.last = None  # (level, keys) of the last event when it was one of these
        self.starts = []  # (position, level, session) of every level start

    def step(self, position, row, params, info, last_level, every_row):
        if info and info[0] in ("started", "restarted"):
            self.starts.append((position, info[1], row["session_id"]))
        if not (every_row or row["selected"]):
            if row["name"] not in NOT_AN_ACTION:
                self.last = None
            return
        keys = []
        if info and info[0] == "failed":
            reason = stories.param_text(params, "FAIL_REASON")
            keys.append(("fails", reason or "Unspecified"))
            number = info[1]
        else:
            found = FEATURE_EVENTS.get((row["name"], stories.param_text(params, "STATE")))
            if not found:
                if row["name"] not in NOT_AN_ACTION:
                    self.last = None
                return
            for kind, parameter in found:
                value = stories.param_text(params, parameter)
                if value:
                    keys.append((kind, value))
            number = next(
                (
                    stories._int(value)
                    for key, value in params.items()
                    if stories.LEVELISH_KEY.search(key) and stories._int(value) is not None
                ),
                last_level[0] if last_level else None,
            )
        if number is None or not keys:
            return
        mine = self.counts.setdefault(number, {})
        names = [f"{kind}|{value}" for kind, value in keys]
        for name in names:
            mine[name] = mine.get(name, 0) + 1
        self.last = (number, names)

    def finish(self, events, groups):
        """{level: {key: [count, dropped, left the session, left right after]}} for the levels
        this player started in the range; "*" counts the player themselves."""
        # A player's last level event and latest next-level start in that session answer
        # every level. Walking the whole history per level was quadratic for long players.
        last_levels = {
            info[1]: (index, row["session_id"]) for index, (row, info) in enumerate(events) if info
        }
        last_starts = {(session, number): position for position, number, session in self.starts}
        result = {}
        for number, mine in groups.items():
            if "started" not in mine:
                continue
            dropped = int("total_drop" in mine)
            last = last_levels.get(number)
            left = int(last is not None and last_starts.get((last[1], number + 1), -1) <= last[0])
            row = result[number] = {"*": [1, dropped, left, 0]}
            for name, count in self.counts.get(number, {}).items():
                right = int(
                    bool(dropped)
                    and self.last is not None
                    and self.last[0] == number
                    and name in self.last[1]
                )
                row[name] = [count, dropped, left, right]
        return result


def _player_transitions(player, events, latest, scope, start, reader):
    """For each level this player started in the range: where they went next (see level_players).

    One pass builds lookups (positions of each level's starts, finishes and fails, the highest
    level still ahead, the lowest level behind, session boundaries), so every level is answered
    without walking the player's history again.
    """
    if not events:
        return {}, set()
    latest = latest or events[-1][0]
    count = len(events)
    stamps = [row["client_ts"] for row, _ in events]
    session_lengths = {}
    starts, completes, fails, positions = {}, {}, {}, {}
    first_starts, selected_starts = {}, {}
    versions = {}  # app version -> first position (only versions the code counts as set)
    lowest = [None] * (count + 1)  # lowest level number among level events before a position
    for index, (row, info) in enumerate(events):
        session_lengths.setdefault(row["session_id"], SessionState()).add(
            row["name"], row["client_ts"], row["server_ts"], row["seq"], row["params"]
        )
        if row["app_version"]:
            versions.setdefault(row["app_version"], index)
        lowest[index + 1] = lowest[index]
        if info:
            verb, number = info
            positions.setdefault(number, []).append(index)
            if lowest[index + 1] is None or number < lowest[index + 1]:
                lowest[index + 1] = number
            if verb in ("started", "restarted"):
                starts.setdefault(number, []).append(index)
                first_starts.setdefault(number, index)
                if row["selected"] or scope == "first_session":
                    selected_starts.setdefault(number, index)
            elif verb == "completed":
                completes.setdefault(number, []).append(index)
            elif verb == "failed":
                fails.setdefault(number, []).append(index)
    highest = [None] * (count + 1)  # highest level number among level events from a position on
    for index in range(count - 1, -1, -1):
        info = events[index][1]
        highest[index] = highest[index + 1]
        if info and (highest[index] is None or info[1] > highest[index]):
            highest[index] = info[1]
    runs = _session_runs(events, reader.labeler)
    groups = {}
    for number, began in selected_starts.items():
        initial = events[began][0]
        # Everything from the start's timestamp on: a suffix, ties included.
        since = bisect_left(stamps, initial["client_ts"])
        completed = bool(completes.get(number)) and completes[number][-1] >= since
        following = starts.get(number + 1)
        continued = bool(following) and following[-1] >= since
        higher = highest[since] is not None and highest[since] > number
        tries = len(starts[number]) - bisect_left(starts[number], since)
        failed = fails.get(number, [])
        fail_count = len(failed) - bisect_left(failed, since)
        last_index = positions[number][-1]
        last = events[last_index][0]
        record = {
            "player": player,
            "tries": tries,
            "fails": fail_count,
            "completed": completed,
            "exit_at": last["client_ts"],
            "exit_event": last["event_id"],
            **_ending(events, last_index, latest, reader, runs),
            "next_action": _next_action(events, last_index, reader, runs),
            "last_event": _last_event(events, last_index, reader, runs),
            "session_seconds": round(session_lengths[last["session_id"]].seconds, 1),
            "last_seen": latest["client_ts"],
            # Any later session counts, even the same day.
            "came_back": latest["client_ts"] > last["client_ts"]
            and latest["session_id"] != last["session_id"],
            "app_version": latest["app_version"],
            "start_version": initial["app_version"],
            "country": latest["country"],
            "history": "Observed start",
        }
        mine = groups.setdefault(number, {})
        mine["started"] = record
        first_left = _came_back_later(
            events, began, number, positions, following, since, latest, reader, runs
        )
        if first_left:
            mine["came_back_later"] = {
                **record,
                **first_left,
                "passed": completed,
                "reached_next": continued,
            }
        if continued:
            mine["kept_going"] = record
            if not first_left:
                mine["straight_on"] = record
        else:
            mine["total_drop"] = record
            category = "unknown_progress" if higher else "finished_stopped" if completed else "left"
            mine[category] = record
        if not completed and not higher and (tries >= STUCK_TRIES or fail_count >= STUCK_TRIES):
            mine["stuck"] = record
        # Failing is fine when the player still plays on; it is a problem when they fail and leave.
        # Passing the level later, or going on to a later one, counts as playing on.
        if fail_count:
            mine["failed"] = record
            mine["failed_left" if "left" in mine else "failed_kept_playing"] = record
        previous = selected_starts.get(number - 1)
        if number <= 0 or (
            previous is not None and events[previous][0]["client_ts"] <= initial["client_ts"]
        ):
            continue
        version = initial["app_version"]
        recorded_history = (
            first_starts.get(number - 1, began) < began
            or (began > 0 and stamps[0] < start)
            or bool(
                version and any(seen != version and at < began for seen, at in versions.items())
            )
            or (lowest[began] is not None and lowest[began] < number)
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
        groups.setdefault(number - 1, {})[category] = entrant
    return groups, set(starts)


def _session_runs(events, labeler):
    """Per position: its run of consecutive events of one session, as (first, last), plus the
    run's last non-SDK event, and the next action after each position."""
    count = len(events)
    run_of = [None] * count
    next_action = [None] * count
    index = 0
    while index < count:
        session = events[index][0]["session_id"]
        end = index
        while end + 1 < count and events[end + 1][0]["session_id"] == session:
            end += 1
        last_event = None
        upcoming = None
        for position in range(end, index - 1, -1):
            row = events[position][0]
            next_action[position] = upcoming
            if row["name"] not in NOT_AN_ACTION and not labeler.hidden(row["name"]):
                upcoming = position
            if last_event is None and row["name"] not in SDK_EVENTS:
                last_event = position
        run = (index, end, last_event)
        for position in range(index, end + 1):
            run_of[position] = run
        index = end + 1
    return {"run": run_of, "next_action": next_action, "endings": {}}


def _level_scan(storage, game_id, start, end, filters, scope):
    """The level table's numbers and every level's player groups, from one read of the events.

    Shared by the level table and every level's player list (see readcache.py), and must not be
    changed.
    """
    definitions = _definitions(storage, game_id)
    if storage.settings.analytics_read_mode == "prepared":
        from . import views

        return views.answer(
            storage,
            game_id,
            "levels",
            (start, end, filters, scope),
            lambda: _scan_levels(storage, game_id, start, end, filters, scope, definitions),
        )
    return storage.scans.get(
        storage,
        game_id,
        ("levels", start, end, filters, scope),
        lambda: _scan_levels(storage, game_id, start, end, filters, scope, definitions),
    )


def _scan_levels(storage, game_id, start, end, filters, scope, definitions):
    reader = _Reader(stories.Labeler(definitions))
    totals = _LevelTotals()
    with storage.connect(storage.game_path(game_id)) as connection:
        source = read_source(storage, connection)
        condition, args = where(start, end, filters, source=source)
        anonymous_events = connection.execute(
            f"SELECT count(*) FROM {source.table} WHERE {condition} AND NOT ({source.identified})",
            args,
        ).fetchone()[0]
        total = connection.execute(
            f"SELECT count(*) FROM {source.table} WHERE {condition} AND {source.identified}", args
        ).fetchone()[0]
        # The table refuses a range with too many events. Its player lists only refuse too much
        # history, which in "all" scope includes the range's events, so both refuse here; a
        # first-session list may still fit (its scan reads only new players).
        too_many = total > MAX_FUNNEL_EVENTS
        if too_many and scope != "first_session":
            raise _TooMuch("range")
        if source.facts:
            players = scanned_players(connection, start, end, filters, scope)
            rows = _limited(
                player_rows(connection, players, start, end, filters),
                "range" if scope == "first_session" else "history",
                scope,
            )
        elif scope == "first_session":
            rows = _first_sessions(connection, start, end, filters, source)
        else:
            rows = _histories(connection, start, end, filters, source)
        for player, events, latest in rows:
            totals.add(player_levels(player, events, latest, scope, start, reader))
    return {
        "levels": totals.levels,
        "transitions": totals.transitions(),
        "features": totals.features,
        "features_without_returners": totals.features_without_returners,
        "anonymous_events": anonymous_events,
        "too_many": too_many,
    }


def _limited(found, kind, scope):
    """The counted players of player_rows, stopping with _TooMuch once more than
    MAX_FUNNEL_EVENTS rows have been read (counted or not, as the raw-event scans count them)."""
    read = 0
    for player, events in found:
        read += len(events)
        if read > MAX_FUNNEL_EVENTS:
            raise _TooMuch(kind)
        if counted := counted_rows(player, events, scope):
            yield counted


class _LevelTotals:
    """Adds players' parts (player_levels) up, in player order, into the dashboards' numbers."""

    def __init__(self):
        self.levels = {}
        self.groups = {}
        self.observed = set()
        self.features = {}  # level -> key -> [players, times, dropped, left session, right after]
        self.features_without_returners = {}

    def add(self, part):
        for number, mine in part["progress"].items():
            item = self.levels.setdefault(
                number,
                {
                    "level": number,
                    "started": 0,
                    "completed": 0,
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
            item["started"] += mine["started"]
            item["completed"] += mine["completed"]
            for key in ("attempts", "completions", "fails", "restarts", "quit"):
                item[key] += mine[key]
            item["seconds"] += mine["seconds"]
            if mine["powerups"]:
                item["powerups"].update(mine["powerups"])
            if mine["other"]:
                item["other"].update(mine["other"])
        for number, records in part["groups"].items():
            target = self.groups.setdefault(number, {name: [] for name in LEVEL_GROUPS})
            for name, record in records.items():
                target[name].append(record)
        self.observed.update(part["observed"])
        for number, mine in part.get("features", {}).items():
            records = part["groups"].get(number, {})
            returned = "came_back_later" in records or records.get("started", {}).get("came_back")
            for features, exclude in (
                (self.features, False),
                (self.features_without_returners, True),
            ):
                target = features.setdefault(number, {})
                for key, (count, dropped, left, right) in mine.items():
                    total = target.setdefault(key, [0, 0, 0, 0, 0])
                    total[0] += 1
                    total[1] += count
                    if not (exclude and returned):
                        total[2] += dropped
                        total[3] += left
                        total[4] += right

    def transitions(self):
        result = {}
        for number, groups in self.groups.items():
            started = len(groups["started"])
            available = number + 1 in self.observed and started > 0
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
                    "fail_drop_percent": round(100 * counts["failed_left"] / counts["failed"], 1)
                    if available and counts["failed"]
                    else None,
                    "matched_completed": sum(row["completed"] for row in groups["started"]),
                    "entrants": counts["returning"] + counts["missing_history"],
                    "starters_returning": sum(
                        row.get("entry_context") == "returning" for row in groups["started"]
                    ),
                    "starters_missing_history": sum(
                        row.get("entry_context") == "missing_history" for row in groups["started"]
                    ),
                    "net_change": len(self.groups.get(number + 1, {}).get("started", [])) - started
                    if available
                    else None,
                },
            }
        return result


def _without_returners(scan):
    """Select drop numerators without changing the cached scan or its starter cohort.

    A return is a later session after an interruption on this level, observed by range end.
    Keep the returners' own tab and all progression/occurrence denominators available.
    """
    transitions = {}
    for number, transition in scan["transitions"].items():
        groups = transition["groups"]
        returned = {item["player"] for item in groups["came_back_later"]}
        returned.update(item["player"] for item in groups["started"] if item["came_back"])
        selected = dict(groups)
        for name in ("total_drop", "left", "finished_stopped", "unknown_progress", "failed_left"):
            selected[name] = [item for item in groups[name] if item["player"] not in returned]
        summary = {**transition["summary"], **{key: len(rows) for key, rows in selected.items()}}
        started, failed = summary["started"], summary["failed"]
        summary["drop_percent"] = (
            round(100 * summary["total_drop"] / started, 1) if summary["available"] else None
        )
        summary["fail_drop_percent"] = (
            round(100 * summary["failed_left"] / failed, 1)
            if summary["available"] and failed
            else None
        )
        transitions[number] = {"groups": selected, "summary": summary}
    return {**scan, "transitions": transitions, "features": scan["features_without_returners"]}


def level_progress(
    storage, game_id, start, end, filters=None, scope="all", exclude_returners=False
):
    """Per level: who started, who finished, tries, fails, time, power-ups, where players quit.

    scope "first_session" counts only new players, within their first session.
    """
    storage.get_game(game_id)
    _check_scope(scope)
    try:
        scan = _level_scan(storage, game_id, start, end, filters, scope)
    except _TooMuch as error:
        message = TOO_MUCH["range" if scope == "first_session" else error.kind]
        raise HTTPException(400, message) from None
    if scan["too_many"]:
        raise HTTPException(400, TOO_MUCH["range"])
    if exclude_returners:
        scan = _without_returners(scan)
    threshold = storage.analytics_thresholds(game_id)["levels_min_players"]
    return render_levels(scan, threshold, scope)


def level_features(
    storage, game_id, start, end, filters=None, scope="all", exclude_returners=False
):
    """Per level: how often each ad format or placement, powerup and fail reason happened, and
    what the players who met it did next (drop, left the session, left right after it).

    Counts are raw (players, times, ...), so a page can show any of them as numbers or shares.
    """
    storage.get_game(game_id)
    _check_scope(scope)
    try:
        scan = _level_scan(storage, game_id, start, end, filters, scope)
    except _TooMuch as error:
        message = TOO_MUCH["range" if scope == "first_session" else error.kind]
        raise HTTPException(400, message) from None
    if scan["too_many"]:
        raise HTTPException(400, TOO_MUCH["range"])
    if exclude_returners:
        scan = _without_returners(scan)
    threshold = storage.analytics_thresholds(game_id)["levels_min_players"]
    return render_features(scan, threshold, scope)


def render_features(scan, threshold, scope):
    names = {"ads": set(), "ad_placement": set(), "powerups": set(), "fails": set()}
    levels = []
    for number in sorted(scan.get("features", {})):
        mine = scan["features"][number]
        everyone = mine.get("*")
        if not everyone or not everyone[0]:
            continue
        summary = scan["transitions"].get(number, {}).get("summary", {})
        things = {}
        for key, (players, times, dropped, left, right) in mine.items():
            if key == "*":
                continue
            kind, value = key.split("|", 1)
            names.setdefault(kind, set()).add(value)
            things.setdefault(kind, {})[value] = {
                "players": players,
                "times": times,
                "dropped": dropped,
                "left_session": left,
                "right_after": right,
            }
        levels.append(
            {
                "level": number,
                "started": everyone[0],
                "dropped": everyone[2],
                "left_session": everyone[3],
                # The next level was never started by anyone, so nobody could have "dropped".
                "drop_available": bool(summary.get("available")),
                "low_sample": everyone[0] < threshold,
                "things": things,
            }
        )
    totals = {kind: Counter() for kind in names}
    for item in levels:
        for kind, values in item["things"].items():
            for value, counts in values.items():
                totals[kind][value] += counts["players"]
    return {
        "levels": levels,
        "kinds": {
            kind: [value for value, _ in totals[kind].most_common()] for kind in sorted(names)
        },
        "context": {"minimum_players": threshold, "scope": scope},
    }


def render_levels(scan, threshold, scope):
    """The level table from a scan's numbers and the confidence threshold."""
    levels, transitions = scan["levels"], scan["transitions"]
    result = []
    for number in sorted(levels):
        item = levels[number]
        started = item["started"]
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
                "observed_completed": item["completed"],
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
            "anonymous_events": scan["anonymous_events"],
            "minimum_players": threshold,
            "low_sample_levels": sum(1 for item in result if item["low_sample"]),
            "transition_basis": "Selected starters, followed across versions until range end"
            if scope == "all"
            else "New players, within their first session",
            "scope": scope,
        },
    }


def _later_session(events, end, latest):
    """Did the player play again after the session ending at position end?"""
    session = events[end][0]["session_id"]
    return end + 1 < len(events) or latest["session_id"] != session


def _ending(events, index, latest, reader, runs):
    """How the session of events[index] ended: the tag, whether it is known, and how the phone
    says the app went, from the next launch. One session is read once, however many levels it had.
    """
    first, end, _ = runs["run"][index]
    known = runs["endings"].get(first)
    if known is None:
        rows = events[first : end + 1]
        arrived = level_exits.ending_arrived(rows, reader, _later_session(events, end, latest))
        words = level_exits.phrase(level_exits.where_they_left(rows, reader), arrived)
        how = _previous_exit(events, end, reader)
        known = {"last_action": words, "ending_known": arrived, **how}
        runs["endings"][first] = known
    return known


def _previous_exit(events, end, reader):
    """What the launch after the session at position end says about how the app stopped."""
    for row, _ in events[end + 1 : end + 1 + LAUNCH_WITHIN]:
        if row["name"] == "APP_ANALYSIS":
            params = reader.params(row["params"])
            if stories.param_text(params, "STATE") == "Launch":
                reason = stories.param_text(params, "PREV_EXIT_REASON")
                ad = stories.param_text(params, "PREV_EXIT_AD")
                return {"prev_exit_reason": reason, "prev_exit_ad": ad} if reason else {}
    return {}


def _came_back_later(events, began, number, positions, following, since, latest, reader, runs):
    """The player left the session they started this level in and returned in a later one.

    Returns what the row of the Came back later tab needs, about the first time they left, or None
    when they went straight on or never returned.
    """
    end = runs["run"][began][1]
    session = events[began][0]["session_id"]
    if following and following[-1] >= since:
        ahead = following[bisect_left(following, since)]
        if events[ahead][0]["session_id"] == session:
            return None
    elif not _later_session(events, end, latest):
        return None
    last = positions[number][bisect_right(positions[number], end) - 1]
    away = None
    if end + 1 < len(events):
        away = round(max(0.0, _moment(events[end + 1][0]) - _moment(events[end][0])), 1)
    return {
        **_ending(events, last, latest, reader, runs),
        "exit_at": events[last][0]["client_ts"],
        "exit_event": events[last][0]["event_id"],
        "away_seconds": away,
    }


def _moment(row):
    return datetime.fromisoformat(row["client_ts"]).timestamp()


def _next_action(events, index, reader, runs):
    """What the player did first after events[index], in its session; None when nothing followed."""
    position = runs["next_action"][index]
    return None if position is None else reader.action(events[position][0])


def _last_event(events, index, reader, runs):
    """The last event sent in the session of events[index], and how long after the one before it.

    Session start and end are written by the SDK around the session, so they are skipped. Returns
    {"text", "gap", "after", "after_level"}: gap is in seconds and after names the event before it
    (both None when it was the first event they sent); after_level is the seconds from events[index]
    to this event, None when this is events[index] itself.
    """
    session = events[index][0]["session_id"]
    _, _, run_event = runs["run"][index]
    end = run_event if run_event is not None and run_event > index else index
    row = events[end][0]
    last = {
        "text": reader.text(row),
        "gap": None,
        "after": None,
        "after_level": round(max(0.0, _moment(row) - _moment(events[index][0])), 1)
        if end > index
        else None,
    }
    # A session_end in the middle of a session is a trip to the background, not an event they sent.
    earlier = end - 1
    while earlier >= 0 and events[earlier][0]["name"] == "session_end":
        earlier -= 1
    if earlier >= 0 and events[earlier][0]["session_id"] == session:
        before = events[earlier][0]
        last["gap"] = round(max(0.0, _moment(row) - _moment(before)), 1)
        last["after"] = reader.text(before)
    return last


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
    exclude_returners=False,
    cause=None,
    ending=None,
):
    """The players in one group of one level, plus the size of every group.

    last_actions counts what the group's players did last on the level; last_action keeps only
    the players whose last action was that one. causes counts the same endings by cause (all the
    endings around one kind of ad together, with how each ended); cause and ending keep one.
    The scan is shared with the level table and cached for a minute, so switching groups, pages,
    levels or last actions doesn't read the events again.
    """
    storage.get_game(game_id)
    if group not in LEVEL_GROUPS:
        raise HTTPException(400, "Unknown group")
    if sort not in LEVEL_PLAYER_SORTS:
        raise HTTPException(400, "Unknown sort")
    _check_scope(scope)
    try:
        scan = _level_scan(storage, game_id, start, end, filters, scope)
    except _TooMuch:
        message = TOO_MUCH["range" if scope == "first_session" else "history"]
        raise HTTPException(400, message) from None
    if exclude_returners:
        scan = _without_returners(scan)
    groups = scan["transitions"].get(level, {}).get("groups", {name: [] for name in LEVEL_GROUPS})
    return players_in_group(groups, level, group, offset, limit, sort, last_action, cause, ending)


def _endings_by_cause(last_actions):
    """The group's last actions counted by cause (every ending around one kind of ad together),
    each with how it ended; biggest first. last_actions: Counter of the exact texts."""
    causes = {}
    for text, count in last_actions.items():
        parts = level_exits.split_ending(text)
        entry = causes.setdefault(
            parts["cause"],
            {
                "key": parts["cause"],
                "label": parts["label"],
                "players": 0,
                "left": 0,
                "endings": {},
            },
        )
        entry["players"] += count
        entry["left"] += count if parts["arrived"] else 0
        ending = entry["endings"].setdefault(
            parts["ending"], {"key": parts["ending"], "label": parts["ending_label"], "players": 0}
        )
        ending["players"] += count
    ranked = sorted(causes.values(), key=lambda entry: (-entry["players"], entry["key"]))
    for entry in ranked:
        entry["endings"] = sorted(
            entry["endings"].values(), key=lambda item: (-item["players"], item["key"])
        )
    return ranked[:LAST_ACTIONS]


def players_in_group(
    groups, level, group, offset, limit, sort, last_action, cause=None, ending=None
):
    """One page of a level group's players, from that level's groups."""
    members = groups[group]
    last_actions = Counter(item["last_action"] for item in members)
    no_ending = sum(not item["ending_known"] for item in members)
    causes = _endings_by_cause(last_actions)
    if last_action is not None:
        members = [item for item in members if item["last_action"] == last_action]
    if cause is not None:
        members = [
            item
            for item in members
            if level_exits.split_ending(item["last_action"])["cause"] == cause
        ]
    if ending is not None:
        members = [
            item
            for item in members
            if level_exits.split_ending(item["last_action"])["ending"] == ending
        ]
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
        "causes": causes,
        "no_ending": no_ending,
        "total": len(members),
        "offset": offset,
        "players": members[offset : offset + limit],
    }
