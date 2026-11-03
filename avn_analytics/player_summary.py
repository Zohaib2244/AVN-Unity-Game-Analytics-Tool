"""One player's numbers at a glance: ads seen, levels cleared and how fast, coins and powerups,
sessions and habits. Counted from the AVN events standard (LEVEL_ANALYSIS, AD_ANALYSIS,
ECONOMY_ANALYSIS, POWERUP_ANALYSIS, ...) over everything the player ever sent, so a game that sends
none of an event simply gets an empty section. Nothing is stored."""

import json
from collections import Counter
from statistics import median

from .insights import read_source

# The standard's events this page reads; everything else is only counted for session lengths.
READ_EVENTS = (
    "LEVEL_ANALYSIS",
    "AD_ANALYSIS",
    "ECONOMY_ANALYSIS",
    "POWERUP_ANALYSIS",
    "PLAYER_ANALYSIS",
    "SCREEN_ANALYSIS",
    "TUTORIAL_ANALYSIS",
    "IAP_ANALYSIS",
    "APP_ANALYSIS",
)
MAX_ROWS = 120_000
LONGEST_LEVEL_SECONDS = 3600  # a clear that took longer is a level left open, not a real time
BALANCE_POINTS = 70
PACE_LEVELS = 120
DAYS_SHOWN = 30
HARDEST = 5


def _number(value):
    return value if isinstance(value, int | float) and not isinstance(value, bool) else None


def _mean(values):
    return round(sum(values) / len(values), 1) if values else None


def _median(values):
    return round(median(values), 1) if values else None


def sessions_summary(spans):
    """spans: [(first_ts, last_ts)] of each session, oldest first. Lengths are not repeated here:
    the player page already shows play time the way sessions are measured (session_state.py)."""
    per_day = Counter(first[:10] for first, _ in spans)
    return {
        "count": len(spans),
        "active_days": len(per_day),
        "per_day": [[day, per_day[day]] for day in sorted(per_day)[-DAYS_SHOWN:]],
    }


def _ads(events):
    formats = {}
    on_screen = []
    for event in events:
        if event["name"] != "AD_ANALYSIS":
            continue
        params = event["params"]
        state = params.get("STATE")
        entry = formats.setdefault(
            str(params.get("FORMAT", "Unknown")),
            {"shown": 0, "closed": 0, "failed": 0, "rewarded": 0, "placements": {}, "reasons": {}},
        )
        if state == "Show":
            entry["shown"] += 1
            place = str(params.get("PLACEMENT", "Unknown"))
            entry["placements"][place] = entry["placements"].get(place, 0) + 1
        elif state == "Closed":
            entry["closed"] += 1
            if str(params.get("REWARDED")) == "1":
                entry["rewarded"] += 1
            if _number(params.get("SECONDS_ON_SCREEN")) is not None:
                on_screen.append(params["SECONDS_ON_SCREEN"])
        elif state == "Failed":
            entry["failed"] += 1
            reason = str(params.get("REASON", "Unknown"))
            entry["reasons"][reason] = entry["reasons"].get(reason, 0) + 1
    return {
        "formats": formats,
        "shown": sum(entry["shown"] for entry in formats.values()),
        "failed": sum(entry["failed"] for entry in formats.values()),
        "average_seconds_on_screen": _mean(on_screen),
    }


def _levels(events):
    by_level = {}
    choices = Counter()
    clear_seconds, moves = [], []
    revives = 0
    for event in events:
        if event["name"] != "LEVEL_ANALYSIS":
            continue
        params = event["params"]
        state = params.get("STATE")
        level = _number(params.get("LEVEL_NUMBER"))
        if state == "Choice":
            choices[str(params.get("ACTION", ""))] += 1
            continue
        if level is None:
            continue
        entry = by_level.setdefault(
            level, {"started": 0, "cleared": 0, "failed": 0, "left": 0, "seconds": None}
        )
        if state == "Started":
            entry["started"] += 1
        elif state == "Completed":
            entry["cleared"] += 1
            seconds = _number(params.get("SECONDS"))
            if seconds is not None and 0 < seconds < LONGEST_LEVEL_SECONDS:
                clear_seconds.append(seconds)
                if entry["seconds"] is None:
                    entry["seconds"] = round(seconds, 1)
            if _number(params.get("MOVES")) is not None:
                moves.append(params["MOVES"])
        elif state == "Failed":
            entry["failed"] += 1
        elif state == "Left":
            entry["left"] += 1
        if state in ("Completed", "Failed") and _number(params.get("REVIVES")) is not None:
            revives += params["REVIVES"]
    cleared = sorted(level for level, entry in by_level.items() if entry["cleared"])
    first_try = sum(
        1
        for level in cleared
        if not by_level[level]["failed"]
        and not by_level[level]["left"]
        and by_level[level]["started"] <= 1
    )

    def bad_attempts(entry):
        retries = entry["started"] - 1 if entry["cleared"] else entry["started"]
        return entry["failed"] + entry["left"] + max(0, retries)

    hardest = sorted(by_level.items(), key=lambda item: -bad_attempts(item[1]))[:HARDEST]
    return {
        "cleared": len(cleared),
        "highest": int(max(by_level)) if by_level else None,
        "clears": sum(entry["cleared"] for entry in by_level.values()),
        "fails": sum(entry["failed"] for entry in by_level.values()),
        "left": sum(entry["left"] for entry in by_level.values()),
        "first_try_clears": first_try,
        "average_seconds": _mean(clear_seconds),
        "median_seconds": _median(clear_seconds),
        "fastest_seconds": round(min(clear_seconds), 1) if clear_seconds else None,
        "slowest_seconds": round(max(clear_seconds), 1) if clear_seconds else None,
        "average_moves": _mean(moves),
        "restarts": choices["Restart"],
        "revives": revives,
        "pace": [
            [int(level), by_level[level]["seconds"]]
            for level in cleared
            if by_level[level]["seconds"] is not None
        ][-PACE_LEVELS:],
        "hardest": [
            {
                "level": int(level),
                "bad_attempts": bad_attempts(entry),
                "cleared": bool(entry["cleared"]),
            }
            for level, entry in hardest
            if bad_attempts(entry) > 0
        ],
    }


