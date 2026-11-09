"""Ad analysis: what ads earn, how healthy the ad networks are, and how ads are served.

Three reads over the events a game's ad plugin sends (the names are the AVN events standard's
`AD_ANALYSIS` plus the extra states and `AD_HEALTH_ANALYSIS` that some games send):

- `AD_ANALYSIS` with STATE Show, Closed, Revenue, Blocked or Failed. One ad is one AD_ID: it is
  asked for (Blocked when the game's own rules say no, Failed when no ad was available), shown
  (Show), dismissed (Closed) and, after that, paid (Revenue: NETWORK, REVENUE in USD, AD_UNIT).
  Revenue arrives after Closed and is not sent for every Show, so a show without revenue is
  counted, not hidden.
- `AD_HEALTH_ANALYSIS` Snapshot: counters per ad format over a short window (load requests,
  loaded, failed, shows, impressions...). Each snapshot covers its own window, so they add up.
- `LEVEL_ANALYSIS` results can carry BANNER_REVENUE and BANNER_IMPRESSIONS: banners are not
  AD_ANALYSIS events, so their money is read from there and reported apart.

A game that sends none of these gets `available: false` and a sentence saying so, never zeros.
Revenue is taken to be USD (only some networks say so).
"""

import math
from collections import defaultdict
from statistics import median

from . import insights
from .acquisition import _day_after, _over

AD_EVENT = "AD_ANALYSIS"
HEALTH_EVENT = "AD_HEALTH_ANALYSIS"
LEVEL_EVENT = "LEVEL_ANALYSIS"
REVENUE_GROUPS = (
    "format",
    "placement",
    "network",
    "ad_unit",
    "country",
    "platform",
    "app_version",
    "day",
)
HEALTH_GROUPS = ("format", "country", "platform", "app_version", "day")
SERVING_GROUPS = ("placement", "format")
HEALTH_COUNTERS = (
    "load_requests",
    "loaded",
    "load_failed",
    "requests",
    "not_ready",
    "blocked",
    "show_calls",
    "show_calls_failed",
    "displayed",
    "impressions",
    "recovered",
    "timeouts",
)
MAX_GAP_ROWS = 200_000
ERROR_TEXT = 100  # characters of a load error that identify it


def _ratio(part, whole, digits=4):
    return round(part / whole, digits) if whole else None


def _money(value):
    return round(value or 0.0, 6)


def _choice(value, allowed, default, what):
    value = value or default
    if value not in allowed:
        raise ValueError(f"{what} is one of: {', '.join(allowed)}.")
    return value


def _dimensions(source):
    return {
        "country": source.dimensions["country"],
        "platform": source.dimensions["platform"],
        "app_version": source.dimensions["app_version"],
    }


def _ad_events(connection, source, start, end, filters):
    """The range's AD_ANALYSIS events as a temporary table of plain columns."""
    condition, args = insights.where(start, end, filters, source=source)
    param = source.param
    dimensions = _dimensions(source)
    connection.execute("DROP TABLE IF EXISTS temp.ad_events")
    connection.execute(
        f"""CREATE TEMP TABLE ad_events AS
            SELECT client_ts, substr(client_ts, 1, 10) AS day, {source.player} AS player,
                   {source.session} AS session_id,
                   {dimensions["country"]} AS country, {dimensions["platform"]} AS platform,
                   {dimensions["app_version"]} AS app_version,
                   {param("STATE")} AS state, {param("FORMAT")} AS format,
                   {param("PLACEMENT")} AS placement, {param("AD_ID")} AS ad_id,
                   {param("NETWORK")} AS network, {param("AD_UNIT")} AS ad_unit,
                   {param("REASON")} AS reason, CAST({param("REVENUE")} AS REAL) AS revenue,
                   CAST({param("SECONDS_ON_SCREEN")} AS REAL) AS seconds,
                   CAST({param("REWARDED")} AS INTEGER) AS rewarded
            FROM {source.table} WHERE name=? AND {condition}""",
        [AD_EVENT, *args],
    )


def _absent(what, sends):
    return {
        "available": False,
        "note": f"No {what} in this range. The game may not send {sends}, or nothing was "
        "recorded for these dates and filters.",
    }


