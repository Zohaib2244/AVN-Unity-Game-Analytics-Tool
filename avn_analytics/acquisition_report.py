"""The Acquisition page: install sources with their value, cost and return, and install-day cohorts.

Built on `acquisition._load` (players whose first open is in the range, with their install source
and ad revenue per day) and `costs` (what each campaign spent per day, with the attribution
service's own install counts).

Two counts of installs exist and they differ. The attribution service counts every install; this
app only sees players on a build that sends AVN events, and counts as an "install" the first open
of such a build, which includes existing players updating into it. So:

- cost per install = cost / the attribution service's installs;
- return by day N = ad revenue per player we see, by day N / cost per install;
- players who updated rather than installed (their ad click is older than the game's first AVN
  data, or more than CLICK_WINDOW_DAYS before their first open) are left out of the value numbers;
- `seen_share` = the players we see / the service's installs on a build that can send AVN events,
  so a reader knows how much the value per player rests on. The service splits installs by app
  version; with the game's first AVN build typed in, installs on older builds (which can never
  appear here) are not counted against us. Without it, or for a day with no version rows, the
  share is against every install and `seen_share_all` is the same figure. Cost per install always
  divides by every install: the money bought them all.

Days count from the first-open day in UTC; the cost service's days may be in another time zone,
so single days can disagree while weeks add up. Its newest days are marked not final
(`COST_LAG_DAYS`), since installs there arrive later than cost.
"""

from collections import defaultdict
from datetime import date, timedelta

from . import acquisition, costs
from .acquisition import _day_after, _over, _ratio

GROUPS = ("campaign", "media_source", "channel")
VALUE_DAYS = (0, 1, 3, 7, 14, 30)
RETENTION_DAYS = (1, 3, 7)
CLICK_WINDOW_DAYS = 7  # the longest a real install comes after its ad click
COST_LAG_DAYS = 4  # the cost service's newest days whose installs may still grow
ORGANIC = "Organic"
NO_RECORD = "No install record"
ALL_PAID = "All paid"


def _label(player, group_by):
    """What a player's install source reads as, for one grouping."""
    if not player["attributed"]:
        return NO_RECORD
    if str(player["media_source"]).lower() == "organic":
        return ORGANIC
    value = player[group_by]
    return value if value not in (None, "", acquisition.UNATTRIBUTED) else "(not named)"


def _updated(player, first_day):
    """Whether this "install" is an existing player updating into a build that sends AVN events."""
    click = str(player.get("click") or "")[:10]
    if len(click) != 10:
        return False
    oldest = max(first_day, _day_after(player["cday"], -CLICK_WINDOW_DAYS))
    return click < oldest


def _value(players, last_day, day):
    """Ad revenue per player from the first-open day to day N, over players whose day N is over."""
    eligible = [item for item in players if _over(item, day, last_day)]
    if not eligible:
        return {"players": 0, "per_player": None}
    earned = sum(
        money
        for item in eligible
        for when, money in item["days"].items()
        if when <= _day_after(item["cday"], day)
    )
    return {"players": len(eligible), "per_player": round(earned / len(eligible), 4)}


def _retention(players, last_day):
    result = {}
    for day in RETENTION_DAYS:
        eligible = [item for item in players if _over(item, day, last_day)]
        back = sum(1 for item in eligible if _day_after(item["cday"], day) in item["days"])
        result[f"day_{day}"] = {"players": len(eligible), "rate": _ratio(back, len(eligible))}
    return result


def _cost_key(row, group_by):
    if group_by == "media_source":
        return row["network"]
    if group_by == "campaign":
        return row["campaign"]
    return None  # the cost service doesn't split by channel


def _sdk_total(rows):
    """The installs of cost rows that were on a build sending AVN events; None unless every row
    says (a day the endpoint sent no versions for would otherwise read as no installs)."""
    counts = [row.get("sdk_installs") for row in rows]
    return None if not counts or any(count is None for count in counts) else sum(counts)


def _with_cost(row, spend, bought, value, sdk=None):
    """Add cost, cost per install, the share of installs we see and the return by day."""
    row["cost"] = round(spend, 2) if spend is not None else None
    row["service_installs"] = bought
    row["sdk_installs"] = sdk
    cpi = spend / bought if spend and bought else None
    row["cost_per_install"] = round(cpi, 4) if cpi else None
    row["seen_share_all"] = _ratio(row["installs"], bought) if bought else None
    row["seen_share"] = _ratio(row["installs"], sdk) if sdk else row["seen_share_all"]
    row["return"] = {
        key: (
            round(item["per_player"] / cpi, 4) if cpi and item["per_player"] is not None else None
        )
        for key, item in value.items()
    }
    return row


def _cost_state(storage, game, start_day, end_day):
    state = costs.ensure(storage, game, start_day, end_day)
    rows = (
        costs.rows(storage, game, start_day, end_day) if state["state"] in ("ok", "failed") else []
    )
    newest = max((row["day"] for row in rows), default=None)
    state["not_final_from"] = _day_after(newest, -(COST_LAG_DAYS - 1)) if newest else None
    return state, rows


