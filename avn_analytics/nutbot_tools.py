"""NutBot's analysis tools: one player's events and levels, level drill-downs, exits, cohort
comparison and behaviour patterns.

Each is a method of `AnalysisTools`, mixed into NutBot (nutbot.py), which supplies the storage,
the run (who is asking, the dashboard's range and filters) and the range/filter helpers. They
answer from the same queries the pages use, in compact form so a result costs few tokens.
"""

from collections import Counter, defaultdict
from datetime import datetime, timedelta
from itertools import groupby
from statistics import mean, median

from . import insights, journeys, stories
from .models import PlayerRules
from .nutbot_analysis import (
    SDK_NOISE,
    event_counts,
    level_table,
    percentile_rank,
    summarise_player,
)
from .nutbot_base import RANGE_PROPS, ToolError, _tool

LEVEL = {"type": "integer", "minimum": 0, "description": "The level number."}
PLAYER = {"type": "string", "description": "Player ID as returned by the other tools."}
PLAYER_RANGE = {key: RANGE_PROPS[key] for key in ("start", "end")}
CONDITIONS = {
    "type": "array",
    "description": "Players must satisfy all of these (same shape as find_players).",
    "items": {
        "type": "object",
        "properties": {
            "event": {"type": "string"},
            "param": {"type": "string"},
            "op": {
                "type": "string",
                "enum": ["eq", "ne", "gt", "gte", "lt", "lte", "contains", "exists"],
            },
            "value": {"type": "string"},
            "does": {"type": "string", "enum": ["did", "didnt"]},
            "min_times": {"type": "integer", "minimum": 1},
        },
        "required": ["event"],
        "additionalProperties": False,
    },
}
COHORT = {
    "type": "object",
    "properties": {
        "name": {"type": "string", "description": "A short plain name for the group."},
        "conditions": CONDITIONS,
        "search": {"type": "string"},
    },
    "required": ["name"],
    "additionalProperties": False,
}
SAMPLE_PLAYERS = 500
MAX_SEQUENCE_ROWS = 300_000
LEVEL_GROUP_TEXT = {
    "total_drop": "never started any later level",
    "left": "stopped playing after this level",
    "finished_stopped": "finished it, then stopped",
    "kept_going": "went on to later levels",
    "unknown_progress": "progress unknown",
    "stuck": "tried it three or more times without passing",
    "failed": "failed it at least once",
    "failed_left": "failed it and then stopped playing, without passing it or going on",
    "failed_kept_playing": "failed it but kept playing (passed it or went on to a later level)",
    "started": "started it",
    "returning": "came back to it later",
    "missing_history": "no earlier history",
}