def revenue(storage, game_id, start, end, filters, group_by=None, limit=15):
    """Ad money: impressions, revenue, eCPM and revenue per player, in total and by group."""
    group_by = _choice(group_by, REVENUE_GROUPS, "format", "group_by")
    storage.get_game(game_id)
    with storage.connect(storage.game_path(game_id)) as connection:
        source = insights.read_source(storage, connection)
        _ad_events(connection, source, start, end, filters)
        counts = dict(
            connection.execute(
                """SELECT count(DISTINCT CASE WHEN state='Show' THEN ad_id END) AS shown,
                          count(DISTINCT CASE WHEN state='Revenue' THEN ad_id END) AS paid,
                          count(*) FILTER (WHERE state='Revenue') AS impressions,
                          sum(revenue) FILTER (WHERE state='Revenue') AS revenue,
                          count(DISTINCT CASE WHEN state='Revenue' THEN player END) AS players
                   FROM ad_events"""
            ).fetchone()
        )
        if not connection.execute("SELECT 1 FROM ad_events LIMIT 1").fetchone():
            return _absent("ad events", "AD_ANALYSIS")
        condition, args = insights.where(start, end, filters, source=source)
        param = source.param
        banner = dict(
            connection.execute(
                f"""SELECT sum(CAST({param("BANNER_IMPRESSIONS")} AS INTEGER)) AS impressions,
                           sum(CAST({param("BANNER_REVENUE")} AS REAL)) AS revenue
                    FROM {source.table} WHERE name=? AND {condition}""",
                [LEVEL_EVENT, *args],
            ).fetchone()
        )
        activity = dict(
            connection.execute(
                f"""SELECT count(DISTINCT player) AS players, count(*) AS player_days FROM (
                        SELECT DISTINCT substr(client_ts, 1, 10) AS day, {source.player} AS player
                        FROM {source.table} WHERE {condition} AND {source.player} IS NOT NULL)""",
                args,
            ).fetchone()
        )
        groups = [
            dict(row)
            for row in connection.execute(
                f"""SELECT {group_by} AS value, count(*) AS impressions, sum(revenue) AS revenue,
                           count(DISTINCT player) AS players
                    FROM ad_events WHERE state='Revenue' GROUP BY value
                    ORDER BY {"value" if group_by == "day" else "revenue DESC"} LIMIT ?""",
                (max(1, min(int(limit), 40)),),
            )
        ]
    full = counts["revenue"] or 0.0
    banner_money = banner["revenue"] or 0.0
    total = full + banner_money
    result = {
        "available": True,
        "currency": "USD (assumed: only some networks state it)",
        "full_screen": {
            "impressions": counts["impressions"],
            "revenue": _money(full),
            "ecpm": round(full / counts["impressions"] * 1000, 2)
            if counts["impressions"]
            else None,
            "players_paid_for": counts["players"],
        },
        "banner": {
            "impressions": banner["impressions"] or 0,
            "revenue": _money(banner_money),
            "ecpm": round(banner_money / banner["impressions"] * 1000, 2)
            if banner["impressions"]
            else None,
            "note": "Banners are not AD_ANALYSIS events; this is read from the level results.",
        },
        "total_revenue": _money(total),
        "active_players": activity["players"],
        "revenue_per_active_player": round(total / activity["players"], 4)
        if activity["players"]
        else None,
        "arpdau": round(total / activity["player_days"], 4) if activity["player_days"] else None,
        "arpdau_means": "revenue per active player per day (total revenue / player-days)",
        "ads_shown": counts["shown"],
        "ads_shown_with_revenue_reported": counts["paid"],
        "share_of_shows_with_revenue": _ratio(counts["paid"], counts["shown"]),
        "group_by": group_by,
        "groups": [
            {
                "value": row["value"],
                "impressions": row["impressions"],
                "revenue": _money(row["revenue"]),
                "ecpm": round(row["revenue"] / row["impressions"] * 1000, 2)
                if row["impressions"]
                else None,
                "players": row["players"],
                "share_of_full_screen_revenue": _ratio(row["revenue"] or 0, full),
            }
            for row in groups
        ],
    }
    if not counts["impressions"]:
        result["note"] = (
            "Ads were recorded but no Revenue events: this game may not send AD_ANALYSIS Revenue."
        )
    return result