def report(storage, game_id, start, end, filters, start_day, end_day, group_by=None, limit=25):
    """Install sources with installs, retention, value per install by day, cost and return."""
    group_by = group_by or "campaign"
    if group_by not in GROUPS:
        raise ValueError(f"group_by is one of: {', '.join(GROUPS)}.")
    game = storage.get_game(game_id)
    data = acquisition._load(storage, game_id, start, end, filters)
    if "players" not in data:
        return data
    last_day, first_day = data["last_day"], data["first_day"]
    players = [item for item in data["players"] if not _updated(item, first_day)]
    updated = len(data["players"]) - len(players)
    state, cost_rows = _cost_state(storage, game, start_day, end_day)
    spend, bought, parts = defaultdict(float), defaultdict(int), defaultdict(list)
    for row in cost_rows:
        key = _cost_key(row, group_by)
        if key is not None:
            spend[key] += row["cost"]
            bought[key] += row["installs"]
            parts[key].append(row)
    grouped = defaultdict(list)
    for item in players:
        grouped[_label(item, group_by)].append(item)
    for key in spend:  # a campaign the service counted but no player of ours came from
        grouped.setdefault(key, [])
    rows = []
    for name, members in grouped.items():
        value = {f"day_{day}": _value(members, last_day, day) for day in VALUE_DAYS}
        row = {
            "value": name,
            "installs": len(members),
            "retention": _retention(members, last_day),
            "value_per_install": value,
            "paid": name not in (ORGANIC, NO_RECORD),
        }
        has_cost = state["state"] in ("ok", "failed") and group_by != "channel" and row["paid"]
        rows.append(
            _with_cost(
                row,
                spend.get(name, 0.0),
                bought.get(name, 0),
                value,
                _sdk_total(parts.get(name, [])),
            )
            if has_cost
            else _with_cost(row, None, None, value)
        )
    rows.sort(key=lambda row: (-row["installs"], str(row["value"])))
    paid = [item for item in players if _label(item, group_by) not in (ORGANIC, NO_RECORD)]
    paid_value = {f"day_{day}": _value(paid, last_day, day) for day in VALUE_DAYS}
    total_paid = {"value": ALL_PAID, "installs": len(paid), "retention": _retention(paid, last_day)}
    total_paid["value_per_install"] = paid_value
    has_cost = state["state"] in ("ok", "failed")
    _with_cost(
        total_paid,
        sum(row["cost"] for row in cost_rows) if has_cost else None,
        sum(row["installs"] for row in cost_rows) if has_cost else None,
        paid_value,
        _sdk_total(cost_rows) if has_cost else None,
    )
    settings = costs.settings(storage, game)
    return {
        "available": True,
        "currency": "USD",
        "group_by": group_by,
        "installs": len(players),
        "updated_players_left_out": updated,
        "last_day": last_day,
        "cost": state,
        "goals": settings["goals"],
        "first_sdk_version": settings["first_sdk_version"],
        "all_paid": total_paid,
        "rows": rows[: max(1, min(int(limit), 60))],
    }


def cohorts(storage, game_id, start, end, filters, start_day, end_day, campaign=None):
    """Install-day cohorts of one campaign (or every paid one): cost, installs both ways, cost per
    install and the return by day since install; plus revenue and cost by calendar day."""
    game = storage.get_game(game_id)
    data = acquisition._load(storage, game_id, start, end, filters)
    if "players" not in data:
        return data
    last_day, first_day = data["last_day"], data["first_day"]
    campaign = campaign or ALL_PAID
    players = [
        item
        for item in data["players"]
        if not _updated(item, first_day)
        and (
            _label(item, "campaign") == campaign
            if campaign != ALL_PAID
            else _label(item, "campaign") not in (ORGANIC, NO_RECORD)
        )
    ]
    state, cost_rows = _cost_state(storage, game, start_day, end_day)
    if campaign != ALL_PAID:
        cost_rows = [row for row in cost_rows if row["campaign"] == campaign]
    spend, bought, parts = defaultdict(float), defaultdict(int), defaultdict(list)
    for row in cost_rows:
        spend[row["day"]] += row["cost"]
        bought[row["day"]] += row["installs"]
        parts[row["day"]].append(row)
    by_day = defaultdict(list)
    for item in players:
        by_day[item["cday"]].append(item)
    days = []
    cursor, stop = date.fromisoformat(str(start_day)), date.fromisoformat(str(end_day))
    while cursor <= stop:
        day = cursor.isoformat()
        members = by_day.get(day, [])
        value = {f"day_{n}": _value(members, last_day, n) for n in VALUE_DAYS}
        row = {
            "day": day,
            "installs": len(members),
            "retention": _retention(members, last_day),
            "value_per_install": value,
        }
        has_cost = state["state"] in ("ok", "failed")
        _with_cost(
            row,
            spend.get(day, 0.0) if has_cost else None,
            bought.get(day, 0) if has_cost else None,
            value,
            _sdk_total(parts.get(day, [])) if has_cost else None,
        )
        row["final"] = not (state.get("not_final_from") and day >= state["not_final_from"])
        if members or spend.get(day) or bought.get(day):
            days.append(row)
        cursor += timedelta(days=1)
    earned = defaultdict(float)
    for item in players:
        for when, money in item["days"].items():
            earned[when] += money
    calendar = [
        {
            "day": day,
            "revenue": round(earned.get(day, 0.0), 4),
            "cost": round(spend[day], 2) if day in spend else None,
        }
        for day in sorted(set(earned) | set(spend))
        if str(start_day) <= day <= max(str(end_day), last_day or "")
    ]
    settings = costs.settings(storage, game)
    return {
        "available": True,
        "currency": "USD",
        "campaign": campaign,
        "campaigns": sorted(
            {_label(item, "campaign") for item in data["players"]} - {ORGANIC, NO_RECORD}
            | {row["campaign"] for row in costs.rows(storage, game, start_day, end_day)}
        ),
        "last_day": last_day,
        "cost": state,
        "goals": costs.goals_for(settings["goals"], campaign),
        "first_sdk_version": settings["first_sdk_version"],
        "game_goals": settings["goals"]["game"],
        "has_own_goals": campaign in settings["goals"]["campaigns"],
        "days": days,
        "by_calendar_day": calendar,
    }
