"""NutBot's level-attempt, player and query tools (see level_attempts.py, player_tools.py and
counting.py)."""

from . import counting, level_attempts, player_tools
from .nutbot_base import RANGE_PROPS, STEP_SCHEMA, ToolError, _tool
from .segments import SEGMENT_SCHEMA, SegmentedTools

PLAYER_ONLY_RANGE = {key: RANGE_PROPS[key] for key in ("start", "end")}
PLAYER = {
    "type": "string",
    "description": "The player id exactly as other tools show it (find_players, get_player_events).",
}
RANGE_NOTE = "start and end are the days of the level starts."

COUNT_TEST = {
    "type": "object",
    "description": "One parameter test on the event.",
    "properties": {
        "param": {"type": "string", "description": "Parameter name, e.g. STATE or LEVEL_NUMBER."},
        "op": STEP_SCHEMA["properties"]["op"],
        "value": {"type": ["string", "number", "boolean"]},
    },
    "required": ["param"],
    "additionalProperties": False,
}

PLAYER_TOOLS = [
    _tool(
        "get_level_attempts",
        "Every try at one level number, joined by ATTEMPT_ID: how the attempts ended (completed, failed, left, open), completion rate, median and 90th-percentile seconds of completed attempts, median moves left, the share that used a revive or a power-up, ads per attempt, banner revenue and what players chose next (next level, restart, revive, double reward, home, abandoned). Also the most recent attempts as rows (player, try number, result, seconds, moves, revives, power-ups, ads, what they chose next, why they left), newest first, so you can read individual tries; pass an attempt_id to get_player_raw_events to see every event of one. Use it after get_level_progress shows a level stands out. "
        + RANGE_NOTE
        + " Says so when the game sends no attempt ids.",
        {
            **RANGE_PROPS,
            "level": {"type": "integer", "description": "The level number (LEVEL_NUMBER)."},
            "limit": {
                "type": "integer",
                "minimum": 1,
                "maximum": level_attempts.MAX_ROWS,
                "description": "How many recent attempts to list. Default 20.",
            },
            "result": {
                "type": "string",
                "enum": list(level_attempts.RESULTS),
                "description": "List only attempts that ended this way (the summary still covers all).",
            },
            "segment": SEGMENT_SCHEMA,
        },
        required=("level",),
    ),
    _tool(
        "get_level_designs",
        "Level designs (LEVEL_ID) instead of level numbers. The game reuses one design at many level numbers, so the per-level table splits a design across numbers; this pools every try at each design: attempts, players, completion rate, share who left, median seconds of completed attempts, how many level numbers use it (with some of them), and the shares flagged hard or boss. Sort by lowest completion (default), most attempts or slowest. Use it to find designs that are too hard or too easy wherever they appear. "
        + RANGE_NOTE,
        {
            **RANGE_PROPS,
            "sort": {
                "type": "string",
                "enum": list(level_attempts.DESIGN_SORTS),
                "description": "completion_asc (hardest first, default), attempts_desc or seconds_desc.",
            },
            "min_attempts": {
                "type": "integer",
                "minimum": 1,
                "description": "Skip designs with fewer attempts than this. Default 30.",
            },
            "limit": {
                "type": "integer",
                "minimum": 1,
                "maximum": level_attempts.MAX_DESIGNS,
                "description": "How many designs to return. Default 20.",
            },
            "segment": SEGMENT_SCHEMA,
        },
    ),
    _tool(
        "get_player_profile",
        "Who one player is, in a single call: first and last seen, where they came from (media source, campaign, channel, creative, organic or not), their device (tier, RAM, CPU cores, model, OS), their latest saved state (highest level, coin balances, power-up stock, purchased, subscribed, ads removed), what their ads earned (full-screen plus banner, and impressions by format), how their sessions ended (previous exit reasons at launch, levels ended by the app being killed) and a summary of their play (levels, ads, sessions, coins, power-ups). Attribution, device and the saved state look at everything the player ever sent; ad money and exits count only start to end.",
        {**PLAYER_ONLY_RANGE, "player": PLAYER},
        required=("player",),
    ),
    _tool(
        "get_player_raw_events",
        "A player's raw events in the order they happened, each with its time, name and parameters exactly as sent, a page at a time (next_offset gives the next page). Narrow by event name, or by AD_ID or ATTEMPT_ID to follow one ad or one level attempt through everything it sent. Use it to check what really happened once another tool points at a player, an ad or an attempt. Defaults to the dashboard's range; widen start and end to reach older events.",
        {
            **PLAYER_ONLY_RANGE,
            "player": PLAYER,
            "event": {"type": "string", "description": "Only events with this exact name."},
            "ad_id": {"type": "string", "description": "Only events whose AD_ID is this."},
            "attempt_id": {
                "type": "string",
                "description": "Only events whose ATTEMPT_ID is this (a level attempt).",
            },
            "offset": {
                "type": "integer",
                "minimum": 0,
                "description": "Events to skip. Default 0.",
            },
            "limit": {
                "type": "integer",
                "minimum": 1,
                "maximum": player_tools.MAX_EVENTS,
                "description": "Events per page, at most 100 (fewer if they are long). Default 50.",
            },
        },
        required=("player",),
    ),
    _tool(
        "count_events",
        "Count any event, for questions no other tool answers: how many times it was sent, by how many players or in how many sessions, or the sum, average, minimum, maximum, median or 90th percentile of one numeric parameter. Narrow with up to 6 parameter tests (eq, ne, gt, gte, lt, lte, contains, exists) and split by up to 2 of day, country, platform, app_version, build or param:NAME (a parameter's value). Returns each group's value with the events and players it rests on, plus the total. Event and parameter names are exact (list_events shows them; parameters are usually UPPERCASE).",
        {
            **RANGE_PROPS,
            "event": {"type": "string", "description": "Exact event name, e.g. LEVEL_ANALYSIS."},
            "where": {
                "type": "array",
                "items": COUNT_TEST,
                "maxItems": counting.MAX_TESTS,
                "description": 'Parameter tests, all of which must pass, e.g. [{"param": "STATE", "op": "eq", "value": "Failed"}].',
            },
            "metric": {
                "type": "string",
                "enum": list(counting.METRICS),
                "description": "What to report per group. Default count. sum, avg, min, max, median and p90 need param.",
            },
            "param": {
                "type": "string",
                "description": "The numeric parameter for sum, avg, min, max, median and p90. Values that aren't numbers are ignored and counted in `ignored`.",
            },
            "group_by": {
                "type": "array",
                "items": {"type": "string"},
                "maxItems": counting.MAX_GROUPS,
                "description": "Up to 2 of day, country, platform, app_version, build, or param:NAME (e.g. param:LEVEL_ID).",
            },
            "limit": {
                "type": "integer",
                "minimum": 1,
                "maximum": counting.MAX_LIMIT,
                "description": "How many groups to return. Default 50.",
            },
            "order": {
                "type": "string",
                "enum": list(counting.ORDERS),
                "description": "value_desc (default), value_asc, or group (by the group values).",
            },
            "segment": SEGMENT_SCHEMA,
        },
        required=("event",),
    ),
]
PLAYER_LABELS = {
    "get_level_attempts": "Reading a level's attempts",
    "get_level_designs": "Comparing level designs",
    "get_player_profile": "Reading a player's profile",
    "get_player_raw_events": "Reading a player's raw events",
    "count_events": "Counting events",
}
PLAYER_READ_ONLY = tuple(PLAYER_LABELS)


