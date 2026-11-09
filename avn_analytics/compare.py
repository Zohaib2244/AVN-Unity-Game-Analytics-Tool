"""Two app versions side by side: did the new build make things better or worse.

Each number is read with the same range and filters, narrowed to one version. Players who
play on both versions count in both. A number is None when its events are not sent or the version
has too little to say.
"""

from fastapi import HTTPException

from . import ads, counting, insights, stability

LEVEL = "LEVEL_ANALYSIS"


def _path(data, *keys):
    for key in keys:
        if not isinstance(data, dict) or data.get(key) is None:
            return None
        data = data[key]
    return data


def _count(storage, game_id, start, end, filters, state, metric="count", param=None):
    data = counting.count_events(
        storage,
        game_id,
        start,
        end,
        filters,
        LEVEL,
        where=[{"param": "STATE", "op": "eq", "value": state}],
        metric=metric,
        param=param,
    )
    return _path(data, "total", "value")


def _one(storage, game_id, start, end, filters, version):
    narrowed = {**filters, "app_versions": [version]}
    overview = insights.summary(storage, game_id, start, end, narrowed)
    retention = insights.retention(storage, game_id, start, end, narrowed)["aggregate"]
    money = ads.revenue(storage, game_id, start, end, narrowed)
    loading = ads.health(storage, game_id, start, end, narrowed)
    exits = stability.stability(storage, game_id, start, end, narrowed)
    completed = _count(storage, game_id, start, end, narrowed, "Completed") or 0
    failed = _count(storage, game_id, start, end, narrowed, "Failed") or 0
    available = lambda data: data if data.get("available") else {}  # noqa: E731
    return {
        "players": overview["players"],
        "sessions": overview["sessions"],
        "new_players": overview["new_players"],
        "events_per_player": round(overview["events"] / overview["players"], 1)
        if overview["players"]
        else None,
        "level_completion_rate": round(completed / (completed + failed), 4)
        if completed + failed
        else None,
        "median_seconds_to_complete_a_level": _count(
            storage, game_id, start, end, narrowed, "Completed", "median", "SECONDS"
        ),
        "ad_revenue_per_active_player": _path(available(money), "revenue_per_active_player"),
        "arpdau": _path(available(money), "arpdau"),
        "ads_load_success_rate": _path(available(loading), "total", "load_success_rate"),
        "problem_exit_rate": _path(available(exits), "all", "problem_exit_rate"),
        "retention": retention,
    }


def versions(storage, game_id, start, end, filters, first, second):
    first, second = str(first or "").strip(), str(second or "").strip()
    if not first or not second or first == second:
        raise ValueError("Give two different app versions, for example 0.0.8 and 0.0.9.")
    storage.get_game(game_id)
    try:
        one = _one(storage, game_id, start, end, filters, first)
        two = _one(storage, game_id, start, end, filters, second)
    except HTTPException as error:
        raise ValueError(str(error.detail)) from error
    rows = []
    for key in one:
        if key == "retention":
            continue
        a, b = one[key], two[key]
        row = {"metric": key, first: a, second: b}
        if isinstance(a, (int, float)) and isinstance(b, (int, float)):
            row["change"] = round(b - a, 4)
            row["change_percent"] = round((b - a) / a * 100, 1) if a else None
        rows.append(row)
    if not one["players"] or not two["players"]:
        quiet = first if not one["players"] else second
        note = (
            f"No players on {quiet} in this range and filters; the comparison has nothing to say."
        )
    else:
        note = None
    result = {
        "available": True,
        "versions": [first, second],
        "means": (
            "Each row is read for one version with the same range and filters; change is the "
            f"second version minus the first ({second} − {first}). A None means the game doesn't "
            "send what it needs or there's nothing in that version. Players on both versions "
            "count in both. Compare retention only where both versions had time to be retained "
            "(newer builds have fewer old players); small player counts prove nothing."
        ),
        "rows": rows,
        "retention": {first: one["retention"], second: two["retention"]},
    }
    if note:
        result["note"] = note
    return result