def _health_table(connection, source, start, end, filters):
    condition, args = insights.where(start, end, filters, source=source)
    param = source.param
    dimensions = _dimensions(source)
    counters = ", ".join(
        f"coalesce(CAST({param(name.upper())} AS INTEGER), 0) AS {name}" for name in HEALTH_COUNTERS
    )
    connection.execute("DROP TABLE IF EXISTS temp.ad_health")
    connection.execute(
        f"""CREATE TEMP TABLE ad_health AS
            SELECT substr(client_ts, 1, 10) AS day, {source.player} AS player,
                   {dimensions["country"]} AS country, {dimensions["platform"]} AS platform,
                   {dimensions["app_version"]} AS app_version,
                   {param("FORMAT")} AS format, {param("LAST_LOAD_ERROR")} AS error, {counters}
            FROM {source.table} WHERE name=? AND {condition}""",
        [HEALTH_EVENT, *args],
    )


def _health_row(row):
    row = dict(row)
    return {
        "snapshots": row["snapshots"],
        "players": row["players"],
        "load_requests": row["load_requests"],
        "loaded": row["loaded"],
        "load_failed": row["load_failed"],
        "load_success_rate": _ratio(row["loaded"], row["loaded"] + row["load_failed"]),
        "load_failure_rate": _ratio(row["load_failed"], row["loaded"] + row["load_failed"]),
        "ad_requests": row["requests"],
        "not_ready": row["not_ready"],
        "not_ready_rate": _ratio(row["not_ready"], row["requests"]),
        "blocked_by_game_rules": row["blocked"],
        "show_calls": row["show_calls"],
        "show_calls_failed": row["show_calls_failed"],
        "displayed": row["displayed"],
        "displayed_per_show_call": _ratio(row["displayed"], row["show_calls"]),
        "impressions": row["impressions"],
        "recovered": row["recovered"],
        "timeouts": row["timeouts"],
    }


def health(storage, game_id, start, end, filters, group_by=None, limit=15):
    """Whether ads load and show: network health counters by format, with the usual errors."""
    group_by = _choice(group_by, HEALTH_GROUPS, "format", "group_by")
    storage.get_game(game_id)
    sums = ", ".join(f"sum({name}) AS {name}" for name in HEALTH_COUNTERS)
    with storage.connect(storage.game_path(game_id)) as connection:
        source = insights.read_source(storage, connection)
        _health_table(connection, source, start, end, filters)
        if not connection.execute("SELECT 1 FROM ad_health LIMIT 1").fetchone():
            return _absent("ad health snapshots", "AD_HEALTH_ANALYSIS")
        total = connection.execute(
            "SELECT count(*) AS snapshots, count(DISTINCT player) AS players, "
            f"{sums} FROM ad_health"
        ).fetchone()
        groups = connection.execute(
            f"""SELECT {group_by} AS value, count(*) AS snapshots,
                       count(DISTINCT player) AS players, {sums}
                FROM ad_health GROUP BY value
                ORDER BY {"value" if group_by == "day" else "load_requests DESC"} LIMIT ?""",
            (max(1, min(int(limit), 40)),),
        ).fetchall()
        errors = connection.execute(
            f"""SELECT substr(error, 1, {ERROR_TEXT}) AS error, format, count(*) AS snapshots,
                       count(DISTINCT player) AS players
                FROM ad_health WHERE error IS NOT NULL AND error != ''
                GROUP BY 1, 2 ORDER BY snapshots DESC LIMIT 10"""
        ).fetchall()
    return {
        "available": True,
        "means": (
            "Each snapshot covers a short window and its counts are added up here. "
            "load_success_rate = loaded / (loaded + load_failed): the plugin also counts loads "
            "the game did not ask for (refreshes, preloads), so load_requests can be lower than "
            "loaded and is shown only as a raw count."
        ),
        "total": _health_row(total),
        "group_by": group_by,
        "groups": [{"value": row["value"], **_health_row(row)} for row in groups],
        "last_load_errors": [dict(row) for row in errors],
    }