ANALYSIS_TOOLS = [
    _tool(
        "get_player_events",
        "One player's raw events counted like the player page's Event Analysis: per event name how many times, in how many sessions, first and last time, and for each parameter its values with counts (or the top values and range when there are many). Pass `event` to look at one event only and `param_filters` to keep events with given parameter values (e.g. level_failed with LEVEL=7). Use it to answer 'how many times did they ...' and 'where did they ...'.",
        {
            "player": PLAYER,
            **PLAYER_RANGE,
            "event": {"type": "string", "description": "Only this event name."},
            "param_filters": {
                "type": "object",
                "description": 'Keep events whose parameters equal these values, written as text: {"LEVEL": "7"}.',
                "additionalProperties": {"type": "string"},
            },
        },
        ["player"],
    ),
    _tool(
        "get_player_levels",
        "One player's levels in play order: starts, completions, fails, restarts, median seconds, first and last time, and whether they passed or got stuck; plus a summary (sessions, active days, highest level reached and passed, their last events).",
        {"player": PLAYER, **PLAYER_RANGE},
        ["player"],
    ),
    _tool(
        "compare_player",
        "Put one player next to the other players active in the same range: where they rank (percentile) on events, sessions and play time, the medians of the group, and the same for players who installed within three days of them. Use it for 'is this player normal?'.",
        {"player": PLAYER, **RANGE_PROPS},
        ["player"],
    ),
    _tool(
        "get_level_detail",
        "One level in depth: its row from the level table with the levels before and after it for context, the size of each group of players (left, finished then stopped, stuck, kept going ...), what the chosen group did last on the level, and a few example players to open with get_player_levels. Use it to answer 'why do players leave at level N?'.",
        {
            **RANGE_PROPS,
            "level": LEVEL,
            "group": {
                "type": "string",
                "enum": list(LEVEL_GROUP_TEXT),
                "description": "Which group's last actions and players to show. Default: left.",
            },
            "scope": {
                "type": "string",
                "enum": ["all", "first_session"],
                "description": "all = everyone active (default); first_session = new players in their first session.",
            },
        },
        ["level"],
    ),
    _tool(
        "get_exits",
        "Where players stop: the levels ranked by the share of their players whose last level event was there, with completion, tries per player, fails and the other events most seen on the level. Levels with too few players are listed apart, not ranked.",
        {**RANGE_PROPS, "limit": {"type": "integer", "minimum": 1, "maximum": 15}},
    ),
    _tool(
        "compare_cohorts",
        "Compare two groups of players, each described with the same conditions find_players takes (e.g. players who never completed level 5 vs those who did): head counts, medians of sessions, events, play time and average session length, and each group's top platforms, countries and versions. Sampled at 500 players per group.",
        {**RANGE_PROPS, "a": COHORT, "b": COHORT},
        ["a", "b"],
    ),
    _tool(
        "get_behaviour",
        "What players do beyond the levels: reach and intensity of every event (share of players who do it, times per player, so over- and under-used features show), the most common two- and three-event sequences, repeated loops (the same event several times in a row), parameter values that dominate an event, and what changed in the last 7 days against the 7 before. Use it to discover behaviour nobody asked about.",
        {**RANGE_PROPS, "limit": {"type": "integer", "minimum": 3, "maximum": 15}},
    ),
]


def _within(value, lo, hi):
    return max(lo, min(hi, value))