def _economy(events):
    earned, spent = Counter(), Counter()
    balance = []
    latest_snapshot = {}
    for event in events:
        params = event["params"]
        if event["name"] == "ECONOMY_ANALYSIS":
            amount = _number(params.get("AMOUNT")) or 0
            if params.get("STATE") == "Earned":
                earned[str(params.get("SOURCE", "Unknown"))] += amount
            elif params.get("STATE") == "Spent":
                spent[str(params.get("DETAIL") or params.get("SOURCE") or "Unknown")] += amount
            if _number(params.get("BALANCE")) is not None:
                balance.append([event["ts"], params["BALANCE"]])
        elif event["name"] == "PLAYER_ANALYSIS" and params.get("STATE") == "Snapshot":
            latest_snapshot = params
    if len(balance) > BALANCE_POINTS:
        balance = balance[:: len(balance) // BALANCE_POINTS + 1] + [balance[-1]]
    inventory = {
        key[len("POWERUP_") :].lower(): value
        for key, value in latest_snapshot.items()
        if key.startswith("POWERUP_")
    }
    currencies = {
        key[len("BALANCE_") :].lower(): value
        for key, value in latest_snapshot.items()
        if key.startswith("BALANCE_")
    }
    return {
        "balances": currencies,
        "balance_history": balance,
        "earned": dict(earned.most_common()),
        "spent": dict(spent.most_common()),
        "inventory": inventory,
        "flags": {
            key.lower(): latest_snapshot[key]
            for key in ("HAS_PURCHASED", "SUB_ACTIVE", "ADS_REMOVED")
            if key in latest_snapshot
        },
        "save_level": latest_snapshot.get("HIGHEST_LEVEL"),
    }


def _powerups(events):
    used, got = Counter(), Counter()
    for event in events:
        if event["name"] != "POWERUP_ANALYSIS":
            continue
        params = event["params"]
        name = str(params.get("POWERUP", "Unknown"))
        if params.get("STATE") == "Used":
            used[name] += 1
        elif params.get("STATE") == "Obtained":
            got[(name, str(params.get("SOURCE", "Unknown")))] += 1
    return {
        "used": dict(used),
        "obtained": [
            {"powerup": name, "source": source, "count": count}
            for (name, source), count in got.items()
        ],
    }


def _habits(events):
    screens, background = Counter(), Counter()
    tutorials = Counter()
    shop_taps = killed = 0
    for event in events:
        params = event["params"]
        state = params.get("STATE")
        if event["name"] == "SCREEN_ANALYSIS" and state == "Opened":
            screens[str(params.get("SCREEN", "Unknown"))] += 1
        elif event["name"] == "APP_ANALYSIS" and state == "Background":
            background[str(params.get("CAUSE", "Unknown"))] += 1
        elif event["name"] == "TUTORIAL_ANALYSIS" and state in ("Shown", "Completed"):
            tutorials[state] += 1
        elif event["name"] == "IAP_ANALYSIS" and state == "Clicked":
            shop_taps += 1
        elif (
            event["name"] == "LEVEL_ANALYSIS"
            and state == "Left"
            and params.get("REASON") == "Killed"
        ):
            killed += 1
    return {
        "screens": dict(screens.most_common(8)),
        "background": dict(background.most_common()),
        "tutorials": {"shown": tutorials["Shown"], "completed": tutorials["Completed"]},
        "shop_taps": shop_taps,
        "levels_ended_by_kill": killed,
    }


def summarize(events, spans):
    """events: [{name, ts, params}] oldest first; spans: [(first_ts, last_ts)] per session."""
    return {
        "sessions": sessions_summary(spans),
        "ads": _ads(events),
        "levels": _levels(events),
        "economy": _economy(events),
        "powerups": _powerups(events),
        **_habits(events),
    }


def player_summary(storage, game_id, player):
    storage.get_game(game_id)
    marks = ",".join("?" for _ in READ_EVENTS)
    with storage.connect(storage.game_path(game_id)) as connection:
        source = read_source(storage, connection)
        table = source.table
        spans = [
            (row["first"], row["last"])
            for row in connection.execute(
                f"""SELECT min(client_ts) AS first, max(client_ts) AS last
                    FROM {table} WHERE {source.player}=?
                    GROUP BY {source.session} ORDER BY first""",
                (player,),
            )
        ]
        rows = connection.execute(
            f"""SELECT name, client_ts, {source.params} AS params FROM {table}
                WHERE {source.player}=? AND name IN ({marks})
                ORDER BY client_ts DESC, event_id DESC LIMIT ?""",
            (player, *READ_EVENTS, MAX_ROWS + 1),
        ).fetchall()
    events = [
        {"name": row["name"], "ts": row["client_ts"], "params": json.loads(row["params"] or "{}")}
        for row in reversed(rows[:MAX_ROWS])  # the newest are kept, oldest first again
    ]
    return {
        "player": player,
        "events_counted": len(events),
        "partial": len(rows) > MAX_ROWS,
        "first_seen": spans[0][0] if spans else None,
        "last_seen": spans[-1][1] if spans else None,
        **summarize(events, spans),
    }