def _need(args, key, words):
    value = args.get(key)
    if value is None or value == "":
        raise ToolError(f"Pass {key}: {words}")
    return value


class PlayerTools(SegmentedTools):
    """Handlers (tool_<name>) of PLAYER_TOOLS; NutBot supplies storage and the range helpers."""

    def tool_get_level_attempts(self, run, game_id, args):
        level = _need(args, "level", "the level number.")
        start, end = self._range(run, args)
        return level_attempts.attempts(
            self.storage,
            game_id,
            start,
            end,
            self._segment_filters(run, args),
            level,
            args.get("limit") or 20,
            args.get("result"),
        )

    def tool_get_level_designs(self, run, game_id, args):
        start, end = self._range(run, args)
        return level_attempts.designs(
            self.storage,
            game_id,
            start,
            end,
            self._segment_filters(run, args),
            args.get("sort"),
            args.get("min_attempts"),
            args.get("limit") or 20,
        )

    def tool_get_player_profile(self, run, game_id, args):
        player = _need(args, "player", "the player id.")
        start, end = self._range(run, args)
        return player_tools.profile(self.storage, game_id, str(player), start, end)

    def tool_get_player_raw_events(self, run, game_id, args):
        player = _need(args, "player", "the player id.")
        start, end = self._range(run, args)
        return player_tools.raw_events(
            self.storage,
            game_id,
            str(player),
            start,
            end,
            args.get("event"),
            args.get("ad_id"),
            args.get("attempt_id"),
            args.get("offset") or 0,
            args.get("limit") or 50,
        )

    def tool_count_events(self, run, game_id, args):
        event = _need(args, "event", "the exact event name.")
        start, end = self._range(run, args)
        return counting.count_events(
            self.storage,
            game_id,
            start,
            end,
            self._segment_filters(run, args),
            event,
            args.get("where"),
            args.get("metric"),
            args.get("param"),
            args.get("group_by"),
            args.get("limit") or 50,
            args.get("order"),
        )
