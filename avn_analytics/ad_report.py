"""The ad widgets shared by the Ads page and a player's summary: every ad state per format, every
failure or block with how often and to whom it happened, and one failure in detail.

All three read the same `AD_ANALYSIS` events as ads.py (one temporary table of plain columns) and
take an optional `player`, so the widgets are the same for the whole game and for one player.

A failure has a kind: `load_failed` (STATE LoadFailed, the reason is the ad SDK's error text),
`show_failed` (STATE Failed, REASON NotReady, ShowFailed...) or `blocked` (STATE Blocked: the
game's own rules said no, REASON Cooldown, LevelGate...). "Sent late" is an event that reached the
server more than two minutes after the phone made it, which is what a phone without internet looks
like: no event says "offline", so this is stated as a reading, not as a fact.
"""

from statistics import median

from . import ads, insights

KINDS = {"LoadFailed": "load_failed", "Failed": "show_failed", "Blocked": "blocked"}
STATE_OF = {kind: state for state, kind in KINDS.items()}
LATE_SECONDS = 120
REASON_TEXT = ads.ERROR_TEXT
MAX_ROWS = 200_000
# One expression for "what went wrong", whatever the state calls it.
REASON = f"CASE WHEN state='LoadFailed' THEN substr(error, 1, {REASON_TEXT}) ELSE reason END"
LATE = f"((julianday(server_ts) - julianday(client_ts)) * 86400 > {LATE_SECONDS})"


def _late_baseline(connection):
    """How often any ad event of this scope arrives late: what a failure's share is judged by."""
    row = connection.execute(
        f"SELECT count(*) FILTER (WHERE {LATE}), count(*) FROM ad_events"
    ).fetchone()
    return ads._ratio(row[0], row[1])


def _failures_only():
    return "state IN ('LoadFailed', 'Failed', 'Blocked')"


def states(storage, game_id, start, end, filters, player=None):
    """Per ad format, how many of each state and what it paid (a format never sent is absent)."""
    storage.get_game(game_id)
    with storage.connect(storage.game_path(game_id)) as connection:
        source = insights.read_source(storage, connection)
        ads._ad_events(connection, source, start, end, filters, player)
        if not connection.execute("SELECT 1 FROM ad_events LIMIT 1").fetchone():
            return ads._absent("ad events", "AD_ANALYSIS")
        rows = [
            dict(row)
            for row in connection.execute(
                """SELECT format,
                          count(*) FILTER (WHERE state='LoadSent') AS load_sent,
                          count(*) FILTER (WHERE state='Loaded') AS loaded,
                          count(*) FILTER (WHERE state='LoadFailed') AS load_failed,
                          count(*) FILTER (WHERE state='Show') AS asked,
                          count(*) FILTER (WHERE state='Blocked') AS blocked,
                          count(*) FILTER (WHERE state='Failed') AS show_failed,
                          count(*) FILTER (WHERE state='Displayed') AS displayed,
                          count(*) FILTER (WHERE state='Creative') AS creative,
                          count(*) FILTER (WHERE state='Closed') AS shown,
                          count(*) FILTER (WHERE state='Revenue') AS paid,
                          coalesce(sum(revenue) FILTER (WHERE state='Revenue'), 0) AS revenue,
                          count(DISTINCT player) FILTER (WHERE state='Show') AS players
                   FROM ad_events WHERE format IS NOT NULL GROUP BY format
                   ORDER BY revenue DESC, asked DESC"""
            )
        ]
        for row in rows:
            row["revenue"] = ads._money(row["revenue"])
        total = dict(
            connection.execute(
                """SELECT count(DISTINCT player) FILTER (WHERE state='Show') AS players,
                          count(*) FILTER (WHERE state='Show') AS asked,
                          count(*) FILTER (WHERE state='Closed') AS shown,
                          coalesce(sum(revenue) FILTER (WHERE state='Revenue'), 0) AS revenue
                   FROM ad_events"""
            ).fetchone()
        )
        total["revenue"] = ads._money(total["revenue"])
        total["shown_share"] = ads._ratio(total["shown"], total["asked"])
        return {"available": True, "formats": rows, "total": total}


