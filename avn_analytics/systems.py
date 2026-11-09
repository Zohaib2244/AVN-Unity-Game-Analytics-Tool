"""Game systems: the economy, power-ups, onboarding and the store.

Each reads the analysis events a game's own code sends (the AVN events standard names):

- `ECONOMY_ANALYSIS`: CURRENCY, STATE Earned or Spent, SOURCE, AMOUNT, BALANCE, DETAIL,
  LEVEL_NUMBER.
- `POWERUP_ANALYSIS`: STATE Obtained or Used, POWERUP, SOURCE, TRIGGER, AMOUNT, LEVEL_NUMBER.
- `TUTORIAL_ANALYSIS`: STATE Shown, Completed or Interrupted, TUTORIAL, SECONDS.
- `SCREEN_ANALYSIS`: SCREEN, STATE Opened, Interaction or Closed, ACTION, CLOSED_BY, SECONDS_OPEN.
- `IAP_ANALYSIS`: STATE Clicked, Purchased, Failed or SubActivated, PRODUCT, PRICE, PRICE_CURRENCY.

A game that doesn't send what a read needs gets `available: false` and a sentence, never zeros.
Money in the store is reported per currency and never converted. Everything here is read-only.
"""

from collections import defaultdict
from statistics import median

from . import insights
from .ads import _absent, _choice, _money, _ratio

ECONOMY_EVENT = "ECONOMY_ANALYSIS"
POWERUP_EVENT = "POWERUP_ANALYSIS"
TUTORIAL_EVENT = "TUTORIAL_ANALYSIS"
SCREEN_EVENT = "SCREEN_ANALYSIS"
IAP_EVENT = "IAP_ANALYSIS"
LEVEL_EVENT = "LEVEL_ANALYSIS"
FIRST_OPEN = "first_open"
ECONOMY_VIEWS = ("currency", "powerups")
REACHED_LEVELS = (1, 3, 5, 10)
DEFAULT_BAND = 25
MAX_BAND = 1000
MAX_BANDS = 40
MAX_CURRENCIES = 10
MAX_ROWS = 500_000
KINDS = {
    "text": "{p}",
    "int": "CAST({p} AS INTEGER)",
    "real": "CAST({p} AS REAL)",
}


def scoped(connection, source, start, end, filters, name, table, columns):
    """The range's events called `name` as a temporary table of plain columns.

    `columns` maps a column to (parameter, kind) with kind text, int or real. Every table also has
    client_ts, day, player and session_id. Returns how many events it holds.
    """
    condition, args = insights.where(start, end, filters, source=source)
    chosen = "".join(
        f", {KINDS[kind].format(p=source.param(key))} AS {alias}"
        for alias, (key, kind) in columns.items()
    )
    connection.execute(f"DROP TABLE IF EXISTS temp.{table}")
    connection.execute(
        f"""CREATE TEMP TABLE {table} AS
            SELECT client_ts, substr(client_ts, 1, 10) AS day, {source.player} AS player,
                   {source.session} AS session_id{chosen}
            FROM {source.table} WHERE name=? AND {condition}""",
        [name, *args],
    )
    return connection.execute(f"SELECT count(*) FROM {table}").fetchone()[0]


def _limit(value, default=15):
    return max(1, min(int(value or default), 40))


def _by(rows):
    """Group (key, value) pairs into {key: [values]}."""
    grouped = defaultdict(list)
    for key, value in rows:
        grouped[key].append(value)
    return grouped


# --- economy -------------------------------------------------------------------------------------


