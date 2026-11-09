"""What a game sends and whether it still arrives: the setup, the data health and the guide.

Agents start here: which events a game sends decides which tools can answer, and a quiet data
feed is the first thing to rule out when numbers look wrong.
"""

from datetime import UTC, datetime, timedelta
from pathlib import Path
from statistics import median

from . import cleanup, insights

SKILLS = Path(__file__).parent / "nutbot_skills"
MAX_EVENTS = 40
LAG_SAMPLE = 20_000
RECENT_DAYS = 2

# Which tools have something to read: every (event, state) pair a tool needs (state None: any),
# or, for the "any" tools, at least one of them.
TOOL_NEEDS = {
    "get_ad_revenue": ("all", [("AD_ANALYSIS", "Revenue")]),
    "get_ad_serving": ("all", [("AD_ANALYSIS", None)]),
    "get_ad_health": ("all", [("AD_HEALTH_ANALYSIS", None)]),
    "get_ad_impact": ("all", [("APP_ANALYSIS", None), ("AD_ANALYSIS", None)]),
    "get_acquisition": ("all", [("ATTRIBUTION_ANALYSIS", "Install")]),
    "get_ltv": ("all", [("ATTRIBUTION_ANALYSIS", "Install")]),
    "get_stability": ("all", [("APP_ANALYSIS", "Launch")]),
    "get_economy": ("any", [("ECONOMY_ANALYSIS", None), ("POWERUP_ANALYSIS", None)]),
    "get_onboarding": ("any", [("TUTORIAL_ANALYSIS", None), ("first_open", None)]),
    "get_store": ("any", [("SCREEN_ANALYSIS", None), ("IAP_ANALYSIS", None)]),
    "get_level_attempts": ("all", [("LEVEL_ANALYSIS", "Started")]),
    "get_level_designs": ("all", [("LEVEL_ANALYSIS", "Started")]),
}
TOPICS = ("core", "digest", "exits", "level-review", "player-review", "release-check")

TOOL_MAP = """Tools by question
- Which games, what a game sends, is data arriving: list_games, get_game_setup, get_data_health.
- Overall numbers: get_overview, get_sessions, get_retention, get_event_activity, list_events.
- Levels: get_level_progress, get_exits, get_level_detail, get_level_features, get_level_attempts (one level's tries), get_level_designs (a design reused at many numbers).
- Funnels and paths: run_funnel, get_journeys, list_journey_players.
- Players: find_players, get_player_profile, get_player_story, get_player_levels, get_player_events, get_player_raw_events, compare_player.
- Groups: compare_cohorts, compare_player_groups, list_saved, compare_segments, compare_versions.
- Ads: get_ad_revenue, get_ad_health, get_ad_serving, get_ad_impact.
- Where players came from: get_acquisition, get_ltv. The ad and acquisition tools (and several others, see their schemas) take a `segment`.
- Game systems: get_economy (coins, power-ups), get_onboarding, get_store, get_stability.
- Anything else: count_events counts or averages any event, filtered and grouped.
Revenue is USD. A tool says so when the game doesn't send what it needs; ask get_game_setup which tools have data."""


def _sends(events, requirement):
    event, state = requirement
    found = events.get(event)
    if found is None:
        return False
    return state is None or state in found["states"]


def setup(storage, game_id, start, end):
    """The game, the events it sent in the range, and which tools have data to read."""
    game = storage.get_game(game_id)
    catalog = insights.catalog(storage, game_id, start, end)
    events = {}
    for item in catalog["events"]:
        states = []
        for param in item["params"]:
            if param["key"] == "STATE":
                states = [str(value) for value in param["values"]]
        events[item["name"]] = {
            "name": item["name"],
            "events": item["count"],
            "states": states,
            "parameters": [param["key"] for param in item["params"]][:14],
        }
    tools = {}
    for tool, (mode, needs) in TOOL_NEEDS.items():
        checks = [_sends(events, need) for need in needs]
        tools[tool] = all(checks) if mode == "all" else any(checks)
    versions = [
        {
            "app_version": row["app_version"],
            "events": row["events"],
            "players": row["players"],
            "first_seen": row["first_seen"],
            "last_seen": row["last_seen"],
        }
        for row in sorted(
            cleanup.versions(storage, game_id)["versions"],
            key=lambda row: row["last_seen"] or "",
            reverse=True,
        )[:6]
    ]
    ranked = sorted(events.values(), key=lambda item: -item["events"])
    return {
        "game": {key: game.get(key) for key in ("id", "name", "platform", "bundle_id", "notes")},
        "range": {"from": start[:10], "to_exclusive": end[:10]},
        "events_sent": ranked[:MAX_EVENTS],
        "more_events": max(0, len(ranked) - MAX_EVENTS),
        "tools_with_data": tools,
        "tools_without_data": sorted(name for name, ready in tools.items() if not ready),
        "app_versions": versions,
        "thresholds": storage.analytics_thresholds(game_id),
        "means": (
            "events_sent lists what the game sent in the range with its STATE values and "
            "parameter names. tools_with_data says which specialised tools have something to "
            "read; a tool without data answers with a sentence, not zeros. Thresholds are the "
            "player counts below which the dashboard calls a number too small to trust."
        ),
    }