def serving(storage, game_id, start, end, filters, group_by=None, limit=15):
    """How the game asks for ads: wanted, shown, held back by its rules, failed, and the pacing."""
    group_by = _choice(group_by, SERVING_GROUPS, "placement", "group_by")
    storage.get_game(game_id)
    with storage.connect(storage.game_path(game_id)) as connection:
        source = insights.read_source(storage, connection)
        _ad_events(connection, source, start, end, filters)
        if not connection.execute("SELECT 1 FROM ad_events LIMIT 1").fetchone():
            return _absent("ad events", "AD_ANALYSIS")
        rows = connection.execute(
            f"""SELECT {group_by} AS value,
                       count(DISTINCT ad_id) AS wanted,
                       count(DISTINCT CASE WHEN state='Show' THEN ad_id END) AS shown,
                       count(DISTINCT CASE WHEN state='Closed' THEN ad_id END) AS closed,
                       count(DISTINCT CASE WHEN state='Revenue' THEN ad_id END) AS paid,
                       count(DISTINCT CASE WHEN state='Blocked' THEN ad_id END) AS blocked,
                       count(DISTINCT CASE WHEN state='Failed' THEN ad_id END) AS failed,
                       count(DISTINCT CASE WHEN state='Closed' AND rewarded=1 THEN ad_id END)
                           AS rewarded,
                       count(DISTINCT CASE WHEN state='Closed' AND rewarded IS NOT NULL THEN ad_id
                           END) AS rewarded_asked,
                       avg(CASE WHEN state='Closed' THEN seconds END) AS seconds
                FROM ad_events WHERE ad_id IS NOT NULL GROUP BY value
                ORDER BY wanted DESC LIMIT ?""",
            (max(1, min(int(limit), 40)),),
        ).fetchall()
        reasons = connection.execute(
            f"""SELECT {group_by} AS value, state, coalesce(reason, 'unspecified') AS reason,
                       count(DISTINCT ad_id) AS ads
                FROM ad_events WHERE state IN ('Blocked', 'Failed') AND ad_id IS NOT NULL
                GROUP BY 1, 2, 3 ORDER BY ads DESC"""
        ).fetchall()
        condition, args = insights.where(start, end, filters, source=source)
        sessions = connection.execute(
            f"SELECT count(DISTINCT {source.session}) FROM {source.table} WHERE {condition}", args
        ).fetchone()[0]
        shows = connection.execute(
            "SELECT count(DISTINCT ad_id) FROM ad_events WHERE state='Show'"
        ).fetchone()[0]
        gaps = [
            row[0]
            for row in connection.execute(
                """SELECT (julianday(client_ts) - julianday(previous)) * 86400.0 FROM (
                       SELECT client_ts, lag(client_ts) OVER (
                                  PARTITION BY session_id ORDER BY client_ts) AS previous
                       FROM ad_events WHERE state='Show' AND format='Interstitial'
                             AND session_id IS NOT NULL)
                   WHERE previous IS NOT NULL LIMIT ?""",
                (MAX_GAP_ROWS,),
            )
        ]
    by_value = {}
    for row in reasons:
        by_value.setdefault(row["value"], {}).setdefault(row["state"], {})[row["reason"]] = row[
            "ads"
        ]
    return {
        "available": True,
        "means": (
            "wanted = ads the game tried to show; shown = the ad started; blocked = the game's "
            "own rules held it back (cooldown, level gate...); failed = no ad was available. "
            "closed = the player dismissed it; with_revenue = a Revenue event followed."
        ),
        "group_by": group_by,
        "groups": [
            {
                "value": row["value"],
                "wanted": row["wanted"],
                "shown": row["shown"],
                "shown_share": _ratio(row["shown"], row["wanted"]),
                "blocked": row["blocked"],
                "blocked_by": by_value.get(row["value"], {}).get("Blocked", {}),
                "failed": row["failed"],
                "failed_by": by_value.get(row["value"], {}).get("Failed", {}),
                "closed": row["closed"],
                "with_revenue": row["paid"],
                "reward_given_share": _ratio(row["rewarded"], row["rewarded_asked"])
                if row["rewarded_asked"]
                else None,
                "average_seconds_on_screen": round(row["seconds"], 1) if row["seconds"] else None,
            }
            for row in rows
        ],
        "pacing": {
            "sessions": sessions,
            "ads_shown_per_session": round(shows / sessions, 2) if sessions else None,
            "interstitials_in_same_session_gaps": len(gaps),
            "median_seconds_between_interstitials": round(median(gaps), 1) if gaps else None,
        },
    }


