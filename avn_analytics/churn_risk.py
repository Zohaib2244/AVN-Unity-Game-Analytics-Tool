"""Churn risk: players who have gone quiet for longer than they usually do.

No model, only each player's own habit. From the days a player started a session
(`session_start`, sent by the SDK) we take the usual gap between two days they played (the median
gap) and how long they have been away as of the last day the game sent any data. A player with at
least MIN_ACTIVE_DAYS days played is

- slipping when they have been away at least SLIPPING_RATIO times their usual gap and at least
  SLIPPING_MIN_AWAY days: still worth reaching;
- gone when it is GONE_RATIO times and at least GONE_MIN_AWAY days: probably not coming back;
- left out of the list when they have been away more than MAX_AWAY days (long gone, counted apart).

Everyone else is steady. Test builds are left out. The list is ranked slipping first, then by how
many days the player has played (the more engaged first), then by how much longer than usual.
Each player has a sentence, and may carry a note when they lack the early behaviour that goes with
staying (`separators.py`).
"""

from datetime import date, timedelta
from statistics import median

from . import insights
from .exports import period_bounds

SESSION_EVENT = "session_start"
MIN_ACTIVE_DAYS = 3
SLIPPING_RATIO = 2.0
SLIPPING_MIN_AWAY = 3
GONE_RATIO = 5.0
GONE_MIN_AWAY = 7
MAX_AWAY = 60
STATES = ("slipping", "gone")
CHOICES = ("any", *STATES)
MAX_LISTED = 200
MAX_EXPORT = 50_000
SEPARATOR_DAYS = 90
EXCLUDED = {"exclude_environments": insights.TEST_ENVIRONMENTS}


def classify(day_numbers, as_of):
    """Pure: from the (ordinal) days a player started a session and the ordinal of the day the
    data runs to, the player's state or None. Returns {"state", ...numbers} for a player with
    enough days, state being steady, slipping, gone or long_gone."""
    days = sorted(set(day_numbers))
    if len(days) < MIN_ACTIVE_DAYS:
        return None
    usual = max(1.0, float(median(b - a for a, b in zip(days, days[1:], strict=False))))
    away = max(0, as_of - days[-1])
    ratio = away / usual
    if away > MAX_AWAY:
        state = "long_gone"
    elif ratio >= GONE_RATIO and away >= GONE_MIN_AWAY:
        state = "gone"
    elif ratio >= SLIPPING_RATIO and away >= SLIPPING_MIN_AWAY:
        state = "slipping"
    else:
        state = "steady"
    return {
        "state": state,
        "days_played": len(days),
        "usual_gap": usual,
        "days_away": away,
        "ratio": round(ratio, 2),
        "last_day": date.fromordinal(days[-1]).isoformat(),
    }


def _gap_words(usual):
    if usual <= 1:
        return "every day"
    return f"every {usual:g} days"


def sentence(item):
    """One plain sentence for a player."""
    away = item["days_away"]
    times = f"{item['ratio']:.1f}".rstrip("0").rstrip(".")
    return (
        f"Usually plays {_gap_words(item['usual_gap'])} ({item['days_played']} days played). "
        f"Last played {away} day{'s' if away != 1 else ''} ago, {times}× longer than usual."
    )


def _scan(storage, game_id):
    """The players at risk as of the data's last day ({pid: numbers}), and totals for everyone."""

    def compute():
        with storage.connect(storage.game_path(game_id)) as connection:
            source = insights.read_source(storage, connection)
            condition, args = insights.where("0001-01-01", "9999-12-31", EXCLUDED, source=source)
            last = connection.execute(
                f"SELECT max(substr(client_ts, 1, 10)) FROM {source.table} WHERE {condition}", args
            ).fetchone()[0]
            if not last:
                return {"as_of": None, "risky": {}, "totals": {}}
            as_of = date.fromisoformat(last).toordinal()
            totals = {
                "players": 0,
                "too_new": 0,
                "steady": 0,
                "slipping": 0,
                "gone": 0,
                "long_gone": 0,
            }
            risky = {}
            current, days = None, []

            def finish():
                if current is None:
                    return
                totals["players"] += 1
                found = classify(days, as_of)
                if found is None:
                    totals["too_new"] += 1
                    return
                totals[found["state"]] += 1
                if found["state"] in STATES:
                    risky[current] = found

            for pid, day in connection.execute(
                f"""SELECT {source.player}, substr(client_ts, 1, 10) AS day FROM {source.table}
                    WHERE name=? AND {source.identified} AND {condition}
                    GROUP BY {source.player}, day ORDER BY {source.player}, day""",
                [SESSION_EVENT, *args],
            ):
                if pid != current:
                    finish()
                    current, days = pid, []
                days.append(date.fromisoformat(day).toordinal())
            finish()
            return {"as_of": last, "risky": risky, "totals": totals}

    return storage.scans.get(storage, game_id, ("churn-scan",), compute)


def members(storage, game_id, which="any"):
    """The ids of the players at risk (slipping, gone or either), for a Players group chip."""
    if which not in CHOICES:
        raise ValueError(f"State is one of: {', '.join(CHOICES)}.")
    risky = _scan(storage, game_id)["risky"]
    return sorted(pid for pid, item in risky.items() if which == "any" or item["state"] == which)


def _ranked(risky, which):
    rows = [
        {"player": pid, **item}
        for pid, item in risky.items()
        if which == "any" or item["state"] == which
    ]
    rows.sort(
        key=lambda row: (
            row["state"] != "slipping",
            -row["days_played"],
            -row["ratio"],
            row["player"],
        )
    )
    return rows


