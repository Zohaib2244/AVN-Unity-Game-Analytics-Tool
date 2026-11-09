"""Level attempts: every try at a level, joined by ATTEMPT_ID, and the level designs behind them.

`LEVEL_ANALYSIS` events of one try share an ATTEMPT_ID:

- Started: LEVEL_NUMBER, LEVEL_ID (the design, which the game reuses at many level numbers),
  ATTEMPT (the player's try number), SOURCE, MOVES_START, IS_BOSS_LEVEL, IS_HARD_LEVEL.
- Completed or Failed: SECONDS, MOVES_LEFT, REVIVES, POWERUPS_USED, ADS_SHOWN and the banner
  numbers. A Choice follows with what the player did next (ACTION); Left says why they left
  (REASON).

An attempt is Completed if it has a Completed event, else Failed if it has a Failed event, else
Left if it has a Left event, else Open (nothing came after the start). Only the Started event is
bound to the date range, filters and segment; the rest of the attempt is found by its id, so a
try that began on the last day and ended after midnight is not cut in two. Ads count when an
AD_ANALYSIS Show event carries the same ATTEMPT_ID.

A game that sends no such events gets `available: false` and a sentence, never zeros.
"""

import math
from collections import Counter, defaultdict
from statistics import median

from . import insights

LEVEL_EVENT = "LEVEL_ANALYSIS"
AD_EVENT = "AD_ANALYSIS"
RESULTS = ("Completed", "Failed", "Left", "Open")
DESIGN_SORTS = ("completion_asc", "attempts_desc", "seconds_desc")
MAX_ATTEMPTS = 1_000_000  # attempts read into one answer
MAX_ROWS = 50
MAX_DESIGNS = 40
LEVEL_NUMBERS_SHOWN = 8
LEVEL_IDS_SHOWN = 5
AGGREGATE_RESULTS = "('Completed', 'Failed')"


def _ratio(part, whole, digits=4):
    return round(part / whole, digits) if whole else None


def _seconds(value):
    return round(value, 1) if value is not None else None


def _quantile(values, share):
    """Nearest-rank quantile of a list of numbers (share between 0 and 1)."""
    if not values:
        return None
    ordered = sorted(values)
    return ordered[max(0, math.ceil(share * len(ordered)) - 1)]


def _flag(expression):
    return f"(lower(CAST({expression} AS TEXT)) IN ('1', 'true'))"


def _absent(note):
    return {"available": False, "note": note}