def _percentile(values, share):
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, max(0, round(share * len(ordered)) - 1))]


def data_health(storage, game_id, days=14):
    """Is data still arriving, how late, and has any event stopped being sent."""
    days = max(2, min(int(days or 14), 60))
    storage.get_game(game_id)
    now = datetime.now(UTC)
    since = (now - timedelta(days=days)).isoformat(timespec="microseconds")
    recent = (now - timedelta(days=RECENT_DAYS)).isoformat(timespec="microseconds")
    with storage.connect(storage.game_path(game_id)) as connection:
        newest = connection.execute("SELECT max(server_ts) FROM events").fetchone()[0]
        per_day = [
            dict(row)
            for row in connection.execute(
                """SELECT substr(server_ts, 1, 10) AS day, count(*) AS events,
                          count(DISTINCT coalesce(json_extract(payload, '$.user_id'),
                                                   json_extract(payload, '$.device_id'))) AS players
                   FROM events WHERE server_ts>=? GROUP BY day ORDER BY day""",
                (since,),
            )
        ]
        lags = [
            row[0]
            for row in connection.execute(
                """SELECT (julianday(server_ts) - julianday(client_ts)) * 86400.0
                   FROM events WHERE server_ts>=? ORDER BY server_ts DESC LIMIT ?""",
                (since, LAG_SAMPLE),
            )
            if row[0] is not None
        ]
        environments = {
            row[0] or "unknown": row[1]
            for row in connection.execute(
                f"SELECT {insights.ENVIRONMENT} AS env, count(*) FROM events "
                "WHERE server_ts>=? GROUP BY 1 ORDER BY 2 DESC",
                (since,),
            )
        }
        earlier = {
            row[0]
            for row in connection.execute(
                "SELECT DISTINCT name FROM events WHERE server_ts>=? AND server_ts<?",
                (since, recent),
            )
        }
        latest = {
            row[0]
            for row in connection.execute(
                "SELECT DISTINCT name FROM events WHERE server_ts>=?", (recent,)
            )
        }
    if not newest:
        return {"available": False, "note": "This game has not received any events yet."}
    quiet_hours = round((now - datetime.fromisoformat(newest)).total_seconds() / 3600, 1)
    result = {
        "available": True,
        "newest_event_received": newest,
        "hours_since_newest_event": quiet_hours,
        "days": per_day,
        "events_by_environment": environments,
        "event_names_gone_quiet": sorted(earlier - latest),
        "means": (
            f"days counts what the server received per day over the last {days} days. Lag is "
            "the time between an event happening on the phone and the server receiving it: a "
            "big share of late events means phones send in bursts or have wrong clocks. "
            f"event_names_gone_quiet were sent earlier in the window but not in the last "
            f"{RECENT_DAYS} days (a release may have dropped them)."
        ),
    }
    if lags:
        result["lag_seconds"] = {
            "sampled_events": len(lags),
            "median": round(median(lags), 1),
            "p90": round(_percentile(lags, 0.9), 1),
            "share_over_one_hour": round(sum(1 for lag in lags if lag > 3600) / len(lags), 4),
        }
    return result


def guide(topic=None):
    topic = topic or "core"
    if topic not in TOPICS:
        raise ValueError(f"topic is one of: {', '.join(TOPICS)}.")
    text = (SKILLS / f"{topic}.md").read_text(encoding="utf-8").strip()
    return {
        "topic": topic,
        "topics": list(TOPICS),
        "guide": text,
        "tool_map": TOOL_MAP,
    }