def _missing_early(storage, game_id, rows):
    """Adds `missing` (the event's name) and `note` (a sentence) to players who lack the first-day
    behaviour that goes with coming back (the strongest event facts from the separators over the
    last SEPARATOR_DAYS days). Returns those facts with their rates, or []."""
    from . import separators

    with storage.connect(storage.game_path(game_id)) as connection:
        last = connection.execute("SELECT max(substr(client_ts, 1, 10)) FROM events").fetchone()[0]
    if not last or not rows:
        return []
    end = date.fromisoformat(last) + timedelta(days=1)
    start, stop = period_bounds("custom", end - timedelta(days=SEPARATOR_DAYS), end)
    facts = separators.analyse(storage, game_id, start, stop, EXCLUDED, "day_7", 1)
    if not facts.get("available"):
        return []
    wanted = [
        item
        for item in facts["more_likely"]
        if item["kind"] == "event" and item.get("at_least", 1) <= 1
    ][:2]
    if not wanted:
        return []
    keys = {item["key"]: item for item in wanted}
    ids = [row["player"] for row in rows]
    with storage.connect(storage.game_path(game_id)) as connection:
        source = insights.read_source(storage, connection)
        connection.execute("DROP TABLE IF EXISTS temp.churn_ids")
        connection.execute("CREATE TEMP TABLE churn_ids(pid TEXT PRIMARY KEY)")
        connection.executemany("INSERT OR IGNORE INTO churn_ids VALUES (?)", [(i,) for i in ids])
        connection.execute("DROP TABLE IF EXISTS temp.churn_firsts")
        connection.execute(
            f"""CREATE TEMP TABLE churn_firsts AS
                SELECT {source.player} AS pid, substr(min(client_ts), 1, 10) AS cday
                FROM {source.table} WHERE {source.player} IN (SELECT pid FROM churn_ids)
                GROUP BY pid"""
        )
        marks = ",".join("?" * len(keys))
        key_sql = f"name || coalesce(' ' || nullif({source.param('STATE')}, ''), '')"
        had = {
            (row[0], row[1])
            for row in connection.execute(
                f"""SELECT {source.player}, {key_sql}
                    FROM {source.table} JOIN churn_firsts ON {source.player} = churn_firsts.pid
                    WHERE substr(client_ts, 1, 10) = churn_firsts.cday
                          AND {key_sql} IN ({marks})
                    GROUP BY {source.player}, 2""",
                list(keys),
            )
        }
    for row in rows:
        for key, item in keys.items():
            if (row["player"], key) not in had:
                row["missing"] = item["human"]
                row["note"] = (
                    f"Did not have “{item['human']}” on their first day; players who did came "
                    f"back on day 7 {item['with']['rate'] * 100:.0f}% of the time, the others "
                    f"{item['without']['rate'] * 100:.0f}%."
                )
                break
    return [
        {
            "human": item["human"],
            "with_rate": item["with"]["rate"],
            "without_rate": item["without"]["rate"],
        }
        for item in wanted
        if any(row.get("missing") == item["human"] for row in rows)
    ]


def at_risk(storage, game_id, which="any", limit=100, everything=False):
    """The players who have gone quiet longer than usual, ranked, each with a sentence."""
    if which not in CHOICES:
        raise ValueError(f"state is one of: {', '.join(CHOICES)}.")
    storage.get_game(game_id)
    scan = _scan(storage, game_id)
    if not scan["as_of"]:
        return {
            "available": False,
            "note": "No sessions yet (the SDK sends session_start): nobody to measure.",
        }
    totals = scan["totals"]
    if not totals["players"] - totals["too_new"]:
        return {
            "available": False,
            "note": f"No player has played on {MIN_ACTIVE_DAYS} different days yet, so nobody "
            "has a usual rhythm to compare with.",
        }
    rows = _ranked(scan["risky"], which)
    cap = MAX_EXPORT if everything else max(1, min(int(limit), MAX_LISTED))
    shown = rows[:cap]
    early = _missing_early(storage, game_id, shown)
    for row in shown:
        row["words"] = sentence(row)
    return {
        "available": True,
        "as_of": scan["as_of"],
        "means": (
            f"Each player's usual gap is the median number of days between two days they started "
            f"a session (players with at least {MIN_ACTIVE_DAYS} days played). Slipping: away at "
            f"least {SLIPPING_RATIO:g}× the usual gap and {SLIPPING_MIN_AWAY}+ days. Gone: "
            f"{GONE_RATIO:g}× and {GONE_MIN_AWAY}+ days. Away more than {MAX_AWAY} days is long "
            "gone and not listed. Counted as of the last day the game sent data."
        ),
        "counts": {
            "measured": totals["players"] - totals["too_new"],
            "steady": totals["steady"],
            "slipping": totals["slipping"],
            "gone": totals["gone"],
            "long_gone": totals["long_gone"],
            "too_new": totals["too_new"],
        },
        "state": which,
        "early_facts": early,
        "listed": len(shown),
        "total": len(rows),
        "players": shown,
    }


COLUMNS = (
    ("player", "player_id"),
    ("state", "state"),
    ("last_day", "last_played"),
    ("days_away", "days_away"),
    ("usual_gap", "usual_gap_days"),
    ("days_played", "days_played"),
    ("words", "why"),
    ("note", "early_behaviour_note"),
)


def _cell(value):
    """A spreadsheet cell that is text, never a formula (a player ID can start with = or @)."""
    text = "" if value is None else str(value)
    return "'" + text if text[:1] in ("=", "+", "-", "@", "\t", "\r") else text


def csv_text(result):
    """The ranked list as CSV text, for people to take to a messaging or ad tool."""
    import csv
    import io

    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow([name for _, name in COLUMNS])
    for row in result["players"]:
        writer.writerow([_cell(row.get(key)) for key, _ in COLUMNS])
    return out.getvalue()
