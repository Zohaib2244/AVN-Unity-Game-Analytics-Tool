"""What separates players who stay (or pay) from those who don't: their first-day behaviour.

The cohort is the players whose first open (`first_open`) is in the range, like Acquisition. An
outcome splits them in two:

- `day_1`, `day_3`, `day_7`: came back, meaning any event on exactly that day after the first-open
  day. Only players whose day is already over in the data are counted (the others are left out,
  not counted as lost);
- `pays`: bought something (`IAP_ANALYSIS` Purchased) within the first 7 days. Purchases and
  everything the player did after their first one are kept out of what is compared.

What is compared is what each player did in their first `window_days` days: whether they sent each
kind of event (name and STATE) and sent it at least a few times, whether they played two sessions,
and who they are (country, platform, app version, device tier, RAM, model, OS, install source).

Each such fact splits the cohort into players with it and without it. It is reported only when both
sides have at least MIN_GROUP players and the gap is both at least MIN_POINTS and clear after a
generous allowance for the many facts tried (a wide 99.9% interval). Players who have the fact
are not necessarily the cause of the outcome: this is association, never cause.
"""

from . import acquisition, insights, player_groups, stability
from .stories import Labeler

FIRST_OPEN = "first_open"
IAP_EVENT = "IAP_ANALYSIS"
ATTRIBUTION = "ATTRIBUTION_ANALYSIS"
OUTCOMES = {
    "day_1": ("came back on day 1", 1),
    "day_3": ("came back on day 3", 3),
    "day_7": ("came back on day 7", 7),
    "pays": ("paid in their first 7 days", 7),
}
PAY_DAYS = 7
MAX_PLAYERS = 100_000
MAX_WINDOW = 3
MIN_GROUP = 30  # players on each side of a fact
MIN_POINTS = 5.0  # percentage points between the sides
Z = 3.29  # 99.9%: many facts are tried, so only a clear gap is reported
MAX_KEYS = 80  # kinds of event tried, most common first
MAX_SHOWN = 8  # findings per direction
SESSIONS_KEY = "sessions"
CATEGORIES = {
    "country": "from {}",
    "platform": "on {}",
    "app_version": "on version {}",
    "tier": "on a {} device",
    "ram_band": "with {} of RAM",
    "model": "on a {}",
    "os_version": "on {}",
    "media_source": "from the {} install source",
}


def _pct(value):
    return f"{value * 100:.1f}%"


def _times(window_days):
    return "on their first day" if window_days == 1 else f"in their first {window_days} days"


def _event_label(labeler, key, window_days, at_least=1):
    """ "had “Level · Completed” at least 2 times on their first day": the game's own dictionary
    names the event when it has one."""
    name, _, state = key.partition(" ")
    human = labeler.label(name, {"STATE": state} if state else {}) or key
    count = "" if at_least <= 1 else f" at least {at_least} times"
    return f"had “{human}”{count} {_times(window_days)}"


def _chip(feature):
    """The Players-group chip that holds these players, when one says it exactly (or nearly: an
    event chip means 'ever sent', not 'sent in the first days')."""
    kind = feature["kind"]
    if kind == "event" and feature.get("at_least", 1) <= 1:
        name, _, state = feature["key"].partition(" ")
        chip = {"kind": "event", "event": name}
        if state:
            chip |= {"param": "STATE", "values": [state]}
        return chip
    if kind == "media_source":
        return {"kind": "media_source", "values": [feature["value"]]}
    return None


def compare(features, outcome_set, eligible, min_group=MIN_GROUP, min_points=MIN_POINTS, z=Z):
    """Pure: `features` is a list of {"label", "kind", "players": set}; `outcome_set` the eligible
    players who met the outcome; `eligible` all players counted. Returns the findings (ranked by
    the gap), each with both sides' counts and a sentence."""
    candidates = []
    total = len(eligible)
    for feature in features:
        with_ = feature["players"] & eligible
        if len(with_) < min_group or total - len(with_) < min_group:
            continue
        a = {"reached": len(with_ & outcome_set), "players": len(with_)}
        without = total - len(with_)
        b = {"reached": len(outcome_set) - a["reached"], "players": without}
        gap = player_groups.difference(a, b, z)
        if gap is None or gap["includes_zero"] or abs(gap["percentage_points"]) < min_points:
            continue
        item = {
            **{k: v for k, v in feature.items() if k != "players"},
            "with": {**a, "rate": round(a["reached"] / a["players"], 4)},
            "without": {**b, "rate": round(b["reached"] / b["players"], 4)},
            "points": gap["percentage_points"],
            "interval": gap["interval"],
        }
        candidates.append((item, frozenset(with_)))
    # The same players, or exactly the opposite players ("completed" and "failed"), say the same
    # thing twice: keep the one that reads as "more likely", else the first.
    candidates.sort(
        key=lambda pair: (pair[0]["points"] < 0, -abs(pair[0]["points"]), pair[0]["label"])
    )
    found, seen = [], set()
    everyone = frozenset(eligible)
    for item, signature in candidates:
        if signature in seen or (everyone - signature) in seen:
            continue
        seen.add(signature)
        found.append(item)
    found.sort(key=lambda item: (-abs(item["points"]), item["label"]))
    return found


