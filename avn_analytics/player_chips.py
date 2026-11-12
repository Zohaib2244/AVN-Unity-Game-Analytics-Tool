"""Player groups as chips: plain conditions such as "came from D7 WW or HIT33", "earned at least
$0.50" or "highest level 20 to 40", all of which must hold.

Each chip becomes a segment condition (segments.py): "players who, over everything they ever sent,
match this". So a group keeps the same players whatever days a page shows, and every read that goes
through insights.where honours it. Two kinds of condition come out of here:

- event conditions ({"event", "param", "values", "missing"}), like install-source segments;
- aggregate conditions ({"aggregate": ...}): a per-player sum, count or extreme over some events,
  between a minimum and a maximum (see segments.clause);
- player lists ({"players": [...]}) for what SQL alone can't say: whether a player has paid back
  what they cost, which needs the cost service's numbers (costs.py).

The chip shapes are checked here; anything unexpected is a ValueError with a sentence for people.
"""

import math
from datetime import UTC, date, datetime, timedelta

ATTRIBUTION = "ATTRIBUTION_ANALYSIS"
AD = "AD_ANALYSIS"
LEVEL = "LEVEL_ANALYSIS"
MAX_CHIPS = 8
MAX_VALUES = 50
NAME_LIMIT = 128

KINDS = (
    "campaign",
    "media_source",
    "install_type",
    "installed",
    "ad_format",
    "ad_network",
    "ad_creative",
    "ad_failed",
    "earned",
    "paid_back",
    "cost",
    "highest_level",
    "stopped_on",
    "days_active",
    "sessions",
    "last_seen",
    "event",
)


def _values(chip):
    values = chip.get("values")
    if not isinstance(values, list) or not values or len(values) > MAX_VALUES:
        raise ValueError(f"Pick 1 to {MAX_VALUES} values.")
    return [str(value)[:NAME_LIMIT] for value in values]


def _number(chip, key):
    value = chip.get(key)
    if value is None or value == "":
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"{key} must be a number.") from None
    if not math.isfinite(number) or number < 0 or number > 1e9:
        raise ValueError(f"{key} is out of range.")
    return number


def _range(chip):
    low, high = _number(chip, "min"), _number(chip, "max")
    if low is None and high is None:
        raise ValueError("Give a lowest or a highest value.")
    if low is not None and high is not None and high < low:
        raise ValueError("The highest value is below the lowest.")
    return low, high


def _aggregate(measure, low, high, **extra):
    return {"aggregate": measure, "min": low, "max": high, **extra}


def _day(value):
    try:
        return date.fromisoformat(str(value)).isoformat()
    except ValueError:
        raise ValueError("Days are written YYYY-MM-DD.") from None


