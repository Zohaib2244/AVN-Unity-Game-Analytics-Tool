"""Acquisition: where players came from, what they did afterwards and what they earned.

The cohort is the players whose first open (`first_open`, sent by the SDK) falls in the range.
Each is matched to the attribution result the game sent for them, `ATTRIBUTION_ANALYSIS` with
STATE Install (MEDIA_SOURCE, CAMPAIGN, CHANNEL, AD, SITE_ID, AF_STATUS), whenever it arrived; a
player with none is "Unattributed", kept apart from "organic" (a source the service named). Days
are UTC days counted from the first-open day, and a day only counts for a player once it is over
in the data: a player who opened yesterday has no day-7 answer yet, and is left out of day 7's
numbers instead of counted as lost.

Money is ad revenue: the Revenue events of `AD_ANALYSIS` plus the banner revenue that level
results carry, taken to be USD.
"""

from collections import defaultdict
from datetime import date, timedelta
from statistics import median

from . import insights

FIRST_OPEN = "first_open"
ATTRIBUTION = "ATTRIBUTION_ANALYSIS"
AD_EVENT = "AD_ANALYSIS"
LEVEL_EVENT = "LEVEL_ANALYSIS"
IAP_EVENT = "IAP_ANALYSIS"
GROUPS = ("media_source", "campaign", "channel", "creative", "site", "status")
RETENTION_DAYS = (1, 3, 7)
LTV_DAYS = (0, 1, 3, 7, 14, 30)
MAX_LTV_DAY = 90
MAX_PLAYERS = 200_000
UNATTRIBUTED = "Unattributed"


def _ratio(part, whole, digits=4):
    return round(part / whole, digits) if whole else None


def _load(storage, game_id, start, end, filters):
    """The cohort with what each player did, read in one go. Returns (players, last day) or the
    sentence to give when the game doesn't have the data."""
    storage.get_game(game_id)
    with storage.connect(storage.game_path(game_id)) as connection:
        source = insights.read_source(storage, connection)
        table, player, param = source.table, source.player, source.param
        if not connection.execute(
            f"SELECT 1 FROM {table} WHERE name=? LIMIT 1", (ATTRIBUTION,)
        ).fetchone():
            return {
                "available": False,
                "note": "This game sends no attribution (ATTRIBUTION_ANALYSIS), so players "
                "can't be grouped by where they came from.",
            }
        condition, args = insights.where(start, end, filters, source=source)
        connection.execute("DROP TABLE IF EXISTS temp.cohort")
        connection.execute(
            f"""CREATE TEMP TABLE cohort AS
                SELECT f.pid AS pid, f.cday AS cday,
                       coalesce(a.media_source, '{UNATTRIBUTED}') AS media_source,
                       coalesce(a.campaign, '{UNATTRIBUTED}') AS campaign,
                       coalesce(a.channel, '{UNATTRIBUTED}') AS channel,
                       coalesce(a.creative, '{UNATTRIBUTED}') AS creative,
                       coalesce(a.site, '{UNATTRIBUTED}') AS site,
                       coalesce(a.status, '{UNATTRIBUTED}') AS status,
                       a.pid IS NOT NULL AS attributed, a.click AS click
                FROM (SELECT {player} AS pid, substr(min(client_ts), 1, 10) AS cday
                      FROM {table} WHERE name=? AND {condition} AND {player} IS NOT NULL
                      GROUP BY pid) f
                LEFT JOIN (SELECT {player} AS pid, {param("MEDIA_SOURCE")} AS media_source,
                                  {param("CAMPAIGN")} AS campaign, {param("CHANNEL")} AS channel,
                                  {param("AD")} AS creative, {param("SITE_ID")} AS site,
                                  {param("AF_STATUS")} AS status,
                                  {param("CLICK_TIME")} AS click, min(client_ts) AS first
                           FROM {table}
                           WHERE name=? AND {param("STATE")}='Install' AND {player} IS NOT NULL
                           GROUP BY pid) a ON a.pid = f.pid
                LIMIT {MAX_PLAYERS}""",
            [FIRST_OPEN, *args, ATTRIBUTION],
        )
        if not connection.execute("SELECT 1 FROM cohort LIMIT 1").fetchone():
            return {
                "available": False,
                "note": "No player opened the game for the first time in this range "
                "(with these filters).",
            }
        connection.execute("DROP TABLE IF EXISTS temp.activity")
        connection.execute(
            f"""CREATE TEMP TABLE activity AS
                SELECT cohort.pid AS pid, substr(client_ts, 1, 10) AS day,
                       sum(CASE WHEN name=? AND {param("STATE")}='Revenue'
                                THEN coalesce(CAST({param("REVENUE")} AS REAL), 0) ELSE 0 END)
                           AS ad_revenue,
                       sum(CASE WHEN name=?
                                THEN coalesce(CAST({param("BANNER_REVENUE")} AS REAL), 0)
                                ELSE 0 END) AS banner_revenue,
                       max(CASE WHEN name=? AND {param("STATE")}='Completed'
                                THEN CAST({param("LEVEL_NUMBER")} AS INTEGER) END) AS level,
                       max(CASE WHEN name=? AND {param("STATE")}='Clicked' THEN 1 ELSE 0 END)
                           AS clicked
                FROM {table} JOIN cohort ON {player} = cohort.pid
                GROUP BY cohort.pid, day""",
            [AD_EVENT, LEVEL_EVENT, LEVEL_EVENT, IAP_EVENT],
        )
        cohort = [dict(row) for row in connection.execute("SELECT * FROM cohort")]
        days = defaultdict(dict)
        highest, clicked = {}, set()
        for row in connection.execute("SELECT * FROM activity"):
            days[row["pid"]][row["day"]] = (row["ad_revenue"] or 0.0) + (
                row["banner_revenue"] or 0.0
            )
            if row["level"] is not None:
                highest[row["pid"]] = max(highest.get(row["pid"], 0), row["level"])
            if row["clicked"]:
                clicked.add(row["pid"])
        last_day, first_day = connection.execute(
            f"SELECT max(substr(client_ts, 1, 10)), min(substr(client_ts, 1, 10)) FROM {table}"
        ).fetchone()
    for item in cohort:
        item["days"] = days.get(item["pid"], {})
        item["level"] = highest.get(item["pid"])
        item["clicked"] = item["pid"] in clicked
    return {"players": cohort, "last_day": last_day, "first_day": first_day}


