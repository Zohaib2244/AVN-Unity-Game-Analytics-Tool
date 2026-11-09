"""Stability: how the previous run of the game ended, read from the next launch.

A launch (`APP_ANALYSIS` with STATE Launch) says how the run before it ended: PREV_EXIT_REASON
(the Android ApplicationExitInfo name such as UserRequested, Anr, LowMemory, CrashNative),
PREV_EXIT_IMPORTANCE, PREV_EXIT (Background, Killed or Quit) and PREV_EXIT_AD (the ad format on
screen at the time, or None). The first launch has no previous run and carries none of these.

A "problem exit" is a reason that means the game failed or was killed for resources (see
PROBLEM_REASONS). Signaled is reported but not counted: it is ambiguous (the system and the
player's swipe-away can both look like it). Level exits that were Killed (`LEVEL_ANALYSIS`
STATE Left, REASON Killed) are counted apart, with how many were recovered.
"""

from . import insights
from .ads import _absent, _choice, _ratio
from .systems import _limit, scoped

APP_EVENT = "APP_ANALYSIS"
LEVEL_EVENT = "LEVEL_ANALYSIS"
DEVICE_EVENT = "DEVICE_ANALYSIS"
SESSION_EVENT = "session_start"
GROUPS = ("none", "app_version", "country", "platform", "device_tier", "ram_band", "device_model")
PROBLEM_REASONS = (
    "Anr",
    "Crash",
    "CrashNative",
    "DependencyDied",
    "ExcessiveResourceUsage",
    "InitializationFailure",
    "LowMemory",
)
RAM_BANDS = (  # MB below which a device is in the band
    (3072, "under 3 GB"),
    (5120, "3-5 GB"),
    (8192, "5-8 GB"),
)
TOP_REASONS = 3
MARKS = ",".join("?" * len(PROBLEM_REASONS))
ON_AD = "exit_ad IS NOT NULL AND exit_ad NOT IN ('None', '')"
RAM_CASE = (
    "CASE WHEN ram IS NULL THEN NULL "
    + " ".join(f"WHEN ram < {limit} THEN '{label}'" for limit, label in RAM_BANDS)
    + " ELSE '8 GB+' END"
)


def _device_tables(connection, source):
    """Each launching player's latest device snapshot and session device model (all time)."""
    param, table, player = source.param, source.table, source.player
    connection.execute("DROP TABLE IF EXISTS temp.launch_device")
    connection.execute(
        f"""CREATE TEMP TABLE launch_device AS
            SELECT pid, lower(tier) AS tier, {RAM_CASE} AS ram_band FROM (
                SELECT {player} AS pid, {param("TIER")} AS tier,
                       CAST({param("RAM_MB")} AS REAL) AS ram, max(client_ts)
                FROM {table}
                WHERE name=? AND coalesce({param("STATE")}, 'Snapshot')='Snapshot'
                      AND {player} IN (SELECT player FROM launches)
                GROUP BY {player})""",
        [DEVICE_EVENT],
    )
    connection.execute("DROP TABLE IF EXISTS temp.launch_model")
    connection.execute(
        f"""CREATE TEMP TABLE launch_model AS
            SELECT pid, model FROM (
                SELECT {player} AS pid, {param("device_model")} AS model, max(client_ts)
                FROM {table}
                WHERE name=? AND {param("device_model")} IS NOT NULL
                      AND {player} IN (SELECT player FROM launches)
                GROUP BY {player})""",
        [SESSION_EVENT],
    )


def _grouped_table(connection, source, group_by):
    """The launches with a `grp` column to group by."""
    if group_by in ("app_version", "country", "platform"):
        expression, joins = f"coalesce({group_by}, 'unknown')", ""
    elif group_by == "device_model":
        _device_tables(connection, source)
        expression = "coalesce(m.model, 'unknown')"
        joins = "LEFT JOIN launch_model m ON m.pid = l.player"
    else:
        _device_tables(connection, source)
        column = "tier" if group_by == "device_tier" else "ram_band"
        expression = f"coalesce(d.{column}, 'unknown')"
        joins = "LEFT JOIN launch_device d ON d.pid = l.player"
    connection.execute("DROP TABLE IF EXISTS temp.launch_groups")
    connection.execute(
        f"""CREATE TEMP TABLE launch_groups AS
            SELECT l.reason AS reason, l.exit_ad AS exit_ad, {expression} AS grp
            FROM launches l {joins}"""
    )


def _row(row, reasons):
    known = row["known"]
    return {
        "launches": row["launches"],
        "launches_with_known_previous_exit": known,
        "problem_exits": row["problems"],
        "problem_exit_rate": _ratio(row["problems"], known),
        "problem_exits_with_ad_on_screen": row["problems_on_ad"],
        "previous_exit_reasons": reasons,
    }


COUNTS = f"""count(*) AS launches, count(reason) AS known,
             count(*) FILTER (WHERE reason IN ({MARKS})) AS problems,
             count(*) FILTER (WHERE reason IN ({MARKS}) AND {ON_AD}) AS problems_on_ad"""
PROBLEMS = [*PROBLEM_REASONS, *PROBLEM_REASONS]


def _reasons(rows, known, top=None):
    """{reason: {launches, share}} biggest first, from (reason, launches) rows."""
    ranked = sorted(rows, key=lambda item: (-item[1], item[0]))[:top]
    return {reason: {"launches": n, "share": _ratio(n, known)} for reason, n in ranked}


