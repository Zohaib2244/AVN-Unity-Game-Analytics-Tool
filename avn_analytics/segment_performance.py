"""Where it breaks: crashes and ad failures by country, device tier, RAM, OS version and model.

Two measures, each read the way the rest of the app reads it:

- bad exits = launches whose previous run ended in a problem exit (`stability.PROBLEM_REASONS`) /
  launches whose previous exit is known (stability.py);
- ads that fail to show = `AD_ANALYSIS` Failed / (Show + Failed): an ad was asked for and either
  started or had none to show (ads.py). Blocked asks are the game's own rule and are left out.

A group is compared with everyone else in the range (not with the whole, which would include
the group), and is flagged only when the sample is large enough and it is clearly worse in both
points and as a multiple, so one phone does not make a country look broken. Device groups come
from each player's latest device snapshot and session start; a player without one is "unknown".
"""

from . import ads, insights, stability

DIMENSIONS = {
    "country": "Country",
    "device_tier": "Device tier",
    "ram_band": "RAM",
    "os_version": "OS version",
    "device_model": "Device model",
}
MIN_SAMPLE = 50  # launches with a known exit, or ads asked for, before a group is judged
MIN_BAD = 5  # bad exits or failed ads before a group is flagged
MIN_PLAYERS = 10  # players behind a measure before a group is flagged: one phone is not a finding
MIN_EXCESS = 0.03  # points above everyone else
MIN_RATIO = 1.5  # times everyone else
MAX_ROWS = 25
# When several dimensions describe exactly the same events (every Redmi 9A is a low-tier phone under
# 3 GB), the most specific one leads and the others are named as "same players".
SPECIFIC = ("device_model", "os_version", "device_tier", "ram_band", "country")
# measure: (key, "<bad> of <total> <what>", "what the bad ones are")
MEASURES = {
    "bad_exits": ("exit", "launches", "follow a crash or the system killing the game"),
    "ad_failures": ("ad", "ads", "fail to show"),
}
# Groups whose order means something are not sorted by size.
ORDERS = {
    "device_tier": ["low", "medium", "high"],
    "ram_band": [label for _, label in stability.RAM_BANDS] + ["8 GB+"],
}
PLAYERS_TABLE = "perf_players"


def _pct(value):
    return f"{value * 100:.1f}%"


def flag(
    rows,
    min_sample=MIN_SAMPLE,
    min_bad=MIN_BAD,
    min_excess=MIN_EXCESS,
    min_ratio=MIN_RATIO,
    min_players=MIN_PLAYERS,
):
    """Pure: rows {"value", "exit_total", "exit_bad", "ad_total", "ad_bad", ...}. Adds `flags`
    (one per measure the group is clearly worse on, with a sentence) and returns the rows. A row
    that says how many players are behind a measure (`exit_players`, `ad_players`) is flagged on it
    only with at least `min_players`."""
    totals = {
        key: (sum(row[f"{key}_total"] for row in rows), sum(row[f"{key}_bad"] for row in rows))
        for key in ("exit", "ad")
    }
    for row in rows:
        row["flags"] = []
        for measure, (key, unit, words) in MEASURES.items():
            total, bad = row[f"{key}_total"], row[f"{key}_bad"]
            rest_total, rest_bad = totals[key][0] - total, totals[key][1] - bad
            row[f"{key}_rest"] = rest_bad / rest_total if rest_total else None
            if total < min_sample or bad < min_bad or not rest_total:
                continue
            players = row.get(f"{key}_players")
            if players is not None and players < min_players:
                continue
            rate, rest = bad / total, rest_bad / rest_total
            if rate - rest >= min_excess and rate >= rest * min_ratio:
                row["flags"].append(
                    {
                        "measure": measure,
                        "rate": round(rate, 4),
                        "rest": round(rest, 4),
                        "count": bad,
                        "total": total,
                        "words": f"{bad:,} of {total:,} {unit} ({_pct(rate)}) {words}; "
                        f"everyone else {_pct(rest)}",
                    }
                )
    return rows


