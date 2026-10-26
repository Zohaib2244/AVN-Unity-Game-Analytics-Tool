"""Compare early experiences among first-observed players with complete follow-up windows.

Population filters apply to the first observed event. Later version/country changes do not
remove follow-up events. Only environment filters continue to apply to the history. Raw
records are never changed; temporary tables and the standard read source serve this read.
"""

import math
from collections import Counter
from datetime import UTC, datetime, timedelta
from itertools import groupby

from fastapi import HTTPException

from .conditions import numeric_value
from .insights import MAX_FUNNEL_EVENTS, matches, read_source, where
from .journeys import _Reader
from .models import timestamp
from .stories import Labeler

MAX_PLAYERS = 100_000
REASONS = {
    "earlier_history": "First observed before the chosen dates",
    "baseline_filters": "First observed event does not match population filters",
    "excluded_player": "Excluded player ID",
    "excluded_event": "Matched an exclusion before the entry level",
    "no_entry": "No recorded start of the entry level",
    "advanced_save": "First recorded progression is not a start of the entry level",
}


def wilson(reached, players):
    """95% Wilson score interval, in proportions; undefined for an empty group."""
    if not players:
        return None
    z = 1.959963984540054
    p = reached / players
    denominator = 1 + z * z / players
    center = (p + z * z / (2 * players)) / denominator
    half = z * math.sqrt(p * (1 - p) / players + z * z / (4 * players * players)) / denominator
    return max(0, center - half), min(1, center + half)


def difference(a, b):
    """Newcombe interval for the independent A-minus-B difference, using Wilson limits."""
    if not a["players"] or not b["players"]:
        return None
    pa, pb = a["reached"] / a["players"], b["reached"] / b["players"]
    la, ua = wilson(a["reached"], a["players"])
    lb, ub = wilson(b["reached"], b["players"])
    delta = pa - pb
    low = max(-1, delta - math.hypot(pa - la, ub - pb))
    high = min(1, delta + math.hypot(ua - pa, pb - lb))
    return {
        "percentage_points": round(delta * 100, 2),
        "interval": [round(low * 100, 2), round(high * 100, 2)],
        "includes_zero": low <= 0 <= high,
        "method": "Newcombe 95% interval, independent groups",
    }


def _rule(row, definition):
    return matches(definition, row["name"], row["parameters"])


def _measure(rows, behavior, first_ts, deadline):
    """(value, grouping timestamp, missing reason). Duration includes retries and time away."""
    if behavior["kind"] == "level_duration":
        started = None
        for row in rows:
            info = row["level_info"]
            if not info or info[1] != behavior["level"]:
                continue
            if info[0] in ("started", "restarted") and started is None:
                started = row["ts"]
            if info[0] == "completed":
                if started is None:
                    return None, None, "completion_without_start"
                return row["ts"] - started, row["ts"], None
        return None, None, "no_recorded_completion"
    until = min(deadline, first_ts + behavior["window_minutes"] * 60)
    events = [row for row in rows if row["ts"] <= until and _rule(row, behavior["event"])]
    if behavior["kind"] == "event_count":
        return len(events), until, None
    # The first reported value is the experience being compared; later changes cannot replace it.
    for row in events:
        if behavior["parameter"] not in row["parameters"]:
            continue
        value = row["parameters"][behavior["parameter"]]
        if behavior["comparison"] == "equals":
            return str(value), row["ts"], None
        number = numeric_value(value)
        return (
            (number, row["ts"], None) if number is not None else (None, None, "non_numeric_value")
        )
    return None, None, "no_recorded_parameter"


def _outcome(row, outcome):
    if outcome["kind"] == "event":
        return _rule(row, outcome["event"])
    return row["level_info"] == ("started", outcome["level"]) or row["level_info"] == (
        "restarted",
        outcome["level"],
    )


def _labels(behavior):
    if behavior["kind"] == "parameter" and behavior["comparison"] == "equals":
        return f"A · equals {behavior['value']}", "B · other recorded values"
    unit = (
        " s"
        if behavior["kind"] == "level_duration"
        else " events"
        if behavior["kind"] == "event_count"
        else ""
    )
    return f"A · ≤ {behavior['split']:g}{unit}", f"B · > {behavior['split']:g}{unit}"


