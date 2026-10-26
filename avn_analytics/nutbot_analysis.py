"""Plain computations behind NutBot's analysis tools, kept apart from the tool plumbing.

Everything here works on lists of event dicts as `insights.journey` returns them (name, client_ts,
session_id, params, level) or on the numbers the dashboards already compute, so the agent sees the
same answers the pages show.
"""

from collections import Counter, defaultdict
from datetime import datetime
from statistics import median

# Parameters with more distinct values than this are identifiers or free text: counted, not listed.
MAX_VALUES = 12
MAX_PARAMS = 12
MAX_EVENTS = 60
SESSION_GAP_SECONDS = 30 * 60
SDK_NOISE = {"session_start", "session_end", "first_open"}


def _moment(value):
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def _scalar(value):
    """A parameter value as a short printable key (lists and objects are not counted by value)."""
    if isinstance(value, (dict, list)):
        return None
    return value if isinstance(value, (int, float, bool)) else str(value)[:60]


def event_counts(events, only=None, param_filters=None):
    """What one player did, grouped like the player page's Event Analysis.

    Per event name: times, sessions it appeared in, first/last time, and per parameter the values
    with counts. `only` limits it to one event name; `param_filters` ({param: value}) keeps events
    whose parameters match, so "level_failed where LEVEL=7" reads as one call.
    """
    groups = {}
    for event in events:
        if only and event["name"] != only:
            continue
        params = event.get("params") or {}
        if param_filters and any(
            str(params.get(key)) != str(value) for key, value in param_filters.items()
        ):
            continue
        group = groups.setdefault(
            event["name"],
            {
                "times": 0,
                "sessions": set(),
                "first": None,
                "last": None,
                "params": defaultdict(Counter),
            },
        )
        group["times"] += 1
        group["sessions"].add(event.get("session_id"))
        group["first"] = group["first"] or event.get("client_ts")
        group["last"] = event.get("client_ts")
        for key, value in params.items():
            scalar = _scalar(value)
            if scalar is not None:
                group["params"][key][scalar] += 1
    rows = []
    for name, group in sorted(groups.items(), key=lambda item: -item[1]["times"]):
        params = []
        for key, counts in sorted(group["params"].items(), key=lambda item: len(item[1])):
            entry = {"param": key, "distinct": len(counts)}
            if len(counts) <= MAX_VALUES:
                entry["values"] = [
                    {"value": value, "times": times} for value, times in counts.most_common()
                ]
            else:
                entry["top"] = [
                    {"value": value, "times": times} for value, times in counts.most_common(5)
                ]
                numbers = [v for v in counts.elements() if isinstance(v, (int, float))]
                if numbers and len(numbers) == sum(counts.values()):
                    entry["min"], entry["max"] = min(numbers), max(numbers)
            params.append(entry)
        rows.append(
            {
                "event": name,
                "times": group["times"],
                "sessions": len(group["sessions"]),
                "first": group["first"],
                "last": group["last"],
                "params": params[:MAX_PARAMS],
            }
        )
    return {
        "total_events": sum(row["times"] for row in rows),
        "distinct_events": len(rows),
        "events": rows[:MAX_EVENTS],
        "cut": max(0, len(rows) - MAX_EVENTS),
    }


def level_table(events):
    """One player's levels, in play order: tries, fails, completions, time from start to end.

    Events carry `verb` (started/completed/failed/restarted) from the game's level definitions.
    """
    levels = {}
    open_start = {}
    order = []
    for event in events:
        level = event.get("level")
        verb = event.get("verb")
        if level is None or verb is None:
            continue
        row = levels.get(level)
        if row is None:
            row = levels[level] = {
                "level": level,
                "starts": 0,
                "completes": 0,
                "fails": 0,
                "restarts": 0,
                "seconds": [],
                "first_played": event.get("client_ts"),
            }
            order.append(level)
        row["last_played"] = event.get("client_ts")
        if verb == "started":
            row["starts"] += 1
            open_start[level] = _moment(event.get("client_ts"))
            continue
        row[{"completed": "completes", "failed": "fails", "restarted": "restarts"}[verb]] += 1
        began, ended = open_start.pop(level, None), _moment(event.get("client_ts"))
        if began and ended and 0 <= (ended - began).total_seconds() < 3600:
            row["seconds"].append((ended - began).total_seconds())
    result = []
    for level in order:
        row = levels[level]
        seconds = row.pop("seconds")
        row["median_seconds"] = round(median(seconds), 1) if seconds else None
        row["status"] = (
            "passed"
            if row["completes"]
            else "stuck"
            if row["fails"] >= 3
            else "in progress"
            if row["starts"]
            else "seen"
        )
        result.append(row)
    return result


def summarise_player(events, levels):
    """The player in numbers: span, sessions, activity and how far they got."""
    stamps = [_moment(event.get("client_ts")) for event in events]
    stamps = [stamp for stamp in stamps if stamp]
    sessions = {event.get("session_id") for event in events if event.get("session_id")}
    reached = [row["level"] for row in levels]
    passed = [row["level"] for row in levels if row["completes"]]
    days = {stamp.date() for stamp in stamps}
    return {
        "events": len(events),
        "sessions": len(sessions),
        "active_days": len(days),
        "first_event": events[0]["client_ts"] if events else None,
        "last_event": events[-1]["client_ts"] if events else None,
        "span_days": (stamps[-1] - stamps[0]).days if len(stamps) > 1 else 0,
        "highest_level_reached": max(reached) if reached else None,
        "highest_level_passed": max(passed) if passed else None,
        "levels_stuck": [row["level"] for row in levels if row["status"] == "stuck"],
        "total_fails": sum(row["fails"] for row in levels),
        "last_events": [event["name"] for event in events if event["name"] not in SDK_NOISE][-8:],
    }


def percentile_rank(value, others):
    """Share of `others` at or below `value`, 0-100 (None when there is nobody to compare)."""
    if value is None or not others:
        return None
    return round(100 * sum(1 for other in others if other <= value) / len(others))