def conditions(chips, now=None):
    """The segment conditions for a list of chips, all of which must hold. Cost chips are
    returned as {"cost": ...} placeholders for `resolve_costs` to turn into player lists."""
    if not chips:
        return []
    if not isinstance(chips, list) or len(chips) > MAX_CHIPS:
        raise ValueError(f"Use at most {MAX_CHIPS} conditions in a group.")
    now = now or datetime.now(UTC)
    found = []
    for chip in chips:
        if not isinstance(chip, dict) or chip.get("kind") not in KINDS:
            raise ValueError("Unknown kind of condition.")
        kind = chip["kind"]
        if kind == "campaign":
            found.append({"event": ATTRIBUTION, "param": "CAMPAIGN", "values": _values(chip)})
        elif kind == "media_source":
            found.append({"event": ATTRIBUTION, "param": "MEDIA_SOURCE", "values": _values(chip)})
        elif kind == "install_type":
            value = chip.get("value")
            if value == "paid":
                found.append(
                    {"event": ATTRIBUTION, "param": "AF_STATUS", "values": ["Non-organic"]}
                )
            elif value == "organic":
                found.append({"event": ATTRIBUTION, "param": "AF_STATUS", "values": ["Organic"]})
            elif value == "none":
                found.append(
                    {"event": ATTRIBUTION, "param": "STATE", "values": ["Install"], "missing": True}
                )
            else:
                raise ValueError("Install type is paid, organic or none.")
        elif kind == "installed":
            first = _day(chip.get("from")) if chip.get("from") else None
            last = _day(chip.get("to")) if chip.get("to") else None
            if not first and not last:
                raise ValueError("Give the first or last install day.")
            found.append(
                _aggregate(
                    "first_seen",
                    first,
                    (date.fromisoformat(last) + timedelta(days=1)).isoformat() if last else None,
                    events=["first_open"],
                )
            )
        elif kind == "ad_format":
            found.append(
                _aggregate(
                    "count",
                    1,
                    None,
                    events=[AD],
                    tests=[["STATE", ["Show"]], ["FORMAT", _values(chip)]],
                )
            )
        elif kind == "ad_network":
            found.append(
                _aggregate(
                    "count",
                    1,
                    None,
                    events=[AD],
                    tests=[["STATE", ["Revenue"]], ["NETWORK", _values(chip)]],
                )
            )
        elif kind == "ad_creative":
            found.append(
                _aggregate(
                    "count",
                    1,
                    None,
                    events=[AD],
                    tests=[["STATE", ["Revenue"]], ["CREATIVE_ID", _values(chip)]],
                )
            )
        elif kind == "ad_failed":
            tests = [["STATE", ["Failed", "LoadFailed"]]]
            if chip.get("values"):
                tests.append(["FORMAT", _values(chip)])
            low = _number(chip, "min") or 1
            found.append(_aggregate("count", low, None, events=[AD], tests=tests))
        elif kind == "earned":
            low, high = _range(chip)
            found.append(
                _aggregate(
                    "sum",
                    low,
                    high,
                    events=[AD, LEVEL],
                    params=["REVENUE", "BANNER_REVENUE"],
                    tests=[],
                    zero_when_missing=True,
                )
            )
        elif kind in ("paid_back", "cost"):
            found.append({"cost": kind, "min": _range(chip)[0], "max": _range(chip)[1]})
        elif kind == "highest_level":
            low, high = _range(chip)
            found.append(
                _aggregate(
                    "max",
                    low,
                    high,
                    events=[LEVEL],
                    params=["LEVEL_NUMBER"],
                    tests=[["STATE", ["Started"]]],
                )
            )
        elif kind == "stopped_on":
            level = _number(chip, "level")
            if level is None:
                raise ValueError("Give the level they stopped on.")
            found.append(
                _aggregate(
                    "max",
                    level,
                    level,
                    events=[LEVEL],
                    params=["LEVEL_NUMBER"],
                    tests=[["STATE", ["Started"]]],
                )
            )
        elif kind == "days_active":
            low, high = _range(chip)
            found.append(_aggregate("days", low, high))
        elif kind == "sessions":
            low, high = _range(chip)
            found.append(_aggregate("sessions", low, high))
        elif kind == "last_seen":
            within, beyond = _number(chip, "within_days"), _number(chip, "more_than_days")
            if within is None and beyond is None:
                raise ValueError("Say how many days ago.")
            stamp = lambda days: (now - timedelta(days=days)).isoformat()  # noqa: E731
            found.append(
                _aggregate(
                    "last_seen",
                    stamp(within) if within is not None else None,
                    stamp(beyond) if beyond is not None else None,
                )
            )
        elif kind == "event":
            event = str(chip.get("event") or "")[:NAME_LIMIT]
            if not event:
                raise ValueError("Choose an event.")
            tests = []
            rule = None
            if chip.get("param") and ("op" in chip or "rule_value" in chip):
                from .models import FunnelStep
                from .rules import condition_sql

                rule = FunnelStep.model_validate(
                    {
                        "event": event,
                        "param": chip["param"],
                        "op": chip.get("op", "eq"),
                        "value": str(chip.get("rule_value", "")),
                    }
                ).model_dump()
                condition_sql(rule)  # Reject invalid numeric comparisons before saving.
            elif chip.get("param"):
                tests.append([str(chip["param"])[:80], _values(chip)])
            if chip.get("never"):
                found.append(
                    {
                        "aggregate": "count",
                        "min": 1,
                        "max": None,
                        "events": [event],
                        "tests": tests,
                        "missing": True,
                        "rule": rule,
                    }
                )
            else:
                found.append(
                    _aggregate(
                        "count",
                        _number(chip, "min") or 1,
                        None,
                        events=[event],
                        tests=tests,
                        rule=rule,
                    )
                )
    return found