def _row(value, exits, shows):
    exit_total = exits["known"] if exits else 0
    exit_bad = exits["problems"] if exits else 0
    ad_total = shows["asked"] if shows else 0
    ad_bad = shows["failed"] if shows else 0
    return {
        "value": value,
        "players": max(exits["players"] if exits else 0, shows["players"] if shows else 0),
        "exit_players": exits["players"] if exits else 0,
        "ad_players": shows["players"] if shows else 0,
        "launches": exits["launches"] if exits else 0,
        "exit_total": exit_total,
        "exit_bad": exit_bad,
        "bad_exit_rate": ads._ratio(exit_bad, exit_total),
        "ad_total": ad_total,
        "ad_bad": ad_bad,
        "ad_failure_rate": ads._ratio(ad_bad, ad_total),
    }


def _group_rows(connection, grp_launch, grp_ad, joins_launch, joins_ad):
    exits = {
        row["grp"]: row
        for row in connection.execute(
            f"""SELECT {grp_launch} AS grp, count(DISTINCT l.player) AS players,
                       count(*) AS launches, count(l.reason) AS known,
                       count(*) FILTER (WHERE l.reason IN ({stability.MARKS})) AS problems
                FROM launches l {joins_launch} GROUP BY grp""",
            stability.PROBLEM_REASONS,
        )
    }
    shows = {
        row["grp"]: row
        for row in connection.execute(
            f"""SELECT {grp_ad} AS grp, count(DISTINCT a.player) AS players,
                       count(*) AS asked, count(*) FILTER (WHERE a.state='Failed') AS failed
                FROM ad_events a {joins_ad} WHERE a.state IN ('Show', 'Failed') GROUP BY grp"""
        )
    }
    return [_row(value, exits.get(value), shows.get(value)) for value in {*exits, *shows}]


def _dimension_rows(connection, name):
    if name == "country":
        return _group_rows(
            connection, "coalesce(l.country, 'unknown')", "coalesce(a.country, 'unknown')", "", ""
        )
    column = {"device_tier": "tier", "ram_band": "ram_band", "os_version": "os_version"}.get(
        name, "model"
    )
    return _group_rows(
        connection,
        f"coalesce(d.{column}, 'unknown')",
        f"coalesce(d.{column}, 'unknown')",
        f"LEFT JOIN {PLAYERS_TABLE} d ON d.pid = l.player",
        f"LEFT JOIN {PLAYERS_TABLE} d ON d.pid = a.player",
    )


def _device_table(connection, source):
    """One row per player seen in the launches or ad events: tier, RAM band, model and OS."""
    connection.execute("DROP TABLE IF EXISTS temp.perf_seen")
    connection.execute(
        "CREATE TEMP TABLE perf_seen AS "
        "SELECT player FROM launches UNION SELECT player FROM ad_events"
    )
    stability._device_tables(connection, source, "perf_seen", "player")
    connection.execute(f"DROP TABLE IF EXISTS temp.{PLAYERS_TABLE}")
    connection.execute(
        f"""CREATE TEMP TABLE {PLAYERS_TABLE} AS
            SELECT s.player AS pid, d.tier AS tier, d.ram_band AS ram_band,
                   m.model AS model, m.os_version AS os_version
            FROM perf_seen s LEFT JOIN launch_device d ON d.pid = s.player
            LEFT JOIN launch_model m ON m.pid = s.player"""
    )


def _merged(findings):
    """One finding per set of identical counts: the most specific group, the rest in `same_as`."""
    findings.sort(
        key=lambda item: (SPECIFIC.index(item["dimension"]), str(item["value"])),
    )
    leaders = {}
    for item in findings:
        key = (item["measure"], item["count"], item["total"])
        if key in leaders:
            leaders[key]["same_as"].append(f"{item['label']} {item['value']}")
        else:
            leaders[key] = {**item, "same_as": []}
    merged = list(leaders.values())
    merged.sort(
        key=lambda item: (-(item["rate"] - item["rest"]), SPECIFIC.index(item["dimension"]))
    )
    return merged