def _killed_levels(connection, source, start, end, filters):
    columns = {
        "state": ("STATE", "text"),
        "reason": ("REASON", "text"),
        "recovered": ("RECOVERED", "int"),
    }
    scoped(connection, source, start, end, filters, LEVEL_EVENT, "level_exits", columns)
    row = connection.execute(
        """SELECT count(*) FILTER (WHERE state='Left') AS left_events,
                  count(*) FILTER (WHERE state='Left' AND reason='Killed') AS killed,
                  count(*) FILTER (WHERE state='Left' AND reason='Killed' AND recovered=1)
                      AS recovered
           FROM level_exits"""
    ).fetchone()
    if not row["left_events"]:
        return {"available": False, "note": "No level exits (LEVEL_ANALYSIS Left) in this range."}
    return {
        "available": True,
        "left_level_events": row["left_events"],
        "killed": row["killed"],
        "killed_share_of_left": _ratio(row["killed"], row["left_events"]),
        "killed_and_recovered": row["recovered"],
        "recovered_share_of_killed": _ratio(row["recovered"], row["killed"]),
        "means": "Level exits where the game was killed mid-level, and how many of those the "
        "game recovered (RECOVERED = 1). Not split by group_by.",
    }


def stability(storage, game_id, start, end, filters, group_by=None, limit=15):
    """Launches by how the run before them ended, with problem exits and the groups they hit."""
    group_by = _choice(group_by, GROUPS, "none", "group_by")
    limit = _limit(limit)
    storage.get_game(game_id)
    with storage.connect(storage.game_path(game_id)) as connection:
        source = insights.read_source(storage, connection)
        dimensions = {
            name: source.dimensions[name] for name in ("app_version", "country", "platform")
        }
        condition, args = insights.where(start, end, filters, source=source)
        extra = ", ".join(f"{expr} AS {name}" for name, expr in dimensions.items())
        connection.execute("DROP TABLE IF EXISTS temp.launches")
        connection.execute(
            f"""CREATE TEMP TABLE launches AS
                SELECT {source.player} AS player, {extra},
                       nullif({source.param("PREV_EXIT_REASON")}, '') AS reason,
                       {source.param("PREV_EXIT")} AS exit_kind,
                       {source.param("PREV_EXIT_AD")} AS exit_ad
                FROM {source.table}
                WHERE name=? AND {source.param("STATE")}='Launch' AND {condition}""",
            [APP_EVENT, *args],
        )
        if not connection.execute("SELECT 1 FROM launches LIMIT 1").fetchone():
            return _absent("app launches", "APP_ANALYSIS Launch events")
        total = connection.execute(f"SELECT {COUNTS} FROM launches", PROBLEMS).fetchone()
        by_reason = [
            tuple(row)
            for row in connection.execute(
                "SELECT reason, count(*) FROM launches WHERE reason IS NOT NULL GROUP BY 1"
            )
        ]
        by_exit = {
            row[0]: row[1]
            for row in connection.execute(
                "SELECT exit_kind, count(*) FROM launches WHERE exit_kind IS NOT NULL "
                "GROUP BY 1 ORDER BY 2 DESC, 1"
            )
        }
        killed = _killed_levels(connection, source, start, end, filters)
        groups = []
        if group_by != "none":
            _grouped_table(connection, source, group_by)
            rows = connection.execute(
                f"""SELECT grp, {COUNTS} FROM launch_groups GROUP BY grp
                    ORDER BY launches DESC, grp LIMIT ?""",
                [*PROBLEMS, limit],
            ).fetchall()
            per_group = {}
            for grp, reason, n in connection.execute(
                "SELECT grp, reason, count(*) FROM launch_groups WHERE reason IS NOT NULL "
                "GROUP BY 1, 2"
            ):
                per_group.setdefault(grp, []).append((reason, n))
            groups = [
                {
                    "value": row["grp"],
                    **_row(row, _reasons(per_group.get(row["grp"], []), row["known"], TOP_REASONS)),
                }
                for row in rows
            ]
    known = total["known"]
    result = {
        "available": True,
        "means": (
            "Each launch reports how the run before it ended. A problem exit is a previous "
            "exit whose reason is one of problem_reasons (a crash, an ANR, the system killing "
            "the game for memory or resources); Signaled is shown but not counted because it "
            "is ambiguous. problem_exit_rate = problem exits / launches whose previous exit "
            "is known (the first launch of an install has none). Shares are of those known "
            "exits. An ad on screen means the format was named in PREV_EXIT_AD."
        ),
        "problem_reasons": sorted(PROBLEM_REASONS),
        "all": _row(total, _reasons(by_reason, known)),
        "previous_exit_kinds": by_exit,
        "killed_in_a_level": killed,
        "group_by": group_by,
        "groups": groups,
    }
    if not known:
        result["note"] = (
            "No launch carries a previous exit reason: this game may not send PREV_EXIT_REASON."
        )
    if group_by in ("device_tier", "ram_band", "device_model"):
        result["groups_note"] = (
            "Device groups come from the player's latest device snapshot (DEVICE_ANALYSIS) or "
            "session device model; players without one are 'unknown'. ram_band edges are "
            "3072, 5120 and 8192 MB."
        )
    return result