def resolve_costs(storage, game_id, found):
    """Turn {"cost": ...} placeholders into lists of the players who meet them: their campaign's
    cost per install on their install day (cost) or their ad revenue over it (paid_back, in %)."""
    pending = [item for item in found if "cost" in item]
    if not pending:
        return found
    value = storage.scans.get(
        storage, game_id, ("player-cost-values",), lambda: _cost_values(storage, game_id)
    )
    resolved = []
    for item in found:
        if "cost" not in item:
            resolved.append(item)
            continue
        low, high = item["min"], item["max"]
        keep = [
            pid
            for pid, numbers in value.items()
            if (low is None or numbers[item["cost"]] >= low)
            and (high is None or numbers[item["cost"]] <= high)
        ]
        resolved.append({"players": keep})
    return resolved


def _cost_values(storage, game_id):
    from . import acquisition, acquisition_report, costs

    game = storage.get_game(game_id)
    data = acquisition._load(storage, game_id, "0001-01-01T00:00:00Z", "9999-12-31T00:00:00Z", {})
    players = data.get("players") or []
    days = sorted({item["cday"] for item in players})
    rows = []
    if days:
        state = costs.ensure(storage, game, days[0], days[-1])
        if state["state"] in ("ok", "failed"):
            rows = costs.rows(storage, game, days[0], days[-1])
    spend, bought = {}, {}
    for row in rows:
        key = (row["campaign"], row["day"])
        spend[key] = spend.get(key, 0.0) + row["cost"]
        bought[key] = bought.get(key, 0) + row["installs"]
    value = {}
    for item in players:
        if acquisition_report._updated(item, data["first_day"]):
            continue
        key = (item["campaign"], item["cday"])
        if not bought.get(key) or not spend.get(key):
            continue
        cpi = spend[key] / bought[key]
        earned = sum(item["days"].values())
        value[item["pid"]] = {"cost": cpi, "paid_back": 100 * earned / cpi}
    return value


def resolved(storage, game_id, chips):
    """Validate once, resolving money conditions through the shared short-lived read cache."""
    found = conditions(chips)
    return resolve_costs(storage, game_id, found)


def apply_filters(storage, game_id, filters):
    """The POST equivalent of the dashboard's player_group query argument."""
    filters = dict(filters)
    chips = filters.pop("player_group", [])
    if chips:
        filters["segments"] = [*filters.get("segments", []), *resolved(storage, game_id, chips)]
    return filters


def members(storage, game_id, chips):
    """Membership is lifetime-wide and independent of the days displayed on a page."""
    from .insights import read_source, where

    def compute():
        found = resolved(storage, game_id, chips)
        with storage.connect(storage.game_path(game_id)) as connection:
            source = read_source(storage, connection)
            sql, args = where("0001-01-01", "9999-12-31", {"segments": found}, source=source)
            return frozenset(
                row[0]
                for row in connection.execute(
                    f"SELECT DISTINCT {source.player} FROM {source.table} "
                    f"WHERE {sql} AND {source.identified}",
                    args,
                )
            )

    return storage.scans.get(storage, game_id, ("chip-members", chips), compute)


def counts(storage, game_id, start, end, filters, items):
    """Saved-group counts within the current days/build/filters; scan that population once."""
    from .insights import read_source, where

    with storage.connect(storage.game_path(game_id)) as connection:
        source = read_source(storage, connection)
        sql, args = where(start, end, filters, source=source)
        population = {
            row[0]
            for row in connection.execute(
                f"SELECT DISTINCT {source.player} FROM {source.table} "
                f"WHERE {sql} AND {source.identified}",
                args,
            )
        }
    return {
        "all": len(population),
        "counts": {
            item["id"]: len(population & members(storage, game_id, item["definition"]["chips"]))
            for item in items
        },
    }