def _build(connection, source, start, end, filters, level=None):
    """Create the temporary `attempts` table (one row per started attempt). Returns None when it
    was built, else the sentence to give instead."""
    condition, args = insights.where(start, end, filters, source=source)
    param, table = source.param, source.table
    started = f"name=? AND {param('STATE')}='Started' AND {condition}"
    counts = connection.execute(
        f"""SELECT count(*) AS total, count({param("ATTEMPT_ID")}) AS with_id
            FROM {table} WHERE {started}""",
        [LEVEL_EVENT, *args],
    ).fetchone()
    if not counts["total"]:
        return _absent(
            "No level starts in this range. The game may not send LEVEL_ANALYSIS, or nothing "
            "was recorded for these dates and filters."
        )
    if not counts["with_id"]:
        return _absent(
            "The level starts in this range carry no ATTEMPT_ID, so results can't be matched "
            "to the attempt that produced them."
        )
    level_test, level_args = "", []
    if level is not None:
        level_test = f" AND CAST({param('LEVEL_NUMBER')} AS INTEGER) = ?"
        level_args = [level]
    connection.execute("DROP TABLE IF EXISTS temp.att_started")
    connection.execute(
        f"""CREATE TEMP TABLE att_started AS
            SELECT {param("ATTEMPT_ID")} AS attempt_id, {source.player} AS player,
                   min(client_ts) AS started_at,
                   CAST({param("LEVEL_NUMBER")} AS INTEGER) AS level_number,
                   {param("LEVEL_ID")} AS level_id,
                   CAST({param("ATTEMPT")} AS INTEGER) AS attempt,
                   {param("SOURCE")} AS entry,
                   CAST({param("MOVES_START")} AS INTEGER) AS moves_start,
                   {_flag(param("IS_BOSS_LEVEL"))} AS boss, {_flag(param("IS_HARD_LEVEL"))} AS hard
            FROM {table} WHERE {started} AND {param("ATTEMPT_ID")} IS NOT NULL{level_test}
            GROUP BY attempt_id LIMIT {MAX_ATTEMPTS}""",
        [LEVEL_EVENT, *args, *level_args],
    )
    if not connection.execute("SELECT 1 FROM att_started LIMIT 1").fetchone():
        seen = connection.execute(
            f"""SELECT min(CAST({param("LEVEL_NUMBER")} AS INTEGER)) AS first,
                       max(CAST({param("LEVEL_NUMBER")} AS INTEGER)) AS last
                FROM {table} WHERE {started}""",
            [LEVEL_EVENT, *args],
        ).fetchone()
        return _absent(
            f"Nobody started level {level} in this range with these filters. Levels started "
            f"here run from {seen['first']} to {seen['last']}."
        )
    connection.execute("DROP TABLE IF EXISTS temp.att_events")
    connection.execute(
        f"""CREATE TEMP TABLE att_events AS
            SELECT {param("ATTEMPT_ID")} AS attempt_id, {param("STATE")} AS state, client_ts,
                   CAST({param("SECONDS")} AS REAL) AS seconds,
                   CAST({param("MOVES_LEFT")} AS INTEGER) AS moves_left,
                   CAST({param("REVIVES")} AS INTEGER) AS revives,
                   CAST({param("POWERUPS_USED")} AS INTEGER) AS powerups,
                   CAST({param("ADS_SHOWN")} AS INTEGER) AS ads_reported,
                   CAST({param("BANNER_IMPRESSIONS")} AS INTEGER) AS banner_impressions,
                   CAST({param("BANNER_REVENUE")} AS REAL) AS banner_revenue,
                   {param("ACTION")} AS action, {param("REASON")} AS reason,
                   {param("RECOVERED")} AS recovered
            FROM {table}
            WHERE name=? AND client_ts>=?
              AND {param("STATE")} IN ('Completed', 'Failed', 'Left', 'Choice')
              AND {param("ATTEMPT_ID")} IN (SELECT attempt_id FROM att_started)""",
        [LEVEL_EVENT, start],
    )
    connection.execute("DROP TABLE IF EXISTS temp.att_ads")
    connection.execute(
        f"""CREATE TEMP TABLE att_ads AS
            SELECT {param("ATTEMPT_ID")} AS attempt_id, count(*) AS shown
            FROM {table}
            WHERE name=? AND client_ts>=? AND {param("STATE")}='Show'
              AND {param("ATTEMPT_ID")} IN (SELECT attempt_id FROM att_started)
            GROUP BY attempt_id""",
        [AD_EVENT, start],
    )
    connection.execute("DROP TABLE IF EXISTS temp.attempts")
    connection.execute(
        """CREATE TEMP TABLE attempts AS
           SELECT s.*,
                  CASE WHEN r.completed > 0 THEN 'Completed' WHEN r.failed > 0 THEN 'Failed'
                       WHEN r.gone > 0 THEN 'Left' ELSE 'Open' END AS result,
                  r.seconds, r.moves_left, r.revives, r.powerups, r.ads_reported,
                  r.banner_impressions, r.banner_revenue, r.left_reason, r.recovered,
                  CASE WHEN r.choice IS NOT NULL THEN substr(r.choice, instr(r.choice, '|') + 1)
                  END AS action,
                  coalesce(a.shown, 0) AS ads
           FROM att_started AS s
           LEFT JOIN (
               SELECT attempt_id,
                      count(*) FILTER (WHERE state='Completed') AS completed,
                      count(*) FILTER (WHERE state='Failed') AS failed,
                      count(*) FILTER (WHERE state='Left') AS gone,
                      coalesce(max(CASE WHEN state='Completed' THEN seconds END),
                               max(CASE WHEN state='Failed' THEN seconds END)) AS seconds,
                      coalesce(max(CASE WHEN state='Completed' THEN moves_left END),
                               max(CASE WHEN state='Failed' THEN moves_left END)) AS moves_left,
                      coalesce(max(CASE WHEN state='Completed' THEN revives END),
                               max(CASE WHEN state='Failed' THEN revives END)) AS revives,
                      coalesce(max(CASE WHEN state='Completed' THEN powerups END),
                               max(CASE WHEN state='Failed' THEN powerups END)) AS powerups,
                      coalesce(max(CASE WHEN state='Completed' THEN ads_reported END),
                               max(CASE WHEN state='Failed' THEN ads_reported END)) AS ads_reported,
                      coalesce(max(CASE WHEN state='Completed' THEN banner_impressions END),
                               max(CASE WHEN state='Failed' THEN banner_impressions END))
                          AS banner_impressions,
                      coalesce(max(CASE WHEN state='Completed' THEN banner_revenue END),
                               max(CASE WHEN state='Failed' THEN banner_revenue END))
                          AS banner_revenue,
                      max(CASE WHEN state='Left' THEN reason END) AS left_reason,
                      max(CASE WHEN state='Left' THEN recovered END) AS recovered,
                      max(CASE WHEN state='Choice' THEN client_ts || '|' || coalesce(action, '')
                          END) AS choice
               FROM att_events GROUP BY attempt_id) AS r ON r.attempt_id = s.attempt_id
           LEFT JOIN att_ads AS a ON a.attempt_id = s.attempt_id"""
    )
    return None