# --- does ad exposure hurt the game? -------------------------------------------------------------

APP_EVENT = "APP_ANALYSIS"
FIRST_OPEN = "first_open"
EXPOSURE_BUCKETS = (("0", 0, 0), ("1-3", 1, 3), ("4-8", 4, 8), ("9+", 9, None))
IMPACT_RETENTION_DAYS = (1, 7)
MAX_IMPACT_PLAYERS = 200_000
MAX_AWAY_ROWS = 200_000


def _percentile(values, fraction):
    """Nearest-rank percentile of a list of numbers (None when empty)."""
    if not values:
        return None
    ordered = sorted(values)
    return ordered[max(0, math.ceil(fraction * len(ordered)) - 1)]


def _leaving_on_ads(connection, source, start, end, filters):
    """Background and Foreground events by cause, and launches that followed an ad on screen."""
    condition, args = insights.where(start, end, filters, source=source)
    param = source.param
    connection.execute("DROP TABLE IF EXISTS temp.app_events")
    connection.execute(
        f"""CREATE TEMP TABLE app_events AS
            SELECT {param("STATE")} AS state, {param("CAUSE")} AS cause,
                   CAST({param("AWAY_SECONDS")} AS REAL) AS away,
                   {param("PREV_EXIT_AD")} AS exit_ad, {param("PREV_EXIT_REASON")} AS reason
            FROM {source.table} WHERE name=? AND {condition}""",
        [APP_EVENT, *args],
    )
    if not connection.execute("SELECT 1 FROM app_events LIMIT 1").fetchone():
        return _absent("app events", "APP_ANALYSIS")
    backgrounds = connection.execute(
        "SELECT coalesce(cause, 'unspecified') AS cause, count(*) AS events FROM app_events "
        "WHERE state='Background' GROUP BY 1 ORDER BY events DESC, cause"
    ).fetchall()
    total = sum(row["events"] for row in backgrounds)
    away = [
        row[0]
        for row in connection.execute(
            "SELECT away FROM app_events WHERE state='Foreground' AND cause='Ad' "
            "AND away IS NOT NULL LIMIT ?",
            (MAX_AWAY_ROWS,),
        )
    ]
    launches = connection.execute(
        "SELECT count(*) FROM app_events WHERE state='Launch'"
    ).fetchone()[0]
    on_ad = connection.execute(
        """SELECT exit_ad AS format, coalesce(reason, 'unknown') AS reason, count(*) AS launches
           FROM app_events WHERE state='Launch' AND exit_ad IS NOT NULL
                 AND exit_ad NOT IN ('None', '') GROUP BY 1, 2 ORDER BY launches DESC, reason"""
    ).fetchall()
    formats = {}
    for row in on_ad:
        entry = formats.setdefault(row["format"], {"launches": 0, "previous_exit_reasons": {}})
        entry["launches"] += row["launches"]
        entry["previous_exit_reasons"][row["reason"]] = row["launches"]
    for entry in formats.values():
        entry["share_of_launches"] = _ratio(entry["launches"], launches)
    after_ad = sum(entry["launches"] for entry in formats.values())
    return {
        "available": True,
        "leaving_the_app": {
            "backgrounds": total,
            "by_cause": {
                row["cause"]: {"events": row["events"], "share": _ratio(row["events"], total)}
                for row in backgrounds
            },
        },
        "coming_back_from_an_ad": {
            "events": len(away),
            "median_away_seconds": round(median(away), 1) if away else None,
            "p90_away_seconds": round(_percentile(away, 0.9), 1) if away else None,
        },
        "launches_after_an_ad_on_screen": {
            "launches": launches,
            "after_an_ad": after_ad,
            "share_of_launches": _ratio(after_ad, launches),
            "by_format": dict(sorted(formats.items(), key=lambda item: -item[1]["launches"])),
        },
    }