def _flow(connection, currency, state):
    total = connection.execute(
        "SELECT coalesce(sum(amount), 0) AS amount, count(*) AS events, "
        "count(DISTINCT player) AS players FROM econ WHERE currency=? AND state=?",
        (currency, state),
    ).fetchone()
    sources = connection.execute(
        """SELECT coalesce(source, 'unspecified') AS source, coalesce(sum(amount), 0) AS amount,
                  count(*) AS events
           FROM econ WHERE currency=? AND state=? GROUP BY 1
           ORDER BY amount DESC, source LIMIT 10""",
        (currency, state),
    ).fetchall()
    details = connection.execute(
        """SELECT detail, coalesce(sum(amount), 0) AS amount, count(*) AS events
           FROM econ WHERE currency=? AND state=? AND detail IS NOT NULL AND detail != ''
           GROUP BY detail ORDER BY amount DESC, detail LIMIT 5""",
        (currency, state),
    ).fetchall()
    amount = total["amount"]
    return {
        "amount": _money(amount),
        "events": total["events"],
        "players": total["players"],
        "by_source": [
            {
                "source": row["source"],
                "amount": _money(row["amount"]),
                "events": row["events"],
                "share": _ratio(row["amount"], amount),
            }
            for row in sources
        ],
        "top_details": [
            {"detail": row["detail"], "amount": _money(row["amount"]), "events": row["events"]}
            for row in details
        ],
    }


def _bands(connection, currency, band):
    rows = connection.execute(
        "SELECT (max(level, 1) - 1) / ? AS band, balance FROM econ "
        "WHERE currency=? AND balance IS NOT NULL AND level IS NOT NULL LIMIT ?",
        (band, currency, MAX_ROWS),
    ).fetchall()
    grouped = _by((row["band"], row["balance"]) for row in rows)
    result = []
    for index in sorted(grouped)[:MAX_BANDS]:
        first = index * band + 1
        values = grouped[index]
        result.append(
            {
                "levels": f"{first}-{first + band - 1}",
                "first_level": first,
                "balance_readings": len(values),
                "median_balance": round(median(values), 1),
            }
        )
    return result


def _currencies(connection, source, start, end, filters, band):
    columns = {
        "currency": ("CURRENCY", "text"),
        "state": ("STATE", "text"),
        "source": ("SOURCE", "text"),
        "amount": ("AMOUNT", "real"),
        "balance": ("BALANCE", "real"),
        "detail": ("DETAIL", "text"),
        "level": ("LEVEL_NUMBER", "int"),
    }
    if not scoped(connection, source, start, end, filters, ECONOMY_EVENT, "econ", columns):
        return _absent("economy events", "ECONOMY_ANALYSIS")
    connection.execute("UPDATE econ SET currency='unknown' WHERE currency IS NULL OR currency=''")
    names = [
        row[0]
        for row in connection.execute(
            "SELECT currency FROM econ GROUP BY currency ORDER BY count(*) DESC, currency LIMIT ?",
            (MAX_CURRENCIES,),
        )
    ]
    currencies = []
    for name in names:
        earned = _flow(connection, name, "Earned")
        spent = _flow(connection, name, "Spent")
        from_ads = next(
            (row["amount"] for row in earned["by_source"] if row["source"] == "rewarded_ad"), 0.0
        )
        currencies.append(
            {
                "currency": name,
                "earned": earned,
                "spent": spent,
                "net": _money(earned["amount"] - spent["amount"]),
                "share_of_earned_from_rewarded_ads": _ratio(from_ads, earned["amount"]),
                "median_balance_by_level_band": _bands(connection, name, band),
            }
        )
    return {
        "available": True,
        "view": "currency",
        "means": (
            "Per currency: what players earned and spent (total amount, events, distinct "
            "players), split by SOURCE with its share of the total and the most common DETAIL "
            "values. share_of_earned_from_rewarded_ads is the part of everything earned whose "
            f"source is rewarded_ad. median_balance_by_level_band is the median of the BALANCE "
            f"readings the events carry, by bands of {band} levels (LEVEL_NUMBER)."
        ),
        "band": band,
        "currencies": currencies,
    }