def _has_attempt_ads(connection, source, start):
    return bool(
        connection.execute(
            f"""SELECT 1 FROM {source.table}
                WHERE name=? AND client_ts>=? AND {source.param("ATTEMPT_ID")} IS NOT NULL
                LIMIT 1""",
            [AD_EVENT, start],
        ).fetchone()
    )


def _row(row):
    """An attempt as the answer shows it, without the values it doesn't have."""
    shown = {
        "attempt_id": row["attempt_id"],
        "player": row["player"],
        "started_at": row["started_at"],
        "try": row["attempt"],
        "result": row["result"],
        "seconds": _seconds(row["seconds"]),
        "moves_start": row["moves_start"],
        "moves_left": row["moves_left"],
        "revives": row["revives"],
        "powerups": row["powerups"],
        "ads": row["ads"],
        "action": row["action"],
        "left_reason": row["left_reason"],
        "recovered": row["recovered"],
        "came_from": row["entry"],
    }
    return {key: value for key, value in shown.items() if value is not None}


def attempts(storage, game_id, start, end, filters, level, limit=20, result=None):
    """The tries at one level number: a summary and the most recent attempts."""
    level = int(level)
    limit = max(1, min(int(limit or 20), MAX_ROWS))
    if result is not None:
        wanted = str(result).capitalize()
        if wanted not in RESULTS:
            raise ValueError(f"result is one of: {', '.join(RESULTS)}.")
        result = wanted
    storage.get_game(game_id)
    with storage.connect(storage.game_path(game_id)) as connection:
        source = insights.read_source(storage, connection)
        missing = _build(connection, source, start, end, filters, level)
        if missing:
            return missing
        has_ads = _has_attempt_ads(connection, source, start)
        counts = dict(
            connection.execute(
                f"""SELECT count(*) AS attempts, count(DISTINCT player) AS players,
                           count(*) FILTER (WHERE result='Completed') AS completed,
                           count(*) FILTER (WHERE result='Failed') AS failed,
                           count(*) FILTER (WHERE result='Left') AS gone,
                           count(*) FILTER (WHERE result='Open') AS idle,
                           count(*) FILTER (WHERE result IN {AGGREGATE_RESULTS}
                                            AND revives > 0) AS with_revives,
                           count(*) FILTER (WHERE result IN {AGGREGATE_RESULTS}
                                            AND powerups > 0) AS with_powerups,
                           avg(ads) AS ads,
                           sum(banner_revenue) AS banner_revenue,
                           sum(banner_impressions) AS banner_impressions
                    FROM attempts"""
            ).fetchone()
        )
        completed = connection.execute(
            "SELECT seconds, moves_left FROM attempts WHERE result='Completed'"
        ).fetchall()
        choices = Counter(
            {
                row["action"]: row["n"]
                for row in connection.execute(
                    """SELECT action, count(*) AS n FROM attempts
                       WHERE action IS NOT NULL AND action != '' GROUP BY action"""
                )
            }
        )
        designs = connection.execute(
            """SELECT level_id, count(*) AS n FROM attempts WHERE level_id IS NOT NULL
               GROUP BY level_id ORDER BY n DESC LIMIT ?""",
            (LEVEL_IDS_SHOWN,),
        ).fetchall()
        matching = connection.execute(
            "SELECT count(*) FROM attempts" + (" WHERE result=?" if result else ""),
            [result] if result else [],
        ).fetchone()[0]
        rows = connection.execute(
            "SELECT * FROM attempts"
            + (" WHERE result=?" if result else "")
            + " ORDER BY started_at DESC, attempt_id LIMIT ?",
            ([result] if result else []) + [limit],
        ).fetchall()
    seconds = [row["seconds"] for row in completed if row["seconds"] is not None]
    moves = [row["moves_left"] for row in completed if row["moves_left"] is not None]
    finished = counts["completed"] + counts["failed"]
    total = counts["attempts"]
    return {
        "available": True,
        "level": level,
        "level_ids": [{"level_id": row["level_id"], "attempts": row["n"]} for row in designs],
        "means": (
            "An attempt is one try at the level (one ATTEMPT_ID). Completed = it was cleared, "
            "Failed = it was lost and not cleared, Left = the player left without a result, "
            "Open = nothing came after the start. completion_rate = Completed / (Completed + "
            "Failed). Seconds and moves_left are for Completed attempts. Revive and power-up "
            "shares are of attempts that ended Completed or Failed. next_action is what the "
            "player chose after the result."
        ),
        "summary": {
            "attempts": total,
            "players": counts["players"],
            "results": {
                name: {"attempts": counts[key], "share": _ratio(counts[key], total)}
                for name, key in (
                    ("Completed", "completed"),
                    ("Failed", "failed"),
                    ("Left", "gone"),
                    ("Open", "idle"),
                )
            },
            "completion_rate": _ratio(counts["completed"], finished),
            "median_seconds_completed": _seconds(median(seconds)) if seconds else None,
            "p90_seconds_completed": _seconds(_quantile(seconds, 0.9)),
            "median_moves_left_completed": median(moves) if moves else None,
            "share_with_revives": _ratio(counts["with_revives"], finished),
            "share_with_powerups": _ratio(counts["with_powerups"], finished),
            "average_ads_per_attempt": round(counts["ads"], 3) if has_ads else None,
            "banner_revenue": round(counts["banner_revenue"], 6)
            if counts["banner_revenue"] is not None
            else None,
            "next_action": dict(choices.most_common()),
        },
        "ads_note": None
        if has_ads
        else "No ad in this game carries an ATTEMPT_ID, so ads per attempt can't be told.",
        "rows_filter": result,
        "rows_matching": matching,
        "attempts": [_row(row) for row in rows],
    }