def _first_day_retention(connection, source, start, end, filters):
    """Day 1 and day 7 retention of new players by how many ads they saw on their first day."""
    condition, args = insights.where(start, end, filters, source=source)
    table, player, param = source.table, source.player, source.param
    connection.execute("DROP TABLE IF EXISTS temp.impact_cohort")
    connection.execute(
        f"""CREATE TEMP TABLE impact_cohort AS
            SELECT {player} AS pid, substr(min(client_ts), 1, 10) AS cday
            FROM {table} WHERE name=? AND {condition} AND {player} IS NOT NULL
            GROUP BY pid LIMIT {MAX_IMPACT_PLAYERS}""",
        [FIRST_OPEN, *args],
    )
    if not connection.execute("SELECT 1 FROM impact_cohort LIMIT 1").fetchone():
        return _absent("first opens", "first_open (sent by the SDK)")
    cohort = [dict(row) for row in connection.execute("SELECT pid, cday FROM impact_cohort")]
    shown = dict(
        connection.execute(
            f"""SELECT impact_cohort.pid, count(DISTINCT {param("AD_ID")})
                FROM {table} JOIN impact_cohort ON {player} = impact_cohort.pid
                WHERE name=? AND {param("STATE")}='Show'
                      AND substr(client_ts, 1, 10) = impact_cohort.cday
                GROUP BY impact_cohort.pid""",
            [AD_EVENT],
        ).fetchall()
    )
    days = defaultdict(set)
    for pid, day in connection.execute(
        f"""SELECT DISTINCT impact_cohort.pid, substr(client_ts, 1, 10)
            FROM {table} JOIN impact_cohort ON {player} = impact_cohort.pid"""
    ):
        days[pid].add(day)
    last_day = connection.execute(f"SELECT max(substr(client_ts, 1, 10)) FROM {table}").fetchone()[
        0
    ]
    for item in cohort:
        item["ads"] = shown.get(item["pid"], 0)
    buckets = []
    for label, low, high in EXPOSURE_BUCKETS:
        members = [
            item for item in cohort if item["ads"] >= low and (high is None or item["ads"] <= high)
        ]
        row = {"ads_seen_on_first_day": label, "players": len(members)}
        for offset in IMPACT_RETENTION_DAYS:
            eligible = [item for item in members if _over(item, offset, last_day)]
            returned = sum(
                1 for item in eligible if _day_after(item["cday"], offset) in days[item["pid"]]
            )
            row[f"day_{offset}"] = {
                "eligible_players": len(eligible),
                "returned": returned,
                "rate": _ratio(returned, len(eligible)),
            }
        buckets.append(row)
    return {
        "available": True,
        "cohort_players": len(cohort),
        "means": (
            "Players who opened the game for the first time in the range, by the number of "
            "different ads shown on their first day (Show events). Day N is the share who came "
            "back on exactly that day after their first open; only players whose day N is "
            "already over are counted. This shows association, not cause: players who play "
            "more on day one also see more ads, so heavier players land in the higher buckets."
        ),
        "buckets": buckets,
    }


def impact(storage, game_id, start, end, filters):
    """Whether ads cost players: leaving the app on an ad, and first-day ads against retention."""
    storage.get_game(game_id)
    with storage.connect(storage.game_path(game_id)) as connection:
        source = insights.read_source(storage, connection)
        leaving = _leaving_on_ads(connection, source, start, end, filters)
        retention = _first_day_retention(connection, source, start, end, filters)
    if not leaving["available"] and not retention["available"]:
        return _absent("app events or first opens", "APP_ANALYSIS or first_open")
    return {
        "available": True,
        "means": (
            "Two reads. leaving_the_app: how often players leave the app and why (cause Ad = "
            "an ad took them away), how long they were away after an ad, and how many launches "
            "came after a run that ended while an ad was on screen (the previous run was "
            "closed or killed on an ad). first_day_retention: day 1 and day 7 retention of new "
            "players by how many ads they saw on their first day, as association, not cause."
        ),
        "leaving_on_ads": leaving,
        "first_day_retention": retention,
    }
