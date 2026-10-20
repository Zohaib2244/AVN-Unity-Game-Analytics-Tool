"""First-session flow: how many levels new players play in one unbroken run.

Looks only at players whose very first event falls in the chosen dates, and only at their first
session. A run is Start -> Complete -> Start -> Complete ... of consecutive levels. Whatever
happens inside a level or between a win and the next start (a screen, an ad, a fail and retry,
going home) is a "path". Paths the user lists as allowed keep the run going and are flagged;
every other path ends it.
"""

import json
from collections import Counter

from fastapi import HTTPException

from . import stories
from .insights import IDENTIFIED, PLAYER, SESSION, where
from .journeys import _definitions

# Sent by the SDK around every session, never part of what a player did.
NOISE = {"session_start", "session_end", "first_open"}
DETAIL_KEYS = ("SCREEN", "FORMAT", "ACTION", "REASON")
MAX_EVENTS = 2_000_000
MAX_ENDS = 100
MAX_PATHS = 200


def _param(params, key):
    value = stories._lookup(params, key)
    return None if value is None else str(value)


def _token(name, params):
    """One short, stable text for an event that is not part of the level chain."""
    state = _param(params, "STATE")
    detail = "/".join(value for key in DETAIL_KEYS if (value := _param(params, key)))
    text = f"{name} {state}" if state else name
    return f"{text} ({detail})" if detail else text


def path_key(stage, signature):
    return f"{stage}|{signature}"


def _read(rows, labeler):
    """One player's first-session events as the chain of level segments they produced.

    Returns (segments, ending). A segment is a finished stretch: "during" a level (its start
    to its win) or "between" a win and the next start. ending describes where the chain
    stopped, with the open stretch's events in its tokens.
    """
    segments = []
    stage, level, tokens, away = None, None, [], None
    first = None
    for row in rows:
        params = row["params"]
        info = labeler.level_info(row["name"], params, row["app_version"])
        verb, number = info if info else (None, None)
        if verb == "restarted":
            verb = "restart"
        if verb == "started":
            if stage is None:
                first = number
                stage, level, tokens, away = "during", number, [], None
            elif stage == "during" and number == level:
                continue  # starting the same level again is a retry; the fail/restart is the token
            elif stage == "during" and number == level + 1 and "skipped" in tokens:
                segments.append((stage, level, tuple(tokens), away))
                stage, level, tokens, away = "during", number, [], None
            elif stage == "between" and number == level + 1:
                segments.append((stage, level, tuple(tokens), away))
                stage, level, tokens, away = "during", number, [], None
            else:
                expected = level + 1 if stage == "between" else level
                return segments, {
                    "kind": "jump",
                    "stage": stage,
                    "level": level,
                    "tokens": tokens,
                    "detail": f"Started level {number}, expected {expected}",
                    "first": first,
                }
            continue
        if stage is None:
            continue
        if verb == "completed" and number == level and stage == "during":
            segments.append((stage, level, tuple(tokens), away))
            stage, tokens, away = "between", [], None
            continue
        if row["name"] in NOISE or (verb == "completed" and stage == "between"):
            continue
        if row["name"] == "APP_ANALYSIS":
            state = _param(params, "STATE")
            if state == "Foreground":
                cause = _param(params, "CAUSE")
                seconds = stories._number(stories._lookup(params, "AWAY_SECONDS"))
                if cause in (None, "Player") and seconds is not None:
                    away = max(away or 0, seconds)
            continue
        if stage == "during" and _param(params, "STATE") == "Skipped":
            tokens.append("skipped")
            continue
        if verb in ("failed", "restart") and number == level and stage == "during":
            tokens.append("failed" if verb == "failed" else "restarted")
            continue
        tokens.append(_token(row["name"], params))
    return segments, {
        "kind": "end",
        "stage": stage,
        "level": level,
        "tokens": tokens,
        "away": away,
        "first": first,
    }


def _pretty(token):
    return {
        "failed": "Failed the level",
        "restarted": "Restarted the level",
        "skipped": "Skipped the level",
    }.get(token, token)


def signature(tokens):
    return " → ".join(_pretty(token) for token in tokens)


def _stage_text(stage):
    return "in the level" if stage == "during" else "after the win"


