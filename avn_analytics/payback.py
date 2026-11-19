"""Payback forecast: when a campaign's installs earn back what they cost.

Pure functions, no storage. The input is the revenue per install seen so far (cumulative, at
the day-N marks the Acquisition report already computes) and the cost per install. Cumulative
revenue is fitted as `R(d) = a * (d + 1) ** b` by least squares in log space, which fits the
usual shape of ad revenue per install: fast at first, then flattening. The fit is only used up
to HORIZON_DAYS, and only with enough points and players behind it; otherwise the answer says
there is not enough data yet instead of guessing.
"""

import math

HORIZON_DAYS = 180
MARKS = (30, 60, 90, 180)
MIN_POINTS = 3
MIN_PLAYERS = 30  # on the latest observed point
MAX_EXPONENT = 1.0  # revenue never accelerates; guards against a noisy early fit


def _fit(points):
    """Fit R(d) = a * (d + 1) ** b to (day, value) points with value > 0; None if impossible."""
    usable = [(math.log(day + 1), math.log(value)) for day, value in points if value > 0]
    if len(usable) < 2 or len({x for x, _ in usable}) < 2:
        return None
    mean_x = sum(x for x, _ in usable) / len(usable)
    mean_y = sum(y for _, y in usable) / len(usable)
    spread = sum((x - mean_x) ** 2 for x, _ in usable)
    slope = sum((x - mean_x) * (y - mean_y) for x, y in usable) / spread
    slope = min(slope, MAX_EXPONENT)
    # re-centre the intercept for the clamped slope
    return math.exp(mean_y - slope * mean_x), slope


def _at(curve, day):
    amount, exponent = curve
    return amount * (day + 1) ** exponent


def _break_even(curve, cost):
    """First day (0..HORIZON_DAYS) the curve reaches `cost`, or None."""
    if _at(curve, HORIZON_DAYS) < cost:
        return None
    low, high = 0, HORIZON_DAYS
    while low < high:  # the curve only rises, so bisect
        middle = (low + high) // 2
        if _at(curve, middle) >= cost:
            high = middle
        else:
            low = middle + 1
    return low


def forecast(observed, cost_per_install):
    """Payback forecast from `observed`: {day: {"players": n, "per_player": value or None}}.

    Returns a dict with `state` (`ok`, `thin` or `none`), predicted value per install at the
    MARKS, `break_even_day` (None when it will not pay back inside HORIZON_DAYS), and a
    plain-words `summary`. `thin` still carries numbers but says they rest on little data.
    """
    points = sorted(
        (int(key.removeprefix("day_")), item["players"], item["per_player"])
        for key, item in observed.items()
        if item.get("per_player") is not None and item.get("players")
    )
    if not cost_per_install:
        return _none("No cost per install yet, so there is nothing to pay back.")
    if len(points) < MIN_POINTS or points[-1][2] <= 0:
        return _none("Too little revenue history to forecast yet.")
    curve = _fit([(day, value) for day, _, value in points])
    if curve is None:
        return _none("Too little revenue history to forecast yet.")
    players = points[-1][1]
    state = "ok" if players >= MIN_PLAYERS else "thin"
    latest_day = points[-1][0]
    predicted = {f"day_{mark}": round(_at(curve, mark), 4) for mark in MARKS}
    day = _break_even(curve, cost_per_install)
    if day is None:
        summary = f"Not expected to pay back within {HORIZON_DAYS} days."
    elif day <= latest_day:
        summary = f"Already paid back around day {day}."
    else:
        summary = f"Expected to pay back around day {day}."
    if state == "thin":
        summary += f" Based on only {players} players, so treat it as rough."
    return {
        "state": state,
        "break_even_day": day,
        "predicted": predicted,
        "based_on_day": latest_day,
        "players": players,
        "summary": summary,
    }


def _none(summary):
    return {
        "state": "none",
        "break_even_day": None,
        "predicted": {},
        "based_on_day": None,
        "players": 0,
        "summary": summary,
    }
