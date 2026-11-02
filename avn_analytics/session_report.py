"""The Sessions page: how long sessions are, how they end, why players left and whether the numbers
can be trusted. Every session comes from session_state.py; nothing here is stored.

A session belongs to the day it started. Events are read a day beyond each end of the range, so a
session that crosses the edge is whole, and is counted only if it began inside.
"""

import json
from collections import Counter, defaultdict
from datetime import datetime, timedelta
from statistics import median

from . import session_state
from .insights import (
    EXCLUDE_FIELDS,
    FILTER_FIELDS,
    LEGACY,
    read_source,
    version_key,
    where,
)
from .models import timestamp
from .session_state import WATCHED_SQL, SessionState, seconds_between

EDGE = timedelta(days=1)
CHANGING_DAYS = 2  # phones deliver late, so today and yesterday can still change
LENGTHS = (
    (10, "Under 10s"),
    (30, "10–30s"),
    (60, "30s–1m"),
    (300, "1–5m"),
    (900, "5–15m"),
    (1800, "15–30m"),
    (None, "Over 30m"),
)
AWAYS = (
    (10, "Under 10s"),
    (30, "10–30s"),
    (60, "30s–1m"),
    (300, "1–5m"),
    (1800, "5–30m"),
    (None, "Over 30m, new session"),
)
TRIPS = ((0, "None"), (1, "1"), (2, "2"), (3, "3"), (4, "4"), (None, "5 or more"))
PLAIN_FILTERS = {"platform", "app_version"}  # what the ingest tally can be filtered by


def _bars(values, buckets):
    counts = Counter()
    for value in values:
        counts[next(label for top, label in buckets if top is None or value <= top)] += 1
    return [{"label": label, "sessions": counts[label]} for _, label in buckets]


def _middle(values):
    return round(median(values), 1) if values else None


def _mean(values):
    return round(sum(values) / len(values), 1) if values else None


class _Session:
    __slots__ = ("state", "player", "version", "platform", "end_delays")

    def __init__(self):
        self.state = SessionState()
        self.player = self.version = self.platform = None
        self.end_delays = []


def _read(connection, source, start, end, filters):
    """Every session touching the range, whole, and the Launch events inside the range."""
    first, last = (
        timestamp(datetime.fromisoformat(start) - EDGE),
        timestamp(datetime.fromisoformat(end) + EDGE),
    )
    condition, args = where(first, last, filters, source=source)
    sessions, launches = defaultdict(_Session), []
    dimensions = source.dimensions
    rows = connection.execute(
        f"""SELECT {source.session} AS session_id, {source.player} AS player, name, client_ts,
                   server_ts, {source.param("seq")} AS seq,
                   CASE WHEN name IN ({WATCHED_SQL}) THEN {source.params} END AS params,
                   {dimensions["app_version"]} AS app_version,
                   {dimensions["platform"]} AS platform
            FROM {source.table} WHERE {condition} AND {source.identified}""",
        args,
    )
    for row in rows:
        name, client_ts, server_ts = row["name"], row["client_ts"], row["server_ts"]
        if row["session_id"] is None:
            continue
        session = sessions[row["session_id"]]
        session.state.add(name, client_ts, server_ts, row["seq"], row["params"])
        session.player = row["player"]
        session.version, session.platform = row["app_version"], row["platform"]
        if name == "session_end":
            session.end_delays.append(seconds_between(client_ts, server_ts))
        elif name == "APP_ANALYSIS" and start <= client_ts < end:
            params = json.loads(row["params"] or "{}")
            if params.get("STATE") == "Launch" and params.get("PREV_EXIT") == "Background":
                launches.append(params)
    return sessions, launches


def _previous_runs(launches):
    """Launches after the app ended in the background: why, and with which ad open."""
    rows = {}
    formats = Counter()
    for params in launches:
        reason = params.get("PREV_EXIT_REASON") or "Unknown"
        importance = params.get("PREV_EXIT_IMPORTANCE") or None
        # "None" is an answer: no ad was open. Absent is an older app that can't say.
        ad = params.get("PREV_EXIT_AD") or "unknown"
        row = rows.setdefault(
            (reason, importance),
            {"reason": reason, "importance": importance, "launches": 0, "ads": Counter()},
        )
        row["launches"] += 1
        row["ads"][ad] += 1
        formats[ad] += 1
    ordered = sorted(rows.values(), key=lambda row: row["launches"], reverse=True)
    return {
        "total": len(launches),
        "formats": [name for name, _ in formats.most_common()],
        "rows": [{**row, "ads": dict(row["ads"])} for row in ordered],
    }


def _measure_change(chosen):
    """The first day and version measured the new way, when older sessions are in the range too."""
    modern = [session for session in chosen if session.state.new_sdk]
    if not modern or len(modern) == len(chosen):
        return None
    version = min((session.version for session in modern), key=version_key)
    return {"version": version, "at": min(session.state.started_at for session in modern)}


def _keeps(filters, platform, app_version):
    values = {"platform": platform, "app_version": app_version}
    for field, dimension in FILTER_FIELDS.items():
        chosen = filters.get(field) or []
        if dimension in PLAIN_FILTERS and chosen and values[dimension] not in chosen:
            return False
    for field, dimension in EXCLUDE_FIELDS.items():
        if dimension in PLAIN_FILTERS and values[dimension] in (filters.get(field) or []):
            return False
    return True