class AnalysisTools:
    """Handlers of ANALYSIS_TOOLS; NutBot supplies storage, accounts and the range helpers."""

    # ---- one player

    def _player_events(self, run, game_id, args):
        start, end = self._range(run, args)
        player = str(args["player"])[:128]
        data = insights.journey(self.storage, game_id, player, start, end)
        if not data["events"]:
            raise ToolError("No events for that player in this range. Check the ID and the range.")
        labeler = stories.Labeler(self.storage.get_dictionary(game_id))
        for event in data["events"]:
            info = labeler.level_info(event["name"], event["params"], event.get("app_version"))
            event["verb"] = info[0] if info else None
        return data["events"], data["truncated"]

    def tool_get_player_events(self, run, game_id, args):
        events, truncated = self._player_events(run, game_id, args)
        filters = args.get("param_filters")
        if filters is not None and not isinstance(filters, dict):
            raise ToolError('param_filters is an object like {"LEVEL": 7}.')
        data = event_counts(events, only=args.get("event"), param_filters=filters)
        data["player"] = str(args["player"])
        if truncated:
            data["note"] = (
                "This player has more events than can be read at once; these are the first ones."
            )
        if not data["events"]:
            data["note"] = "No event of this player matches that."
        return data

    def tool_get_player_levels(self, run, game_id, args):
        events, truncated = self._player_events(run, game_id, args)
        levels = level_table(events)
        data = {
            "player": str(args["player"]),
            "summary": summarise_player(events, levels),
            "levels": levels[:80],
        }
        if not levels:
            data["note"] = "This player has no level events in this range."
        if truncated:
            data["note"] = "More events than can be read at once; these are the first ones."
        return data

    def tool_compare_player(self, run, game_id, args):
        events, _ = self._player_events(run, game_id, args)
        player = str(args["player"])
        start, end = self._range(run, args)
        listing = insights.players(
            self.storage,
            game_id,
            start,
            end,
            self._filters(run, args),
            limit=SAMPLE_PLAYERS,
            sort="events",
        )
        rows = listing["players"]
        me = next((row for row in rows if row["player"] == player), None)
        if me is None:
            summary = summarise_player(events, level_table(events))
            me = {
                "events": summary["events"],
                "sessions": summary["sessions"],
                "total_play_seconds": None,
                "first_seen": summary["first_event"],
            }
        first = _moment(me.get("first_seen"))
        near = [
            row
            for row in rows
            if first
            and (other := _moment(row["first_seen"]))
            and abs(other - first) <= timedelta(days=3)
        ]

        def block(group):
            return {
                "players": len(group),
                **{
                    key: {
                        "median": round(median(values), 1) if values else None,
                        "percentile": percentile_rank(me.get(field), values),
                    }
                    for key, field in (
                        ("events", "events"),
                        ("sessions", "sessions"),
                        ("play_seconds", "total_play_seconds"),
                    )
                    for values in [[row[field] for row in group if row.get(field) is not None]]
                },
            }

        return {
            "player": player,
            "them": {
                key: me.get(key)
                for key in ("events", "sessions", "total_play_seconds", "first_seen", "last_seen")
            },
            "all_active_players": block(rows),
            "installed_within_3_days": block(near),
            "sampled": listing["total"] > len(rows),
            "players_in_range": listing["total"],
        }

    # ---- levels and leaving

    def tool_get_level_detail(self, run, game_id, args):
        start, end = self._range(run, args)
        filters, scope = self._filters(run, args), args.get("scope", "all")
        level = int(args["level"])
        group = args.get("group", "left")
        table = journeys.level_progress(self.storage, game_id, start, end, filters, scope)
        rows = {row["level"]: row for row in table["levels"]}
        if level not in rows:
            raise ToolError(
                f"Nobody started level {level} in this range. Levels seen: "
                f"{min(rows, default=None)}–{max(rows, default=None)}."
            )
        numbers = sorted(rows)
        at = numbers.index(level)
        near = [rows[n] for n in numbers[max(0, at - 1) : at + 2]]
        for row in near:
            row["transition"] = _short_transition(row.get("transition"))
        detail = journeys.level_players(
            self.storage, game_id, start, end, filters, level, group, limit=6, scope=scope
        )
        return {
            "level": level,
            "scope": scope,
            "rows": near,
            "groups": {
                name: {"players": count, "means": LEVEL_GROUP_TEXT[name]}
                for name, count in detail["counts"].items()
                if count
            },
            "group": group,
            "group_last_actions": detail["last_actions"],
            "group_example_players": [
                {
                    key: item.get(key)
                    for key in ("player", "tries", "fails", "last_action", "exit_at")
                }
                for item in detail["players"]
            ],
            "context": table["context"],
        }

    def tool_get_exits(self, run, game_id, args):
        start, end = self._range(run, args)
        table = journeys.level_progress(self.storage, game_id, start, end, self._filters(run, args))
        limit = _within(int(args.get("limit") or 8), 1, 15)
        enough = [row for row in table["levels"] if not row["low_sample"] and row["quit"]]
        few = [row for row in table["levels"] if row["low_sample"] and row["quit"]]
        enough.sort(key=lambda row: (-(row["quit_percent"] or 0), -row["quit"]))

        def short(row):
            return {
                key: row[key]
                for key in (
                    "level",
                    "started",
                    "quit",
                    "quit_percent",
                    "completion",
                    "tries_per_player",
                    "fails",
                    "median_seconds",
                    "top_other",
                )
            }

        return {
            "ranked_by": "share of the level's starters whose last level event was there",
            "levels": [short(row) for row in enough[:limit]],
            "too_few_players": [
                {"level": row["level"], "started": row["started"], "quit": row["quit"]}
                for row in few[:limit]
            ],
            "minimum_players": table["context"]["minimum_players"],
            "levels_in_range": len(table["levels"]),
        }

    def tool_compare_cohorts(self, run, game_id, args):
        start, end = self._range(run, args)
        filters = self._filters(run, args)
        result = {}
        for key in ("a", "b"):
            cohort = args.get(key)
            if not isinstance(cohort, dict):
                raise ToolError("a and b describe the two groups.")
            parsed = PlayerRules.model_validate({"conditions": cohort.get("conditions") or []})
            listing = insights.players(
                self.storage,
                game_id,
                start,
                end,
                filters,
                search=str(cohort.get("search") or "")[:128],
                limit=SAMPLE_PLAYERS,
                sort="events",
                conditions=[item.model_dump() for item in parsed.conditions],
            )
            result[key] = _cohort_summary(cohort.get("name") or key.upper(), listing)
        return result

    # ---- behaviour

    def tool_get_behaviour(self, run, game_id, args):
        start, end = self._range(run, args)
        filters = self._filters(run, args)
        limit = _within(int(args.get("limit") or 8), 3, 15)
        self.storage.get_game(game_id)
        with self.storage.connect(self.storage.game_path(game_id)) as connection:
            source = insights.read_source(self.storage, connection)
            condition, values = insights.where(start, end, filters, source=source)
            players = connection.execute(
                f"SELECT count(DISTINCT {source.player}) FROM {source.table} "
                f"WHERE {condition} AND {source.identified}",
                values,
            ).fetchone()[0]
            if not players:
                raise ToolError("No identified players in this range.")
            usage = connection.execute(
                f"""SELECT name, count(*) AS times, count(DISTINCT {source.player}) AS players
                    FROM {source.table} WHERE {condition} AND {source.identified}
                    GROUP BY name""",
                values,
            ).fetchall()
            rows = connection.execute(
                f"""SELECT {source.player} AS player, name, client_ts
                    FROM {source.table} WHERE {condition} AND {source.identified}
                    ORDER BY player, client_ts LIMIT ?""",
                (*values, MAX_SEQUENCE_ROWS),
            ).fetchall()
            recent_from = (
                datetime.fromisoformat(end.replace("Z", "+00:00")) - timedelta(days=7)
            ).strftime("%Y-%m-%dT%H:%M:%SZ")
            earlier_from = (
                datetime.fromisoformat(end.replace("Z", "+00:00")) - timedelta(days=14)
            ).strftime("%Y-%m-%dT%H:%M:%SZ")
            weekly = connection.execute(
                f"""SELECT name,
                           sum(client_ts >= ?) AS recent,
                           sum(client_ts < ? AND client_ts >= ?) AS before
                    FROM {source.table} WHERE {condition} AND client_ts >= ?
                    GROUP BY name""",
                (recent_from, recent_from, earlier_from, *values, earlier_from),
            ).fetchall()
        usable = [row for row in usage if row["name"] not in SDK_NOISE]
        features = sorted(usable, key=lambda row: -row["players"])
        data = {
            "players": players,
            "events": {
                "most_used": [
                    {
                        "event": row["name"],
                        "players_percent": round(100 * row["players"] / players, 1),
                        "times_per_player": round(row["times"] / row["players"], 1),
                    }
                    for row in sorted(usable, key=lambda r: -r["times"] / r["players"])[:limit]
                ],
                "rare_but_present": [
                    {
                        "event": row["name"],
                        "players_percent": round(100 * row["players"] / players, 1),
                        "times": row["times"],
                    }
                    for row in features[::-1]
                    if row["players"] / players < 0.1 and row["times"] >= 5
                ][:limit],
            },
            **_sequences(rows, limit),
            "last_7_days_vs_the_7_before": _movers(weekly, limit),
        }
        data["dominant_parameters"] = self._dominant_params(game_id, start, end, filters, limit)
        if len(rows) >= MAX_SEQUENCE_ROWS:
            data["note"] = (
                f"Sequences use the first {MAX_SEQUENCE_ROWS} events; narrow the range for exact counts."
            )
        return data

    def _dominant_params(self, game_id, start, end, filters, limit):
        """Parameters where one value makes up most of an event's occurrences."""
        with self.storage.connect(self.storage.game_path(game_id)) as connection:
            source = insights.read_source(self.storage, connection)
            condition, values = insights.where(start, end, filters, source=source)
            rows = connection.execute(
                f"""SELECT name, p.key AS key, p.value AS value, count(*) AS times
                    FROM {source.table}, json_each({source.params}) AS p
                    WHERE {condition} AND p.type IN ('text', 'integer', 'real', 'true', 'false')
                    GROUP BY name, p.key, p.value""",
                values,
            ).fetchall()
        groups = defaultdict(list)
        for row in rows:
            if row["name"] not in SDK_NOISE and row["key"] not in insights.HIDDEN_PARAMS:
                groups[(row["name"], row["key"])].append((row["times"], str(row["value"])))
        found = []
        for (name, key), counts in groups.items():
            total = sum(times for times, _ in counts)
            times, value = max(counts)
            if total >= 20 and len(counts) >= 2 and times / total >= 0.7:
                found.append(
                    {
                        "event": name,
                        "param": key,
                        "value": value[:60],
                        "share_percent": round(100 * times / total, 1),
                        "of_times": total,
                    }
                )
        found.sort(key=lambda item: (-item["share_percent"], -item["of_times"]))
        return found[:limit]