def _words(item, verb):
    return (
        f"{_pct(item['with']['rate'])} of the {item['with']['players']:,} players who "
        f"{item['label']} {verb}, against {_pct(item['without']['rate'])} of the "
        f"{item['without']['players']:,} who didn't"
    )


def _cohort(connection, source, start, end, filters, outcome, window_days):
    condition, args = insights.where(start, end, filters, source=source)
    table, player = source.table, source.player
    dims = source.dimensions
    connection.execute("DROP TABLE IF EXISTS temp.sep_cohort")
    connection.execute(
        f"""CREATE TEMP TABLE sep_cohort AS
            SELECT {player} AS pid, substr(min(client_ts), 1, 10) AS cday,
                   min(client_ts) AS first_ts, '9999' AS cut,
                   {dims["country"]} AS country, {dims["platform"]} AS platform,
                   {dims["app_version"]} AS app_version
            FROM {table} WHERE name=? AND {condition} AND {player} IS NOT NULL
            GROUP BY pid LIMIT {MAX_PLAYERS}""",
        [FIRST_OPEN, *args],
    )
    if outcome == "pays":
        connection.execute(
            f"""UPDATE sep_cohort SET cut = coalesce((
                    SELECT min(client_ts) FROM {table}
                    WHERE name=? AND {source.param("STATE")}='Purchased'
                          AND {player} = sep_cohort.pid), '9999')""",
            [IAP_EVENT],
        )