def _powerups(connection, source, start, end, filters):
    columns = {
        "state": ("STATE", "text"),
        "powerup": ("POWERUP", "text"),
        "source": ("SOURCE", "text"),
        "trig": ("TRIGGER", "text"),
        "amount": ("AMOUNT", "real"),
    }
    if not scoped(connection, source, start, end, filters, POWERUP_EVENT, "powerups", columns):
        return {
            **_absent("power-up events", "POWERUP_ANALYSIS"),
            "powerups": [],
        }
    rows = connection.execute(
        """SELECT coalesce(powerup, 'unknown') AS powerup, state,
                  count(*) AS events, count(DISTINCT player) AS players,
                  sum(coalesce(amount, 1)) AS amount
           FROM powerups WHERE state IN ('Obtained', 'Used') GROUP BY 1, 2"""
    ).fetchall()
    breakdown = connection.execute(
        """SELECT coalesce(powerup, 'unknown') AS powerup, state,
                  coalesce(CASE WHEN state='Obtained' THEN source ELSE trig END,
                           'unspecified') AS how, sum(coalesce(amount, 1)) AS amount
           FROM powerups WHERE state IN ('Obtained', 'Used') GROUP BY 1, 2, 3
           ORDER BY amount DESC, how"""
    ).fetchall()
    players = {
        row["powerup"]: row["players"]
        for row in connection.execute(
            "SELECT coalesce(powerup, 'unknown') AS powerup, count(DISTINCT player) AS players "
            "FROM powerups GROUP BY 1"
        )
    }
    found = defaultdict(lambda: {"obtained": None, "used": None})
    for row in rows:
        found[row["powerup"]][row["state"].lower()] = row
    result = []
    for name, states in found.items():
        entry = {"powerup": name, "players": players[name]}
        for state, label in (("obtained", "by_source"), ("used", "by_trigger")):
            row = states[state]
            entry[state] = {
                "amount": _money(row["amount"]) if row else 0,
                "events": row["events"] if row else 0,
                "players": row["players"] if row else 0,
                label: {
                    item["how"]: _money(item["amount"])
                    for item in breakdown
                    if item["powerup"] == name and item["state"] == state.capitalize()
                },
            }
        result.append(entry)
    result.sort(key=lambda e: (-(e["obtained"]["events"] + e["used"]["events"]), e["powerup"]))
    return {"available": True, "powerups": result}


def _with_and_without(connection, source, start, end, filters):
    """Completed share of level results by whether power-ups were used in the attempt."""
    columns = {"state": ("STATE", "text"), "used": ("POWERUPS_USED", "int")}
    scoped(connection, source, start, end, filters, LEVEL_EVENT, "level_results", columns)
    rows = connection.execute(
        """SELECT used > 0 AS with_powerups, count(*) AS results,
                  count(*) FILTER (WHERE state='Completed') AS completed
           FROM level_results WHERE state IN ('Completed', 'Failed') AND used IS NOT NULL
           GROUP BY 1"""
    ).fetchall()
    if not rows:
        return {
            "available": False,
            "note": "No level results carry POWERUPS_USED in this range, so completion can't be "
            "compared with and without power-ups.",
        }
    found = {bool(row["with_powerups"]): row for row in rows}

    def side(key):
        row = found.get(key)
        results = row["results"] if row else 0
        completed = row["completed"] if row else 0
        return {
            "level_results": results,
            "completed": completed,
            "completed_share": _ratio(completed, results),
        }

    return {
        "available": True,
        "with_powerups": side(True),
        "without_powerups": side(False),
        "means": (
            "Among level results (Completed or Failed) that report POWERUPS_USED: the share "
            "completed when power-ups were used in the attempt against when none were. This "
            "shows association, not cause: players reach for power-ups on harder levels."
        ),
    }


def economy(storage, game_id, start, end, filters, view=None, band=None):
    """Earning and spending per currency, or how power-ups are obtained and used."""
    view = _choice(view, ECONOMY_VIEWS, "currency", "view")
    try:
        band = DEFAULT_BAND if band is None else int(band)
    except (TypeError, ValueError):
        band = 0
    if not 1 <= band <= MAX_BAND:
        raise ValueError(f"band is a whole number of levels from 1 to {MAX_BAND}.")
    storage.get_game(game_id)
    with storage.connect(storage.game_path(game_id)) as connection:
        source = insights.read_source(storage, connection)
        if view == "currency":
            return _currencies(connection, source, start, end, filters, band)
        powerups = _powerups(connection, source, start, end, filters)
        completion = _with_and_without(connection, source, start, end, filters)
    if not powerups["available"] and not completion["available"]:
        return _absent("power-up events", "POWERUP_ANALYSIS or POWERUPS_USED on level results")
    return {
        "available": True,
        "view": "powerups",
        "means": (
            "Per power-up: how many were obtained (amount by SOURCE: Coins, Gift, RewardedAd) "
            "and used (amount by TRIGGER: Tutorial or Player), with the distinct players. An "
            "event with no AMOUNT counts as one."
        ),
        "powerups": powerups["powerups"],
        **({"powerups_note": powerups["note"]} if not powerups["available"] else {}),
        "completion_with_and_without_powerups": completion,
    }