def designs(storage, game_id, start, end, filters, sort=None, min_attempts=30, limit=20):
    """Per level design (LEVEL_ID): how hard it plays wherever the game puts it."""
    sort = sort or DESIGN_SORTS[0]
    if sort not in DESIGN_SORTS:
        raise ValueError(f"sort is one of: {', '.join(DESIGN_SORTS)}.")
    min_attempts = max(1, int(30 if min_attempts is None else min_attempts))
    limit = max(1, min(int(limit or 20), MAX_DESIGNS))
    storage.get_game(game_id)
    with storage.connect(storage.game_path(game_id)) as connection:
        source = insights.read_source(storage, connection)
        missing = _build(connection, source, start, end, filters)
        if missing:
            return missing
        if not connection.execute(
            "SELECT 1 FROM attempts WHERE level_id IS NOT NULL LIMIT 1"
        ).fetchone():
            return _absent(
                "The level starts in this range carry no LEVEL_ID, so designs can't be told."
            )
        found = [
            dict(row)
            for row in connection.execute(
                """SELECT level_id, count(*) AS attempts, count(DISTINCT player) AS players,
                          count(*) FILTER (WHERE result='Completed') AS completed,
                          count(*) FILTER (WHERE result='Failed') AS failed,
                          count(*) FILTER (WHERE result='Left') AS gone,
                          count(DISTINCT level_number) AS numbers,
                          count(*) FILTER (WHERE hard) AS hard, count(*) FILTER (WHERE boss) AS boss
                   FROM attempts WHERE level_id IS NOT NULL GROUP BY level_id"""
            )
        ]
        times = defaultdict(list)
        for row in connection.execute(
            "SELECT level_id, seconds FROM attempts "
            "WHERE result='Completed' AND seconds IS NOT NULL AND level_id IS NOT NULL"
        ):
            times[row["level_id"]].append(row["seconds"])
        unnamed = connection.execute(
            "SELECT count(*) FROM attempts WHERE level_id IS NULL"
        ).fetchone()[0]
        for design in found:
            seconds = times.get(design["level_id"], [])
            design["median_seconds"] = median(seconds) if seconds else None
            finished = design["completed"] + design["failed"]
            design["rate"] = design["completed"] / finished if finished else None
        kept = [design for design in found if design["attempts"] >= min_attempts]

        def order(design):
            if sort == "attempts_desc":
                return (-design["attempts"], design["level_id"])
            if sort == "seconds_desc":
                missing = design["median_seconds"] is None
                return (missing, -(design["median_seconds"] or 0), design["level_id"])
            missing = design["rate"] is None
            return (missing, design["rate"] or 0, -design["attempts"], design["level_id"])

        shown = sorted(kept, key=order)[:limit]
        numbers = defaultdict(list)
        if shown:
            marks = ",".join("?" * len(shown))
            for row in connection.execute(
                f"""SELECT level_id, level_number FROM attempts
                    WHERE level_id IN ({marks}) AND level_number IS NOT NULL
                    GROUP BY level_id, level_number ORDER BY level_id, level_number""",
                [design["level_id"] for design in shown],
            ):
                numbers[row["level_id"]].append(row["level_number"])
    return {
        "available": True,
        "means": (
            "One row per level design (LEVEL_ID). The game reuses a design at many level numbers, "
            "so this pools every try at it wherever it appears, unlike the per-level table, which "
            "splits the same design across level numbers and mixes different designs at one "
            "number over time. completion_rate = Completed / (Completed + Failed); left_share = "
            "Left / attempts; seconds are for Completed attempts."
        ),
        "sort": sort,
        "min_attempts": min_attempts,
        "designs_seen": len(found),
        "designs_with_enough_attempts": len(kept),
        "attempts_without_level_id": unnamed,
        "designs": [
            {
                "level_id": design["level_id"],
                "attempts": design["attempts"],
                "players": design["players"],
                "completion_rate": _ratio(
                    design["completed"], design["completed"] + design["failed"]
                ),
                "left_share": _ratio(design["gone"], design["attempts"]),
                "median_seconds_completed": _seconds(design["median_seconds"]),
                "level_numbers_using_it": design["numbers"],
                "level_numbers": numbers.get(design["level_id"], [])[:LEVEL_NUMBERS_SHOWN],
                "hard_share": _ratio(design["hard"], design["attempts"]),
                "boss_share": _ratio(design["boss"], design["attempts"]),
            }
            for design in shown
        ],
    }