def _judge(stage, tokens, away, config):
    """None when the stretch keeps the run going, else why it ended."""
    if away is not None and away > config["max_away_seconds"]:
        return f"Left the app for over {config['max_away_seconds']:g}s ({_stage_text(stage)})"
    text = signature(tokens)
    if text and path_key(stage, text) not in config["allow"]:
        return f"{text} ({_stage_text(stage)})"
    return None


def _walk(segments, ending, config):
    """Apply the allowed paths to one player's chain.

    Returns (started, completed, flags, end) where started/completed are level lists and end is
    (level, stage, reason) or None when the run reached the last level.
    """
    started, completed, flags = [], [], []
    last = config["last_level"]
    for stage, level, tokens, away in segments:
        if level > last:
            return started, completed, flags, None
        if stage == "during":
            started.append(level)
        reason = _judge(stage, tokens, away, config)
        if reason:
            return started, completed, flags, (level, stage, reason)
        if tokens or away is not None:
            flags.append((level, stage, signature(tokens) or "Left the app briefly"))
        if stage == "during":
            completed.append(level)
        elif level >= last:
            return started, completed, flags, None
    level, stage = ending["level"], ending["stage"]
    if level > last:
        return started, completed, flags, None
    if ending["kind"] == "jump":
        if stage == "during":
            started.append(level)
        return started, completed, flags, (level, stage, ending["detail"])
    if stage == "during":
        started.append(level)
    elif level >= last:
        return started, completed, flags, None
    tokens, away = ending["tokens"], ending["away"]
    if away is not None and away > config["max_away_seconds"]:
        reason = _judge(stage, [], away, config)
    else:
        last_event = _pretty(tokens[-1]) if tokens else None
        if stage == "during":
            reason = (
                f"Stopped in the level, last event: {last_event}"
                if last_event
                else "Stopped right after starting the level"
            )
        else:
            reason = (
                f"Stopped after the win, last event: {last_event}"
                if last_event
                else "Stopped right after the win"
            )
    return started, completed, flags, (level, stage, reason)


def _scan(storage, game_id, start, end, filters, config):
    """Every eligible new player's first session, walked under the allowed paths."""
    storage.get_game(game_id)
    if config["last_level"] < config["first_level"]:
        raise HTTPException(400, "The last level cannot come before the first level.")
    labeler = stories.Labeler(_definitions(storage, game_id))
    condition, args = where(start, end, filters)
    wide = {
        key: value
        for key, value in (filters or {}).items()
        if key in ("environments", "exclude_environments", "platforms")
    }
    scope, scope_args = where("0", "~", wide)
    config = {**config, "allow": set(config.get("allow") or [])}
    excluded = Counter()
    paths = Counter()
    records = []

    def finish(rows):
        if not rows:
            return
        if not rows[0]["selected"]:
            excluded["outside_filters"] += 1
            return
        session = rows[0]["session"]
        rows = [row for row in rows if row["session"] == session]
        segments, ending = _read(rows, labeler)
        if ending["first"] is None:
            excluded["no_level_started"] += 1
            return
        if ending["first"] != config["first_level"]:
            excluded["started_at_other_level"] += 1
            return
        seen = {(stage, signature(tokens)) for stage, _level, tokens, _ in segments if tokens}
        paths.update(seen)
        begun, done, noted, end_state = _walk(segments, ending, config)
        records.append(
            {
                "player": rows[0]["player"],
                "first_seen": rows[0]["client_ts"],
                "app_version": rows[0]["app_version"],
                "begun": set(begun),
                "done": set(done),
                "run": len(done),
                "flags": set(noted),
                "end": end_state,
                "paths": seen,
            }
        )

    with storage.connect(storage.game_path(game_id)) as connection:
        cursor = connection.execute(
            f"""WITH firsts AS (
                    SELECT {PLAYER} AS player, min(client_ts) AS first_ts FROM events
                    WHERE {scope} AND {IDENTIFIED}
                    GROUP BY {PLAYER} HAVING first_ts>=? AND first_ts<?
                ),
                selected AS (SELECT event_id FROM events WHERE {condition} AND {IDENTIFIED})
                SELECT {PLAYER} AS player, {SESSION} AS session, name, client_ts,
                       json_extract(payload, '$.params') AS params,
                       json_extract(payload, '$.app_version') AS app_version,
                       event_id IN (SELECT event_id FROM selected) AS selected
                FROM events WHERE {scope} AND {IDENTIFIED}
                    AND {PLAYER} IN (SELECT player FROM firsts)
                ORDER BY player, client_ts, event_id LIMIT ?""",
            (*scope_args, start, end, *args, *scope_args, MAX_EVENTS + 1),
        )
        player, rows = None, []
        for count, row in enumerate(cursor, 1):
            if count > MAX_EVENTS:
                raise HTTPException(400, "Too many events to analyze. Pick fewer days.")
            if row["player"] != player:
                finish(rows)
                player, rows = row["player"], []
            item = dict(row)
            item["params"] = json.loads(row["params"]) if row["params"] else {}
            rows.append(item)
        finish(rows)
    return records, excluded, paths, config