def _tally(connection, start, end, filters):
    rows = connection.execute(
        """SELECT platform, app_version, delivery, sum(accepted) AS accepted,
                  sum(duplicates) AS duplicates, sum(rejected) AS rejected
           FROM ingest_tally WHERE day>=? AND day<=? GROUP BY platform, app_version, delivery""",
        (start[:10], end[:10]),
    ).fetchall()
    return [dict(row) for row in rows if _keeps(filters or {}, row["platform"], row["app_version"])]


def _delivery(connection, start, end, filters, tally):
    """Events per delivery path, and how late a session_end arrived on it."""
    condition, args = where(start, end, filters, source=LEGACY)
    delays = defaultdict(list)
    for row in connection.execute(
        f"""SELECT json_extract(payload, '$.delivery') AS delivery, client_ts, server_ts
            FROM events WHERE {condition} AND name='session_end'""",
        args,
    ):
        if row["delivery"]:
            delays[row["delivery"]].append(seconds_between(row["client_ts"], row["server_ts"]))
    events = Counter()
    for row in tally:
        if row["delivery"]:
            events[row["delivery"]] += row["accepted"]
    return [
        {"delivery": name, "events": count, "median_end_delay": _middle(delays[name])}
        for name, count in events.most_common()
    ]


def _quality(chosen, outcomes, tally):
    """By platform and app version: is the fix working, and is anything being refused?"""
    rows = defaultdict(lambda: {"sessions": 0, "closed": 0, "client": 0, "inferred": 0})
    delays = defaultdict(list)
    for session, outcome in zip(chosen, outcomes, strict=True):
        key = (session.platform, session.version)
        row = rows[key]
        row["sessions"] += 1
        row["closed"] += outcome["status"] == "closed"
        row["client"] += outcome["closed_by"] == "client"
        row["inferred"] += outcome["end_reason"] == "inferred"
        delays[key] += session.end_delays
    counts = defaultdict(Counter)
    for row in tally:
        for field in ("accepted", "duplicates", "rejected"):
            counts[(row["platform"], row["app_version"])][field] += row[field]
    result = []
    for key in rows.keys() | counts.keys():
        row, count = rows[key], counts[key]
        sent = count["accepted"] + count["duplicates"]
        share = 100 / row["closed"] if row["closed"] else None
        result.append(
            {
                "platform": key[0],
                "app_version": key[1],
                **row,
                "client_percent": round(row["client"] * share, 1) if share else None,
                "inferred_percent": round(row["inferred"] * share, 1) if share else None,
                "median_end_delay": _middle(delays[key]),
                "events": sent,
                "duplicate_percent": round(100 * count["duplicates"] / sent, 2) if sent else None,
                "rejected": count["rejected"],
            }
        )
    return sorted(result, key=lambda row: (version_key(row["app_version"]), row["platform"]))[::-1]


def report(storage, game_id, start, end, filters, timezone_offset_minutes=0):
    storage.get_game(game_id)
    now = session_state.clock()
    with storage.connect(storage.game_path(game_id)) as connection:
        source = read_source(storage, connection)
        sessions, launches = _read(connection, source, start, end, filters)
        chosen = [item for item in sessions.values() if start <= item.state.started_at < end]
        tally = _tally(connection, start, end, filters)
        delivery = _delivery(connection, start, end, filters, tally)
    outcomes = [item.state.summary(now) for item in chosen]
    finished = [item for item in outcomes if item["status"] == "closed"]
    lengths = [item["seconds"] for item in finished]
    offset = timedelta(minutes=timezone_offset_minutes)
    days = defaultdict(list)
    for item in outcomes:
        day = (datetime.fromisoformat(item["started_at"]) + offset).date().isoformat()
        days[day].append(item)
    returns = [away for item in chosen for away in item.state.returns]
    inside = [(away, cause) for item in chosen for away, cause in item.state.returns_inside]
    away_total = sum(away for away, _ in inside)
    ad_away = sum(away for away, cause in inside if cause == "Ad")
    leaves = Counter(cause for item in chosen for cause in item.state.trips)
    change = _measure_change(chosen)
    return {
        "sessions": len(chosen),
        "players": len({item.player for item in chosen}),
        "closed": len(finished),
        "in_progress": sum(item["in_progress"] for item in outcomes),
        "waiting": sum(item["status"] == "open" and not item["in_progress"] for item in outcomes),
        "average_seconds": _mean(lengths),
        "median_seconds": _middle(lengths),
        "play_seconds": round(sum(item["seconds"] for item in outcomes), 1),
        "away_seconds": round(away_total, 1),
        "ad_away_seconds": round(ad_away, 1),
        "old_way": sum(item["measured_old_way"] for item in outcomes),
        "ends": dict(Counter(item["end_reason"] for item in finished)),
        "days": [
            {
                "day": day,
                "sessions": len(items),
                "average_seconds": _mean(
                    [item["seconds"] for item in items if item["status"] == "closed"]
                ),
                "median_seconds": _middle(
                    [item["seconds"] for item in items if item["status"] == "closed"]
                ),
            }
            for day, items in sorted(days.items())
        ],
        "changing_from": (now + offset - timedelta(days=CHANGING_DAYS - 1)).date().isoformat(),
        "measure_change": {
            **change,
            "day": (datetime.fromisoformat(change["at"]) + offset).date().isoformat(),
        }
        if change
        else None,
        "lengths": _bars(lengths, LENGTHS),
        "trips": _bars([item["trips"] for item in outcomes], TRIPS),
        "aways": _bars([away for away, _ in returns], AWAYS),
        "leaves": [{"cause": name, "trips": count} for name, count in leaves.most_common()],
        "previous_runs": _previous_runs(launches),
        "quality": _quality(chosen, outcomes, tally),
        "delivery": delivery,
    }