# --- onboarding ----------------------------------------------------------------------------------


def _tutorials(connection, source, start, end, filters):
    columns = {
        "state": ("STATE", "text"),
        "tutorial": ("TUTORIAL", "text"),
        "seconds": ("SECONDS", "real"),
    }
    if not scoped(connection, source, start, end, filters, TUTORIAL_EVENT, "tutorials", columns):
        return _absent("tutorial events", "TUTORIAL_ANALYSIS")
    rows = connection.execute(
        """SELECT coalesce(tutorial, 'unknown') AS tutorial,
                  count(DISTINCT CASE WHEN state='Shown' THEN player END) AS shown,
                  count(DISTINCT CASE WHEN state='Completed' THEN player END) AS completed,
                  count(DISTINCT CASE WHEN state='Interrupted' THEN player END) AS interrupted
           FROM tutorials GROUP BY 1 ORDER BY shown DESC, tutorial"""
    ).fetchall()
    seconds = _by(
        connection.execute(
            "SELECT coalesce(tutorial, 'unknown'), seconds FROM tutorials "
            "WHERE state='Completed' AND seconds IS NOT NULL LIMIT ?",
            (MAX_ROWS,),
        )
    )
    return {
        "available": True,
        "means": (
            "Per tutorial: players it was shown to, players who completed it, players who were "
            "interrupted, and completion_rate = players completed / players shown. "
            "median_seconds_to_complete is the median SECONDS of its Completed events."
        ),
        "tutorials": [
            {
                "tutorial": row["tutorial"],
                "players_shown": row["shown"],
                "players_completed": row["completed"],
                "players_interrupted": row["interrupted"],
                "completion_rate": _ratio(row["completed"], row["shown"]),
                "median_seconds_to_complete": round(median(seconds[row["tutorial"]]), 1)
                if seconds.get(row["tutorial"])
                else None,
            }
            for row in rows
        ],
    }


def _first_session(connection, source, start, end, filters):
    condition, args = insights.where(start, end, filters, source=source)
    table, player, session, param = source.table, source.player, source.session, source.param
    connection.execute("DROP TABLE IF EXISTS temp.first_cohort")
    connection.execute(
        f"""CREATE TEMP TABLE first_cohort AS
            SELECT {player} AS pid, {session} AS sid, min(client_ts) AS t0
            FROM {table} WHERE name=? AND {condition} AND {player} IS NOT NULL
            GROUP BY pid LIMIT 200000""",
        [FIRST_OPEN, *args],
    )
    cohort = connection.execute("SELECT count(*) FROM first_cohort").fetchone()[0]
    if not cohort:
        return _absent("first opens", "first_open (sent by the SDK)")
    rows = connection.execute(
        f"""SELECT first_cohort.pid AS pid,
                   max(CAST({param("LEVEL_NUMBER")} AS INTEGER)) AS level,
                   (julianday(min(client_ts)) - julianday(first_cohort.t0)) * 86400.0 AS seconds
            FROM {table} JOIN first_cohort
                 ON {player} = first_cohort.pid AND {session} = first_cohort.sid
            WHERE name=? AND {param("STATE")}='Completed'
            GROUP BY first_cohort.pid""",
        [LEVEL_EVENT],
    ).fetchall()
    levels = [row["level"] for row in rows if row["level"] is not None]
    seconds = [round(row["seconds"], 1) for row in rows if row["seconds"] is not None]
    return {
        "available": True,
        "means": (
            "Players whose first open (first_open) was in the range, followed through that "
            "first session only (the session of the first open). reached_level_share is the "
            "share of the whole cohort whose highest Completed level in that session was at "
            "least that number."
        ),
        "cohort_players": cohort,
        "completed_a_level_share": _ratio(len(levels), cohort),
        "reached_level_share": {
            f"level_{number}": {
                "players": sum(1 for level in levels if level >= number),
                "share": _ratio(sum(1 for level in levels if level >= number), cohort),
            }
            for number in REACHED_LEVELS
        },
        "median_seconds_to_first_completed_level": round(median(seconds), 1) if seconds else None,
    }