def _day_after(day, offset):
    return (date.fromisoformat(day) + timedelta(days=offset)).isoformat()


def _over(player, offset, last_day):
    """Whether the day `offset` days after this player's first open is over in the data."""
    return _day_after(player["cday"], offset) < last_day


def _groups(players, group_by, limit):
    grouped = defaultdict(list)
    for player in players:
        grouped[player[group_by]].append(player)
    ranked = sorted(grouped.items(), key=lambda item: (-len(item[1]), str(item[0])))
    return ranked[: max(1, min(int(limit), 40))]


def _choice(value, allowed, default, what):
    value = value or default
    if value not in allowed:
        raise ValueError(f"{what} is one of: {', '.join(allowed)}.")
    return value


def _retention(players, last_day):
    result = {}
    for offset in RETENTION_DAYS:
        eligible = [item for item in players if _over(item, offset, last_day)]
        returned = sum(1 for item in eligible if _day_after(item["cday"], offset) in item["days"])
        result[f"day_{offset}"] = {
            "eligible_players": len(eligible),
            "returned": returned,
            "rate": _ratio(returned, len(eligible)),
        }
    return result


def _row(value, players, total, last_day):
    reached = [item["level"] for item in players if item["level"] is not None]
    return {
        "value": value,
        "installs": len(players),
        "share_of_installs": _ratio(len(players), total),
        "retention": _retention(players, last_day),
        "completed_a_level_share": _ratio(len(reached), len(players)),
        "median_highest_level_completed": median(reached) if reached else None,
        "clicked_a_store_button_share": _ratio(
            sum(1 for i in players if i["clicked"]), len(players)
        ),
    }


def acquisition(storage, game_id, start, end, filters, group_by=None, limit=15):
    """Installs by source, campaign, channel, creative or site, with what each group did."""
    group_by = _choice(group_by, GROUPS, "media_source", "group_by")
    data = _load(storage, game_id, start, end, filters)
    if "players" not in data:
        return data
    players, last_day = data["players"], data["last_day"]
    result = {
        "available": True,
        "cohort": "players whose first open was in the range",
        "means": (
            "Retention is the share who came back on exactly that day after their first open; "
            "only players whose day is already over are counted. 'Unattributed' players have "
            "no attribution record (it may not have arrived); 'organic' is a source the "
            "attribution service named. For revenue by source use get_ltv."
        ),
        "group_by": group_by,
        "installs": len(players),
        "all": _row("all", players, len(players), last_day),
        "groups": [
            _row(value, members, len(players), last_day)
            for value, members in _groups(players, group_by, limit)
        ],
    }
    if len(players) >= MAX_PLAYERS:
        result["note"] = f"Only the first {MAX_PLAYERS} players are counted. Use a shorter range."
    return result


def ltv(storage, game_id, start, end, filters, group_by=None, days=None, limit=15):
    """Cumulative ad revenue per player by day since first open, by install source."""
    group_by = _choice(group_by, GROUPS, "media_source", "group_by")
    days = sorted({int(day) for day in days or LTV_DAYS})
    if not days or days[0] < 0 or days[-1] > MAX_LTV_DAY:
        raise ValueError(f"days are whole numbers from 0 to {MAX_LTV_DAY}.")
    data = _load(storage, game_id, start, end, filters)
    if "players" not in data:
        return data
    players, last_day = data["players"], data["last_day"]

    def row(value, members):
        ltv_by_day = {}
        for offset in days:
            eligible = [item for item in members if _over(item, offset, last_day)]
            earned = sum(
                money
                for item in eligible
                for day, money in item["days"].items()
                if day <= _day_after(item["cday"], offset)
            )
            ltv_by_day[f"day_{offset}"] = {
                "eligible_players": len(eligible),
                "revenue_per_player": round(earned / len(eligible), 4) if eligible else None,
            }
        return {"value": value, "installs": len(members), "ltv": ltv_by_day}

    return {
        "available": True,
        "currency": "USD (assumed: only some networks state it)",
        "means": (
            "Cumulative ad revenue (full-screen ads plus banners) per player from the first-open "
            "day up to and including day N, for players whose day N is already over. The "
            "eligible_players count says how many players each number rests on."
        ),
        "group_by": group_by,
        "all": row("all", players),
        "groups": [row(value, members) for value, members in _groups(players, group_by, limit)],
    }