def compare(storage, game_id, start, end, query, now=None):
    storage.get_game(game_id)
    now = now or datetime.now(UTC)
    cutoff = timestamp(now)
    # Dates select first observations; follow-up may continue beyond the selected end date.
    followup_end = timestamp(
        min(now, datetime.fromisoformat(end) + timedelta(hours=query["outcome"]["window_hours"]))
    )
    reader = _Reader(Labeler(storage.get_dictionary(game_id)))
    minimum = storage.analytics_thresholds(game_id)["levels_min_players"]
    a_label, b_label = _labels(query["behavior"])
    groups = {
        key: {"id": key, "label": label, "players": 0, "reached": 0, "examples": []}
        for key, label in (("a", a_label), ("b", b_label), ("missing", "No recorded behavior"))
    }
    exclusions, missing = Counter(), Counter()
    counts = {
        "candidates": 0,
        "eligible": 0,
        "pending": 0,
        "excluded": 0,
        "outcome_before_group": 0,
    }
    filters = query["filters"]
    history_filters = {key: filters[key] for key in ("environments", "exclude_environments")}
    with storage.connect(storage.game_path(game_id)) as connection:
        connection.execute("BEGIN")
        source = read_source(storage, connection)
        selected, selected_args = where(start, min(end, cutoff), filters, source=source)
        history, history_args = where("0001-01-01", cutoff, history_filters, source=source)
        connection.execute(
            f"""CREATE TEMP TABLE group_candidates AS SELECT DISTINCT {source.player} AS player
                FROM {source.table} WHERE {selected} AND {source.identified} LIMIT ?""",
            (*selected_args, MAX_PLAYERS + 1),
        )
        counts["candidates"] = connection.execute(
            "SELECT count(*) FROM group_candidates"
        ).fetchone()[0]
        if counts["candidates"] > MAX_PLAYERS:
            raise HTTPException(
                400, "Too many players to compare. Choose fewer days or narrower filters."
            )
        connection.execute(
            f"""CREATE TEMP TABLE group_firsts AS
                SELECT {source.player} AS player, min(client_ts) AS first_ts
                FROM {source.table} WHERE {history} AND {source.identified}
                  AND {source.player} IN (SELECT player FROM group_candidates)
                GROUP BY {source.player}""",
            history_args,
        )
        exclusions["earlier_history"] = connection.execute(
            "SELECT count(*) FROM group_firsts WHERE first_ts<?", (start,)
        ).fetchone()[0]
        recent, recent_args = where(start, followup_end, history_filters, source=source)
        rows = connection.execute(
            f"""SELECT {source.player} AS player, {source.session} AS session_id,
                    event_id, name, client_ts,
                    {source.params} AS params, {source.envelope("app_version")} AS app_version,
                    ({selected}) AS selected
                FROM {source.table} WHERE {recent} AND {source.identified}
                  AND {source.player} IN (SELECT player FROM group_firsts WHERE first_ts>=?)
                ORDER BY player, client_ts, event_id LIMIT ?""",
            (*selected_args, *recent_args, start, MAX_FUNNEL_EVENTS + 1),
        )
        read = 0
        for player, stream in groupby(rows, key=lambda row: row["player"]):
            events = []
            for raw in stream:
                read += 1
                if read > MAX_FUNNEL_EVENTS:
                    raise HTTPException(
                        400, "Too much player history. Choose fewer days or narrower filters."
                    )
                row = dict(raw)
                row["ts"] = datetime.fromisoformat(row["client_ts"]).timestamp()
                parameters, info = reader.level(row["name"], row["params"], row["app_version"])
                row.update(parameters=parameters, level_info=info)
                events.append(row)
            _add_player(player, events, query, now.timestamp(), groups, counts, exclusions, missing)
    counts["excluded"] = sum(exclusions.values())
    for group in groups.values():
        n, k = group["players"], group["reached"]
        interval = wilson(k, n)
        group.update(
            rate=round(k / n * 100, 2) if n else None,
            interval=[round(value * 100, 2) for value in interval] if interval else None,
            low_sample=n < minimum,
        )
    return {
        "definition": query,
        "as_of": cutoff,
        "counts": counts,
        "exclusions": [
            {"reason": key, "label": REASONS[key], "players": value}
            for key, value in exclusions.items()
            if value
        ],
        "missing_reasons": dict(missing),
        "groups": list(groups.values()),
        "difference": difference(groups["a"], groups["b"]),
        "minimum_players": minimum,
        "interval_method": "Wilson 95% score intervals",
    }


def _add_player(player, events, query, now_ts, groups, counts, exclusions, missing):
    first = events[0]
    if not first["selected"]:
        exclusions["baseline_filters"] += 1
        return
    if player in query["exclude_players"]:
        exclusions["excluded_player"] += 1
        return
    deadline = first["ts"] + query["outcome"]["window_hours"] * 3600
    events = [row for row in events if row["ts"] <= deadline]
    entry = next((row for row in events if row["level_info"]), None)
    # Exclusions describe baseline data, observed no later than the first progression event.
    baseline_end = entry["ts"] if entry else first["ts"]
    if any(
        _rule(row, rule)
        for row in events
        if row["ts"] <= baseline_end
        for rule in query["exclude_events"]
    ):
        exclusions["excluded_event"] += 1
        return
    if (
        query["entry_level"] is not None
        and entry is not None
        and entry["level_info"]
        not in (("started", query["entry_level"]), ("restarted", query["entry_level"]))
    ):
        exclusions["advanced_save"] += 1
        return
    if deadline > now_ts:
        counts["pending"] += 1
        return
    if query["entry_level"] is not None:
        if entry is None:
            exclusions["no_entry"] += 1
            return
    counts["eligible"] += 1
    value, grouped_at, reason = _measure(events, query["behavior"], first["ts"], deadline)
    outcomes = [row["ts"] for row in events if _outcome(row, query["outcome"])]
    if reason:
        missing[reason] += 1
        group = groups["missing"]
        reached = bool(outcomes)
    else:
        if outcomes and min(outcomes) <= grouped_at:
            counts["outcome_before_group"] += 1
            return
        behavior = query["behavior"]
        a = (
            value == behavior["value"]
            if behavior["kind"] == "parameter" and behavior["comparison"] == "equals"
            else value <= behavior["split"]
        )
        group = groups["a" if a else "b"]
        reached = any(at > grouped_at for at in outcomes)
    group["players"] += 1
    group["reached"] += int(reached)
    if len(group["examples"]) < 50:
        group["examples"].append({"player": player, "reached": reached, "value": value})