def onboarding(storage, game_id, start, end, filters):
    """Tutorial completion, and how far new players get in their first session."""
    storage.get_game(game_id)
    with storage.connect(storage.game_path(game_id)) as connection:
        source = insights.read_source(storage, connection)
        tutorials = _tutorials(connection, source, start, end, filters)
        first = _first_session(connection, source, start, end, filters)
    if not tutorials["available"] and not first["available"]:
        return _absent("tutorial events or first opens", "TUTORIAL_ANALYSIS or first_open")
    return {"available": True, "tutorials": tutorials, "first_session": first}


# --- store ---------------------------------------------------------------------------------------


def _screens(connection, source, start, end, filters, limit, active):
    columns = {
        "state": ("STATE", "text"),
        "screen": ("SCREEN", "text"),
        "action": ("ACTION", "text"),
        "closed_by": ("CLOSED_BY", "text"),
        "seconds": ("SECONDS_OPEN", "real"),
    }
    if not scoped(connection, source, start, end, filters, SCREEN_EVENT, "screens", columns):
        return _absent("screen events", "SCREEN_ANALYSIS")
    rows = connection.execute(
        """SELECT coalesce(screen, 'unknown') AS screen,
                  count(*) FILTER (WHERE state='Opened') AS opens,
                  count(DISTINCT CASE WHEN state='Opened' THEN player END) AS players
           FROM screens GROUP BY 1 ORDER BY opens DESC, screen LIMIT ?""",
        (limit,),
    ).fetchall()
    seconds = _by(
        connection.execute(
            "SELECT coalesce(screen, 'unknown'), seconds FROM screens "
            "WHERE seconds IS NOT NULL LIMIT ?",
            (MAX_ROWS,),
        )
    )
    closed = _by(
        (row[0], (row[1], row[2]))
        for row in connection.execute(
            "SELECT coalesce(screen, 'unknown'), closed_by, count(*) FROM screens "
            "WHERE state='Closed' AND closed_by IS NOT NULL AND closed_by != '' GROUP BY 1, 2 "
            "ORDER BY 3 DESC, 2"
        )
    )
    actions = _by(
        (row[0], (row[1], row[2], row[3]))
        for row in connection.execute(
            "SELECT coalesce(screen, 'unknown'), action, count(*), count(DISTINCT player) "
            "FROM screens WHERE action IS NOT NULL AND action != '' GROUP BY 1, 2 "
            "ORDER BY 3 DESC, 2"
        )
    )
    result = []
    for row in rows:
        name = row["screen"]
        ends = sum(count for _, count in closed.get(name, []))
        result.append(
            {
                "screen": name,
                "opens": row["opens"],
                "players": row["players"],
                "share_of_active_players": _ratio(row["players"], active),
                "median_seconds_open": round(median(seconds[name]), 1)
                if seconds.get(name)
                else None,
                "closed_by": {
                    how: {"closes": count, "share": _ratio(count, ends)}
                    for how, count in closed.get(name, [])
                },
                "top_actions": [
                    {"action": action, "events": count, "players": players}
                    for action, count, players in actions.get(name, [])[:5]
                ],
            }
        )
    return {"available": True, "screens": result}