def report(storage, game_id, start, end, filters, min_sample=MIN_SAMPLE):
    """Every dimension's groups with their bad-exit and ad-failure rates, worse ones flagged."""
    min_sample = max(1, int(min_sample))
    storage.get_game(game_id)
    with storage.connect(storage.game_path(game_id)) as connection:
        source = insights.read_source(storage, connection)
        stability._launches(connection, source, start, end, filters)
        ads._ad_events(connection, source, start, end, filters)
        has_launches = bool(connection.execute("SELECT 1 FROM launches LIMIT 1").fetchone())
        has_ads = bool(
            connection.execute(
                "SELECT 1 FROM ad_events WHERE state IN ('Show', 'Failed') LIMIT 1"
            ).fetchone()
        )
        if not has_launches and not has_ads:
            return ads._absent(
                "app launches or ad events",
                "APP_ANALYSIS Launch (with PREV_EXIT_REASON) or AD_ANALYSIS",
            )
        _device_table(connection, source)
        everyone = {
            "players": connection.execute("SELECT count(*) FROM perf_seen").fetchone()[0],
            "launches": connection.execute("SELECT count(*) FROM launches").fetchone()[0],
            "exit_total": connection.execute("SELECT count(reason) FROM launches").fetchone()[0],
            "exit_bad": connection.execute(
                f"SELECT count(*) FROM launches WHERE reason IN ({stability.MARKS})",
                stability.PROBLEM_REASONS,
            ).fetchone()[0],
            "ad_total": connection.execute(
                "SELECT count(*) FROM ad_events WHERE state IN ('Show', 'Failed')"
            ).fetchone()[0],
            "ad_bad": connection.execute(
                "SELECT count(*) FROM ad_events WHERE state='Failed'"
            ).fetchone()[0],
        }
        dimensions = {}
        for name, label in DIMENSIONS.items():
            rows = flag(_dimension_rows(connection, name), min_sample)
            known = [row for row in rows if row["value"] != "unknown"]
            order = ORDERS.get(name, [])
            rows.sort(
                key=lambda row: (
                    row["value"] == "unknown",
                    order.index(row["value"]) if row["value"] in order else len(order),
                    -(row["exit_total"] + row["ad_total"]),
                    str(row["value"]),
                )
            )
            dimensions[name] = {
                "label": label,
                "available": len(known) > 0,
                "unknown_players": next((r["players"] for r in rows if r["value"] == "unknown"), 0),
                "groups": len(rows),
                "rows": rows[:MAX_ROWS],
            }
    findings = [
        {
            "dimension": name,
            "label": block["label"],
            "value": row["value"],
            **item,
            "players": row["players"],
        }
        for name, block in dimensions.items()
        for row in block["rows"]
        if row["value"] != "unknown"
        for item in row["flags"]
    ]
    findings = _merged(findings)
    judged = (
        f"{everyone['exit_total']} launches with a known previous exit and "
        f"{everyone['ad_total']} ads asked for"
    )
    if findings:
        top = findings[0]
        summary = f"{top['label']} {top['value']}: {top['words']}."
        if len(findings) > 1:
            summary += f" {len(findings) - 1} more below."
    else:
        summary = f"No country or device group is clearly worse than the rest ({judged})."
    return {
        "available": True,
        "summary": summary,
        "means": (
            "bad exits = launches whose previous run ended in a crash, an ANR or the system "
            "killing the game / launches whose previous exit is known; ads that fail to show = "
            "AD_ANALYSIS Failed / (Show + Failed), blocked asks left out. A group is compared "
            f"with everyone else and listed when it is at least {round(MIN_EXCESS * 100)} points "
            f"and {MIN_RATIO}x worse, with at least {min_sample} launches or ads, {MIN_BAD} "
            f"bad ones and {MIN_PLAYERS} players. Device groups come from each player's latest "
            "device snapshot and session start; players without one are 'unknown'."
        ),
        "everyone": {
            **everyone,
            "bad_exit_rate": ads._ratio(everyone["exit_bad"], everyone["exit_total"]),
            "ad_failure_rate": ads._ratio(everyone["ad_bad"], everyone["ad_total"]),
        },
        "min_sample": min_sample,
        "findings": findings,
        "dimensions": dimensions,
    }