def analyse(storage, game_id, start, end, filters, outcome="day_7", window_days=1):
    """Which first-day facts go with coming back (or paying), as ranked findings in words."""
    if outcome not in OUTCOMES:
        raise ValueError(f"outcome is one of: {', '.join(OUTCOMES)}.")
    window_days = int(window_days or 1)
    if not 1 <= window_days <= MAX_WINDOW:
        raise ValueError(f"window_days is a whole number from 1 to {MAX_WINDOW}.")
    label, day = OUTCOMES[outcome]
    if window_days > day and outcome != "pays":
        raise ValueError(
            f"To look at {window_days} days of play, ask about day {window_days} or later."
        )
    storage.get_game(game_id)
    with storage.connect(storage.game_path(game_id)) as connection:
        source = insights.read_source(storage, connection)
        table, player, param = source.table, source.player, source.param
        if (
            outcome == "pays"
            and not connection.execute(
                f"SELECT 1 FROM {table} WHERE name=? AND {param('STATE')}='Purchased' LIMIT 1",
                [IAP_EVENT],
            ).fetchone()
        ):
            return {
                "available": False,
                "note": "The game sends no purchases (IAP_ANALYSIS Purchased), so there is "
                "nobody to compare payers with.",
            }
        _cohort(connection, source, start, end, filters, outcome, window_days)
        cohort = {
            row["pid"]: row["cday"]
            for row in connection.execute("SELECT pid, cday FROM sep_cohort")
        }
        if not cohort:
            return {
                "available": False,
                "note": "No player opened the game for the first time in this range "
                "(with these filters).",
            }
        last_day = connection.execute(
            f"SELECT max(substr(client_ts, 1, 10)) FROM {table}"
        ).fetchone()[0]
        eligible = {
            pid
            for pid, cday in cohort.items()
            if acquisition._day_after(cday, max(day, window_days - 1)) < last_day
        }
        if outcome == "pays":
            met = {
                row[0]
                for row in connection.execute(
                    f"""SELECT DISTINCT sep_cohort.pid FROM {table}
                        JOIN sep_cohort ON {player} = sep_cohort.pid
                        WHERE name=? AND {param("STATE")}='Purchased'
                              AND substr(client_ts, 1, 10)
                                  <= date(sep_cohort.cday, '+{PAY_DAYS} days')""",
                    [IAP_EVENT],
                )
            }
        else:
            met = {
                row[0]
                for row in connection.execute(
                    f"""SELECT DISTINCT sep_cohort.pid FROM {table}
                        JOIN sep_cohort ON {player} = sep_cohort.pid
                        WHERE substr(client_ts, 1, 10) = date(sep_cohort.cday, '+{day} days')"""
                )
            }
        met &= eligible
        if len(eligible) < 2 * MIN_GROUP or not met or len(met) == len(eligible):
            return {
                "available": False,
                "note": f"Too few players to compare: {len(eligible):,} first-time players "
                f"with their day over, {len(met):,} of whom {label}. Pick a wider range.",
            }
        # SDK bookkeeping says nothing about play (sessions have their own fact); attribution
        # arrives whenever; purchases are the outcome when the question is who pays.
        skipped = sorted(
            {*insights.SDK_EVENTS, ATTRIBUTION, *([IAP_EVENT] if outcome == "pays" else [])}
        )
        marks = ",".join("?" * len(skipped))
        labeler = Labeler(storage.get_dictionary(game_id))
        connection.execute("DROP TABLE IF EXISTS temp.sep_early")
        connection.execute(
            f"""CREATE TEMP TABLE sep_early AS
                SELECT sep_cohort.pid AS pid,
                       name || coalesce(' ' || nullif({param("STATE")}, ''), '') AS key,
                       count(*) AS n
                FROM {table} JOIN sep_cohort ON {player} = sep_cohort.pid
                WHERE substr(client_ts, 1, 10) < date(sep_cohort.cday, '+{window_days} days')
                      AND client_ts < sep_cohort.cut AND name NOT IN ({marks})
                GROUP BY pid, key""",
            skipped,
        )
        sessions = {
            row[0]
            for row in connection.execute(
                f"""SELECT sep_cohort.pid FROM {table} JOIN sep_cohort ON {player} = sep_cohort.pid
                    WHERE substr(client_ts, 1, 10) < date(sep_cohort.cday, '+{window_days} days')
                          AND client_ts < sep_cohort.cut
                    GROUP BY sep_cohort.pid HAVING count(DISTINCT {source.session}) >= 2"""
            )
        }
        counts = {}
        for row in connection.execute("SELECT pid, key, n FROM sep_early"):
            if row["pid"] in eligible:
                counts.setdefault(row["key"], {})[row["pid"]] = row["n"]
        stability._device_tables(connection, source, "sep_cohort", "pid")
        attributes = {name: {} for name in CATEGORIES}
        for pid, country, platform, version in connection.execute(
            "SELECT pid, country, platform, app_version FROM sep_cohort"
        ):
            attributes["country"][pid] = country
            attributes["platform"][pid] = platform
            attributes["app_version"][pid] = version
        for row in connection.execute("SELECT pid, tier, ram_band FROM launch_device"):
            attributes["tier"][row["pid"]] = row["tier"]
            attributes["ram_band"][row["pid"]] = row["ram_band"]
        for row in connection.execute("SELECT pid, model, os_version FROM launch_model"):
            attributes["model"][row["pid"]] = row["model"]
            attributes["os_version"][row["pid"]] = row["os_version"]
        for row in connection.execute(
            f"""SELECT {player} AS pid, {param("MEDIA_SOURCE")} AS source, min(client_ts)
                FROM {table} WHERE name=? AND {param("STATE")}='Install'
                      AND {player} IN (SELECT pid FROM sep_cohort) GROUP BY pid""",
            [ATTRIBUTION],
        ):
            attributes["media_source"][row["pid"]] = row["source"]

    features = []
    popular = sorted(counts.items(), key=lambda item: (-len(item[1]), item[0]))[:MAX_KEYS]
    for key, per_player in popular:
        features.append(
            {
                "kind": "event",
                "key": key,
                "label": _event_label(labeler, key, window_days),
                "players": set(per_player),
            }
        )
        values = sorted(per_player.values())
        usual = max(2, values[len(values) // 2])
        repeat = {pid for pid, n in per_player.items() if n >= usual}
        if repeat and len(repeat) != len(per_player):
            features.append(
                {
                    "kind": "event",
                    "key": key,
                    "at_least": usual,
                    "label": _event_label(labeler, key, window_days, usual),
                    "players": repeat,
                }
            )
    features.append(
        {
            "kind": "sessions",
            "label": f"played two or more sessions {_times(window_days)}",
            "players": sessions & eligible,
        }
    )
    for name, phrase in CATEGORIES.items():
        groups = {}
        for pid, value in attributes[name].items():
            if value and value != "unknown" and pid in eligible:
                groups.setdefault(value, set()).add(pid)
        for value, members in groups.items():
            features.append(
                {"kind": name, "value": value, "label": phrase.format(value), "players": members}
            )
    found = compare(features, met, eligible)
    for item in found:
        item["words"] = _words(item, label)
        chip = _chip(item)
        if chip:
            item["chip"] = chip
    more = [item for item in found if item["points"] > 0][:MAX_SHOWN]
    fewer = [item for item in found if item["points"] < 0][:MAX_SHOWN]
    base = len(met) / len(eligible)
    window = _times(window_days)
    if found:
        top = max(found, key=lambda item: abs(item["points"]))
        summary = (
            f"{_pct(base)} of {len(eligible):,} new players {label}. The biggest gap: "
            f"{top['words']}."
        )
    else:
        summary = (
            f"{_pct(base)} of {len(eligible):,} new players {label}. Nothing they did {window} "
            "separates the two groups clearly."
        )
    return {
        "available": True,
        "outcome": outcome,
        "outcome_label": label,
        "window_days": window_days,
        "summary": summary,
        "means": (
            f"Players whose first open is in the range and whose day is over. Outcome: {label}"
            + (
                " (any event that day)."
                if outcome != "pays"
                else " (IAP_ANALYSIS Purchased; the purchase and what followed are not compared)."
            )
            + f" Each fact is what the player did {window} or who they are; a fact is listed "
            f"only with at least {MIN_GROUP} players on each side and a gap of at least "
            f"{MIN_POINTS:g} points that holds up under a wide margin (99.9%), because many "
            "facts are tried. This is association, not cause."
        ),
        "players": len(eligible),
        "outcome_players": len(met),
        "rate": round(base, 4),
        "facts_tried": len(features),
        "more_likely": more,
        "less_likely": fewer,
    }