TOP_CREATIVES = 60


def options(storage, game_id):
    """What the chips can pick from, with how many players each value has: campaigns and media
    sources (attribution), ad formats shown, paying networks and the most shown creatives."""
    from .insights import read_source

    storage.get_game(game_id)
    with storage.connect(storage.game_path(game_id)) as connection:
        source = read_source(storage, connection)
        table, player, param = source.table, source.player, source.param

        def values(event, key, tests=(), limit=50):
            filters = " ".join(f"AND {param(name)} = ?" for name, _ in tests)
            return [
                {"value": row["value"], "players": row["players"]}
                for row in connection.execute(
                    f"""SELECT CAST({param(key)} AS TEXT) AS value,
                               count(DISTINCT {player}) AS players
                        FROM {table} WHERE name=? {filters} AND {param(key)} IS NOT NULL
                        GROUP BY value ORDER BY players DESC LIMIT ?""",
                    (event, *[value for _, value in tests], limit),
                )
            ]

        return {
            "campaign": values(ATTRIBUTION, "CAMPAIGN", (("STATE", "Install"),)),
            "media_source": values(ATTRIBUTION, "MEDIA_SOURCE", (("STATE", "Install"),)),
            "ad_format": values(AD, "FORMAT", (("STATE", "Show"),)),
            "ad_network": values(AD, "NETWORK", (("STATE", "Revenue"),)),
            "ad_creative": values(AD, "CREATIVE_ID", (("STATE", "Revenue"),), TOP_CREATIVES),
        }


def player_values(storage, game_id, players):
    """For the rows on screen: each player's campaign, install day, ad revenue so far and, when
    the cost service knows their campaign's day, their cost and the share of it paid back."""
    if not players:
        return {}
    from . import costs
    from .insights import read_source

    game = storage.get_game(game_id)
    marks = ",".join("?" * len(players))
    with storage.connect(storage.game_path(game_id)) as connection:
        source = read_source(storage, connection)
        table, player, param = source.table, source.player, source.param
        rows = connection.execute(
            f"""SELECT {player} AS pid,
                       max(CASE WHEN name=? AND {param("STATE")}='Install'
                                THEN coalesce({param("CAMPAIGN")}, {param("MEDIA_SOURCE")}) END)
                           AS campaign,
                       min(CASE WHEN name='first_open' THEN substr(client_ts, 1, 10) END) AS cday,
                       sum(CASE WHEN name=? AND {param("STATE")}='Revenue'
                                THEN coalesce(CAST({param("REVENUE")} AS REAL), 0)
                                WHEN name=?
                                THEN coalesce(CAST({param("BANNER_REVENUE")} AS REAL), 0)
                                ELSE 0 END) AS earned
                FROM {table} WHERE {player} IN ({marks}) GROUP BY pid""",
            (ATTRIBUTION, AD, LEVEL, *players),
        ).fetchall()
    found = {row["pid"]: dict(row) for row in rows}
    days = sorted({item["cday"] for item in found.values() if item["cday"]})
    spend, bought = {}, {}
    if days and storage.settings.cost_api_url:
        costs.ensure(storage, game, days[0], days[-1])
        for row in costs.rows(storage, game, days[0], days[-1]):
            key = (row["campaign"], row["day"])
            spend[key] = spend.get(key, 0.0) + row["cost"]
            bought[key] = bought.get(key, 0) + row["installs"]
    result = {}
    for pid, item in found.items():
        key = (item["campaign"], item["cday"])
        cpi = spend[key] / bought[key] if bought.get(key) and spend.get(key) else None
        earned = round(item["earned"] or 0.0, 4)
        result[pid] = {
            "campaign": item["campaign"],
            "install_day": item["cday"],
            "earned": earned,
            "cost": round(cpi, 4) if cpi else None,
            "paid_back": round(earned / cpi, 4) if cpi else None,
        }
    return result