def first_session_flow(storage, game_id, start, end, filters, config):
    """Unbroken level runs of new players' first sessions."""
    records, excluded, paths, config = _scan(storage, game_id, start, end, filters, config)
    players = len(records)
    first_level, last = config["first_level"], config["last_level"]
    started, completed = Counter(), Counter()
    run_lengths, ends, flags = Counter(), Counter(), Counter()
    for record in records:
        started.update(record["begun"])
        completed.update(record["done"])
        run_lengths[record["run"]] += 1
        flags.update(record["flags"])
        if record["end"]:
            ends[record["end"]] += 1
    reached = max([level for level in started if started[level]] or [first_level])
    steps = [
        {
            "level": level,
            "started": started[level],
            "completed": completed[level],
            "percent": round(100 * completed[level] / players, 1) if players else None,
        }
        for level in range(first_level, reached + 1)
    ]
    total_ends = sum(ends.values())
    return {
        "players": players,
        "excluded": dict(excluded),
        "minimum_players": storage.analytics_thresholds(game_id)["funnels_min_players"],
        "steps": steps,
        "run_lengths": [
            {"levels": length, "players": run_lengths[length]}
            for length in range(0, last + 1)
            if run_lengths[length]
        ],
        "ends": [
            {"level": level, "stage": stage, "reason": reason, "players": count}
            for (level, stage, reason), count in sorted(
                ends.items(), key=lambda item: (-item[1], item[0][0])
            )[:MAX_ENDS]
        ],
        "ends_total": total_ends,
        "reached_end": players - total_ends,
        "flags": [
            {"level": level, "stage": stage, "path": text, "players": count}
            for (level, stage, text), count in sorted(
                flags.items(), key=lambda item: (-item[1], item[0][0])
            )
        ],
        "paths": [
            {
                "stage": stage,
                "path": text,
                "key": path_key(stage, text),
                "players": count,
                "allowed": path_key(stage, text) in config["allow"],
            }
            for (stage, text), count in sorted(paths.items(), key=lambda item: -item[1])[:MAX_PATHS]
        ],
        "config": {**config, "allow": sorted(config["allow"])},
    }


def _member(record, target):
    kind = target["kind"]
    if kind == "end":
        return record["end"] == (target["level"], target["stage"], target["reason"])
    if kind == "finished":
        return record["end"] is None
    if kind == "flag":
        return (target["level"], target["stage"], target["path"]) in record["flags"]
    if kind == "run":
        return record["run"] == target["levels"]
    if kind == "step":
        return target["level"] in record["begun" if target["which"] == "started" else "done"]
    if kind == "path":
        return (target["stage"], target["path"]) in record["paths"]
    return False


def first_session_players(storage, game_id, start, end, filters, config, target, offset, limit):
    """The players behind one row of the first-session results."""
    records, _, _, _ = _scan(storage, game_id, start, end, filters, config)
    members = [record for record in records if _member(record, target)]
    members.sort(key=lambda record: (record["first_seen"], record["player"]), reverse=True)
    return {
        "total": len(members),
        "offset": offset,
        "players": [
            {
                "player": record["player"],
                "first_seen": record["first_seen"],
                "app_version": record["app_version"],
                "levels_in_a_row": record["run"],
                "ended": record["end"][2] if record["end"] else "Played through the last level",
                "ended_at_level": record["end"][0] if record["end"] else None,
            }
            for record in members[offset : offset + limit]
        ],
    }