def _moment(value):
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def _short_transition(transition):
    if not transition:
        return None
    keep = ("matched_completed", "matched_started", "matched_total")
    return {
        key: value for key, value in transition.items() if key in keep or key.startswith("next")
    } or None


def _cohort_summary(name, listing):
    rows = listing["players"]

    def med(field):
        values = [row[field] for row in rows if row.get(field) is not None]
        return round(median(values), 1) if values else None

    def top(field):
        counts = Counter(str(row[field]) for row in rows if row.get(field))
        return [
            {"value": value, "players": times, "percent": round(100 * times / len(rows), 1)}
            for value, times in counts.most_common(4)
        ]

    return {
        "name": name,
        "players": listing["total"],
        "sampled": listing["total"] > len(rows),
        "median_events": med("events"),
        "median_sessions": med("sessions"),
        "median_play_seconds": med("total_play_seconds"),
        "median_avg_session_seconds": med("avg_session_seconds"),
        "mean_sessions": round(mean(row["sessions"] for row in rows), 1) if rows else None,
        "platforms": top("platform"),
        "countries": top("country"),
        "versions": top("app_version"),
    }


def _sequences(rows, limit):
    """Common event pairs and triples (by players), and one event repeated three or more times."""
    pairs, triples = defaultdict(set), defaultdict(set)
    loops = defaultdict(lambda: [0, set()])
    for player, group in groupby(rows, key=lambda row: row["player"]):
        steps = [
            (name, len(list(same)))
            for name, same in groupby(row["name"] for row in group if row["name"] not in SDK_NOISE)
        ]
        for name, length in steps:
            if length >= 3:
                loops[name][0] += 1
                loops[name][1].add(player)
        names = [name for name, _ in steps]
        for pair in zip(names, names[1:], strict=False):
            pairs[pair].add(player)
        for triple in zip(names, names[1:], names[2:], strict=False):
            triples[triple].add(player)
    return {
        "common_pairs": [
            {"sequence": " → ".join(key), "players": len(who)}
            for key, who in sorted(pairs.items(), key=lambda item: -len(item[1]))[:limit]
        ],
        "common_triples": [
            {"sequence": " → ".join(key), "players": len(who)}
            for key, who in sorted(triples.items(), key=lambda item: -len(item[1]))[:limit]
        ],
        "loops": [
            {"event": name, "runs_of_three_or_more": count, "players": len(who)}
            for name, (count, who) in sorted(loops.items(), key=lambda item: -item[1][0])[:limit]
        ],
    }


def _movers(rows, limit):
    moved = []
    for row in rows:
        if row["name"] in SDK_NOISE or max(row["recent"], row["before"]) < 20:
            continue
        change = (row["recent"] - row["before"]) / row["before"] if row["before"] else None
        if change is None or abs(change) >= 0.3:
            moved.append(
                {
                    "event": row["name"],
                    "last_7_days": row["recent"],
                    "previous_7_days": row["before"],
                    "change_percent": round(100 * change) if change is not None else "new",
                }
            )
    moved.sort(key=lambda item: -abs(item["last_7_days"] - item["previous_7_days"]))
    return moved[:limit]