def failures(storage, game_id, start, end, filters, player=None):
    """Every failure and block: format, kind, reason, times, players, first and last seen."""
    storage.get_game(game_id)
    with storage.connect(storage.game_path(game_id)) as connection:
        source = insights.read_source(storage, connection)
        ads._ad_events(connection, source, start, end, filters, player)
        rows = [
            dict(row)
            for row in connection.execute(
                f"""SELECT format, state, {REASON} AS reason, count(*) AS times,
                           count(DISTINCT player) AS players,
                           count(*) FILTER (WHERE {LATE}) AS late,
                           min(client_ts) AS first_seen, max(client_ts) AS last_seen
                    FROM ad_events WHERE {_failures_only()} AND format IS NOT NULL
                    GROUP BY format, state, reason ORDER BY times DESC, format"""
            )
        ]
        for row in rows:
            row["kind"] = KINDS[row.pop("state")]
            row["reason"] = row["reason"] or "(no reason sent)"
        return {"available": bool(rows), "rows": rows, "late_baseline": _late_baseline(connection)}


def failure(storage, game_id, start, end, filters, format, kind, reason, player=None):
    """One failure in detail: when, ad unit, where, which players, versions and levels."""
    if kind not in STATE_OF:
        raise ValueError(f"kind is one of: {', '.join(STATE_OF)}.")
    storage.get_game(game_id)
    state = STATE_OF[kind]
    with storage.connect(storage.game_path(game_id)) as connection:
        source = insights.read_source(storage, connection)
        ads._ad_events(connection, source, start, end, filters, player)
        same = (
            f"state=? AND format=? AND ({REASON}) IS ?"
            if reason == "(no reason sent)"
            else f"state=? AND format=? AND ({REASON})=?"
        )
        args = [state, format, None if reason == "(no reason sent)" else reason]
        head = connection.execute(
            f"""SELECT count(*) AS times, count(DISTINCT player) AS players,
                       count(*) FILTER (WHERE {LATE}) AS late,
                       min(client_ts) AS first_seen, max(client_ts) AS last_seen,
                       avg(load_ms) AS load_ms, min(level) AS level_low,
                       max(level) AS level_high
                FROM ad_events WHERE {same}""",
            args,
        ).fetchone()
        if not head["times"]:
            return {"available": False, "note": "That failure didn't happen in these days."}
        span_days = connection.execute(
            "SELECT julianday(?) - julianday(?)", [head["last_seen"], head["first_seen"]]
        ).fetchone()[0]
        unit, cut = ("hour", 13) if span_days <= 3 else ("day", 10)
        when = [
            dict(row)
            for row in connection.execute(
                f"""SELECT substr(client_ts, 1, {cut}) AS at, count(*) AS times
                    FROM ad_events WHERE {same} GROUP BY at ORDER BY at""",
                args,
            )
        ]

        def group(column, limit=8):
            return [
                dict(row)
                for row in connection.execute(
                    f"""SELECT {column} AS value, count(*) AS times,
                               count(DISTINCT player) AS players
                        FROM ad_events WHERE {same} GROUP BY value
                        ORDER BY times DESC LIMIT {limit}""",
                    args,
                )
            ]

        levels = [
            row[0]
            for row in connection.execute(
                f"SELECT level FROM ad_events WHERE {same} AND level IS NOT NULL LIMIT {MAX_ROWS}",
                args,
            )
        ]
        latest = [
            dict(row)
            for row in connection.execute(
                f"""SELECT client_ts, player, country, level, app_version, ad_unit,
                           CAST(round((julianday(server_ts) - julianday(client_ts)) * 86400)
                                AS INTEGER)
                               AS sent_after_seconds
                    FROM ad_events WHERE {same} ORDER BY client_ts DESC LIMIT 8""",
                args,
            )
        ]
        return {
            "available": True,
            "format": format,
            "kind": kind,
            "reason": reason,
            "times": head["times"],
            "players": head["players"],
            "late": head["late"],
            "late_share": ads._ratio(head["late"], head["times"]),
            "late_baseline": _late_baseline(connection),
            "late_after_seconds": LATE_SECONDS,
            "first_seen": head["first_seen"],
            "last_seen": head["last_seen"],
            "load_seconds": round(head["load_ms"] / 1000, 1) if head["load_ms"] else None,
            "level_low": head["level_low"],
            "level_high": head["level_high"],
            "level_median": median(levels) if levels else None,
            "when": {"unit": unit, "points": when},
            "ad_units": group("ad_unit"),
            "countries": group("country"),
            "versions": group("app_version"),
            "placements": group("placement"),
            "top_players": group("player", 5) if not player else [],
            "latest": latest,
        }
