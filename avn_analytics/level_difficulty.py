"""Level difficulty finder: levels that fail or lose players far more than the levels around them.

Built on the level attempts (`level_attempts._build`, joined by ATTEMPT_ID). For each level number:

- fail rate = Failed / (Completed + Failed) attempts;
- stop share = players whose furthest level started in the range is this one / players who
  started it. It includes players who are still playing and simply haven't gone further yet, so
  it is only compared with the neighbouring levels, which carry the same bias; a level fewer than
  MIN_PLAYERS players went beyond (the frontier, where the newest content ends) is left out.

A level is expected to look like its neighbours: the median of the levels within WINDOW numbers
either side that have enough attempts. It is flagged when it is both clearly higher in absolute
terms (MIN_EXCESS) and relative terms (MIN_RATIO). The answer says this as a sentence per level.
"""

from math import sqrt
from statistics import median

from . import insights, level_attempts

WINDOW = 3
MIN_ATTEMPTS = 30
MIN_PLAYERS = 20
MIN_NEIGHBOURS = 2
MIN_EXCESS = 0.10
MIN_RATIO = 1.5
MAX_SHOWN = 20
# Hundreds of levels are compared, so a level is listed only when even the low end of what its own
# tries allow (a wide 99% margin) is clearly above its neighbours: a handful of tries never does.
Z = 2.58
METRICS = {
    "fail_rate": ("fail", "of finished tries fail"),
    "stop_share": ("stop", "of players who reach it go no further"),
}


def _low_end(count, total):
    """The low end of the rate `count` / `total` (Wilson interval); None without a total."""
    if not total:
        return None
    rate = count / total
    spread = Z * sqrt(rate * (1 - rate) / total + Z * Z / (4 * total * total))
    return (rate + Z * Z / (2 * total) - spread) / (1 + Z * Z / total)


def _expected(levels, index, metric, window):
    number = levels[index]["level"]
    values = [
        other[metric]
        for other in levels
        if other is not levels[index]
        and abs(other["level"] - number) <= window
        and other[metric] is not None
    ]
    return median(values) if len(values) >= MIN_NEIGHBOURS else None


def _pct(value):
    return f"{round(value * 100)}%"


def flag(levels, window=WINDOW, min_excess=MIN_EXCESS, min_ratio=MIN_RATIO):
    """Pure: given rows {"level", "fail_rate", "stop_share", ...} with None where a level has too
    little data, return the flagged levels, most surprising first, each with its reasons."""
    levels = sorted(levels, key=lambda row: row["level"])
    found = []
    for index, row in enumerate(levels):
        reasons = []
        for metric, (short, words) in METRICS.items():
            value = row.get(metric)
            if value is None:
                continue
            expected = _expected(levels, index, metric, window)
            if expected is None:
                continue
            excess = value - expected
            if excess >= min_excess and value >= expected * min_ratio:
                # rows that carry their counts must also clear the bar at the low end of their rate
                low = _low_end(row.get(f"{short}_count") or 0, row.get(f"{short}_total"))
                if low is not None and not (
                    low - expected >= min_excess and low >= expected * min_ratio
                ):
                    continue
                reasons.append(
                    {
                        "metric": metric,
                        "count": row.get(f"{short}_count"),
                        "value": round(value, 4),
                        "expected": round(expected, 4),
                        "excess": round(excess, 4),
                        "words": f"{_pct(value)} {words}; levels around it about {_pct(expected)}",
                        "short": short,
                    }
                )
        if reasons:
            found.append({**row, "reasons": reasons, "score": max(r["excess"] for r in reasons)})
    found.sort(key=lambda row: (-row["score"], row["level"]))
    return found


def find(storage, game_id, start, end, filters, min_attempts=MIN_ATTEMPTS, limit=MAX_SHOWN):
    """Levels that are much harder, or lose many more players, than the levels around them."""
    min_attempts = max(1, int(min_attempts))
    limit = max(1, min(int(limit), MAX_SHOWN))
    storage.get_game(game_id)
    with storage.connect(storage.game_path(game_id)) as connection:
        source = insights.read_source(storage, connection)
        missing = level_attempts._build(connection, source, start, end, filters)
        if missing:
            return missing
        rows = [
            dict(row)
            for row in connection.execute(
                """SELECT level_number AS level, count(*) AS attempts,
                          count(DISTINCT player) AS players,
                          count(*) FILTER (WHERE result='Completed') AS completed,
                          count(*) FILTER (WHERE result='Failed') AS failed
                   FROM attempts WHERE level_number IS NOT NULL
                   GROUP BY level_number ORDER BY level_number"""
            )
        ]
        stopped = {
            row["level"]: row["players"]
            for row in connection.execute(
                """SELECT furthest AS level, count(*) AS players FROM (
                       SELECT player, max(level_number) AS furthest FROM attempts
                       WHERE level_number IS NOT NULL GROUP BY player)
                   GROUP BY furthest"""
            )
        }
    if not rows:
        return level_attempts._absent("The level starts in this range carry no LEVEL_NUMBER.")
    levels = []
    for row in rows:
        finished = row["completed"] + row["failed"]
        enough = row["attempts"] >= min_attempts and finished
        beyond = sum(count for number, count in stopped.items() if number > row["level"])
        frontier = beyond < MIN_PLAYERS
        levels.append(
            {
                **row,
                "fail_count": row["failed"],
                "fail_total": finished,
                "stop_count": stopped.get(row["level"], 0),
                "stop_total": row["players"],
                "fail_rate": row["failed"] / finished if enough else None,
                "stop_share": (
                    stopped.get(row["level"], 0) / row["players"]
                    if row["players"] >= MIN_PLAYERS and not frontier
                    else None
                ),
            }
        )
    found = flag(levels)
    judged = sum(1 for row in levels if row["fail_rate"] is not None)
    if found:
        top = found[0]
        summary = f"Level {top['level']} stands out: {top['reasons'][0]['words']}."
        shown = min(len(found), limit)
        if shown > 1:
            summary += f" {shown - 1} more level{'s' if shown > 2 else ''} below."
        if len(found) > shown:
            summary += (
                f" {len(found)} levels stand out in all; the {shown} furthest from their "
                "neighbours are listed."
            )
    else:
        summary = (
            f"No level stands out from the levels around it ({judged} levels had enough tries)."
        )
    return {
        "available": True,
        "summary": summary,
        "means": (
            "fail_rate = Failed / (Completed + Failed) tries; stop_share = players whose "
            "furthest level in the range is this one / players who started it (includes players "
            "still playing, so it is only compared with nearby levels). expected = median of the "
            f"levels within {WINDOW} either side with enough data. count = the failed tries or "
            "the players who stopped. A level is listed when it is "
            f"at least {round(MIN_EXCESS * 100)} points and {MIN_RATIO}x above that."
        ),
        "levels_judged": judged,
        "levels_flagged": len(found),
        "min_attempts": min_attempts,
        "levels": [
            {
                "level": row["level"],
                "attempts": row["attempts"],
                "players": row["players"],
                "fail_rate": None if row["fail_rate"] is None else round(row["fail_rate"], 4),
                "stop_share": None if row["stop_share"] is None else round(row["stop_share"], 4),
                "reasons": row["reasons"],
            }
            for row in found[:limit]
        ],
    }