def _purchases(connection, source, start, end, filters, limit):
    columns = {
        "state": ("STATE", "text"),
        "product": ("PRODUCT", "text"),
        "price": ("PRICE", "real"),
        "currency": ("PRICE_CURRENCY", "text"),
        "reason": ("REASON", "text"),
    }
    if not scoped(connection, source, start, end, filters, IAP_EVENT, "iap", columns):
        return _absent("purchase events", "IAP_ANALYSIS")
    rows = connection.execute(
        """SELECT coalesce(product, 'unknown') AS product,
                  count(*) FILTER (WHERE state='Clicked') AS clicks,
                  count(*) FILTER (WHERE state='Purchased') AS purchases,
                  count(*) FILTER (WHERE state='Failed') AS failures,
                  count(*) FILTER (WHERE state='SubActivated') AS subscriptions,
                  count(DISTINCT CASE WHEN state='Clicked' THEN player END) AS clicking,
                  count(DISTINCT CASE WHEN state='Purchased' THEN player END) AS buyers
           FROM iap GROUP BY 1
           ORDER BY clicks + purchases + failures + subscriptions DESC, product LIMIT ?""",
        (limit,),
    ).fetchall()
    money = defaultdict(dict)
    totals = defaultdict(float)
    for product, currency, amount in connection.execute(
        "SELECT coalesce(product, 'unknown'), coalesce(currency, 'unspecified'), "
        "coalesce(sum(price), 0) FROM iap WHERE state='Purchased' GROUP BY 1, 2"
    ):
        money[product][currency] = _money(amount)
        totals[currency] += amount
    reasons = _by(
        (row[0], (row[1], row[2]))
        for row in connection.execute(
            "SELECT coalesce(product, 'unknown'), coalesce(reason, 'unspecified'), count(*) "
            "FROM iap WHERE state='Failed' GROUP BY 1, 2 ORDER BY 3 DESC, 2"
        )
    )
    counts = connection.execute(
        "SELECT count(*) FILTER (WHERE state='Clicked'), count(*) FILTER (WHERE state='Purchased')"
        " FROM iap"
    ).fetchone()
    result = {
        "available": True,
        "products": [
            {
                "product": row["product"],
                "clicks": row["clicks"],
                "players_clicking": row["clicking"],
                "purchases": row["purchases"],
                "players_purchasing": row["buyers"],
                "purchases_per_click": _ratio(row["purchases"], row["clicks"]),
                "failures": row["failures"],
                "top_failure_reasons": {
                    reason: count for reason, count in reasons.get(row["product"], [])[:3]
                },
                "subscriptions_activated": row["subscriptions"],
                "revenue_by_currency": money.get(row["product"], {}),
            }
            for row in rows
        ],
        "revenue_by_currency": {key: _money(value) for key, value in sorted(totals.items())},
    }
    if counts[0] and not counts[1]:
        result["note"] = (
            "There are store clicks but no Purchased events in this range: the game may only "
            "send clicks so far, so purchases and revenue are not measured."
        )
    return result


def store(storage, game_id, start, end, filters, limit=15):
    """How players use the store screens and what they buy, per screen and per product."""
    limit = _limit(limit)
    storage.get_game(game_id)
    with storage.connect(storage.game_path(game_id)) as connection:
        source = insights.read_source(storage, connection)
        condition, args = insights.where(start, end, filters, source=source)
        active = connection.execute(
            f"SELECT count(DISTINCT {source.player}) FROM {source.table} WHERE {condition}", args
        ).fetchone()[0]
        screens = _screens(connection, source, start, end, filters, limit, active)
        purchases = _purchases(connection, source, start, end, filters, limit)
    if not screens["available"] and not purchases["available"]:
        return _absent("screen or purchase events", "SCREEN_ANALYSIS or IAP_ANALYSIS")
    return {
        "available": True,
        "means": (
            "screens: opens, distinct players who opened it and their share of all active "
            "players (anyone with an event in the range), the median SECONDS_OPEN, how closes "
            "split by CLOSED_BY (for example Dismissed or Purchased) and the most common "
            "ACTION values. purchases: per product the clicks, purchases, failures (with the "
            "usual REASON) and activated subscriptions; revenue is the sum of PRICE of "
            "Purchased events per PRICE_CURRENCY and is never converted between currencies."
        ),
        "active_players": active,
        "screens": screens,
        "purchases": purchases,
    }
