"""NutBot's tools for comparing player groups and the game's saved groups and checks.

compare_player_groups runs the same analysis as Levels → Compare player groups
(player_groups.compare): first-observed players are split by an early behaviour (time to finish a
level, how often they saw an event, a recorded parameter) and the groups' later outcomes are
compared with uncertainty. list_saved_groups reads the game's library of saved groups and checks.
propose_player_groups hands the person a card that opens the comparison there, or saves it to the
library, once they press Apply.
"""

from datetime import date, timedelta

from . import group_library, player_groups
from .models import PlayerGroupsQuery, SavedPlayerGroup
from .nutbot_base import RANGE_PROPS, STEP_SCHEMA, ToolError, _tool
from .nutbot_proposals import TITLE, WHY

BEHAVIOR = {
    "type": "object",
    "description": (
        "The early behaviour that splits players into group A and B. kind: level_duration (time "
        "from a level's first start to its first completion, in seconds; needs level and split), "
        "event_count (times they did `event` in the first window_minutes; needs event and split), "
        "parameter (the first value of `parameter` on `event` in the first window_minutes; needs "
        "event, parameter and either comparison=number with split, or comparison=equals with "
        "value). Group A is at or below the split (or equals the value); B is above it."
    ),
    "properties": {
        "kind": {"type": "string", "enum": ["level_duration", "event_count", "parameter"]},
        "level": {"type": "integer", "minimum": 0},
        "event": STEP_SCHEMA,
        "parameter": {"type": "string"},
        "window_minutes": {"type": "number"},
        "comparison": {"type": "string", "enum": ["number", "equals"]},
        "split": {"type": "number"},
        "value": {"type": "string"},
    },
    "required": ["kind"],
    "additionalProperties": False,
}
OUTCOME = {
    "type": "object",
    "description": (
        "What later happens, within window_hours of the player's first event: kind level (they "
        "start or restart `level`) or event (they do `event`)."
    ),
    "properties": {
        "kind": {"type": "string", "enum": ["level", "event"]},
        "level": {"type": "integer", "minimum": 0},
        "event": STEP_SCHEMA,
        "window_hours": {"type": "number"},
    },
    "required": ["kind"],
    "additionalProperties": False,
}
POPULATION = {
    **{key: RANGE_PROPS[key] for key in ("start", "end", "filters", "include_test_data")},
    "entry_level": {
        "type": "integer",
        "minimum": 0,
        "description": "Players whose first recorded progression starts this level (default 1).",
    },
    "exclude_players": {"type": "array", "items": {"type": "string"}},
    "exclude_events": {
        "type": "array",
        "description": "Leave out players who did one of these events before the entry level.",
        "items": STEP_SCHEMA,
    },
    "behavior": BEHAVIOR,
}

GROUP_TOOLS = [
    _tool(
        "compare_player_groups",
        "Compare two groups of NEW players split by an early behaviour, and whether each group later reaches an outcome (for example: players who took 70 seconds or less to finish level 1 against slower ones, and who then started level 4 within 24 hours). Dates select players first observed in them; the result shows each group's reached/total, percentage, 95% interval, the A-minus-B difference with its interval, players still being observed, exclusions and missing data. It shows association, not cause: say so. Check list_events for exact event names, and get_context for the latest and previous published build.",
        {**POPULATION, "outcome": OUTCOME},
        ["behavior", "outcome"],
    ),
    _tool(
        "list_saved_groups",
        "The game's saved player groups and named checks (Levels → Compare player groups → My checks), in short. Use them instead of rebuilding a comparison the team already saved.",
        {},
    ),
    _tool(
        "propose_player_groups",
        "Give the person a card for a player-group comparison. Applying it opens Levels → Compare player groups with the comparison filled in and run; with save=true it is also saved to the game's library under `name` (a check when you give an outcome, a group otherwise). Run compare_player_groups first so you can say what it shows.",
        {
            **POPULATION,
            "outcome": OUTCOME,
            "title": TITLE,
            "why": WHY,
            "save": {"type": "boolean", "description": "Also keep it in the game's library."},
            "name": {"type": "string", "description": "Library name, at most 80 characters."},
        },
        ["title", "why", "behavior"],
    ),
]


def _rule(value):
    return (
        None
        if not value
        else {key: value.get(key, "") for key in ("event", "param", "op", "value")}
    )


class GroupTools:
    """Handlers of GROUP_TOOLS; NutBot supplies storage and the range and filter helpers."""

    def _group_population(self, run, args):
        start, end = self._range(run, args)
        behavior = dict(args.get("behavior") or {})
        for key in ("event",):
            if behavior.get(key):
                behavior[key] = _rule(behavior[key])
        exclusions = [_rule(item) for item in args.get("exclude_events") or []]
        return {
            "start": start[:10],
            "end": (date.fromisoformat(end[:10]) - timedelta(days=1)).isoformat(),
            "filters": self._filters(run, args),
            "timezone_offset_minutes": 0,
            "entry_level": args.get("entry_level", 1),
            "exclude_players": [str(item)[:128] for item in args.get("exclude_players") or []],
            "exclude_events": exclusions,
            "behavior": behavior,
        }

    def _group_outcome(self, args):
        outcome = dict(args.get("outcome") or {})
        if outcome.get("event"):
            outcome["event"] = _rule(outcome["event"])
        return outcome

    def tool_compare_player_groups(self, run, game_id, args):
        body = PlayerGroupsQuery.model_validate(
            {**self._group_population(run, args), "outcome": self._group_outcome(args)}
        )
        start, end = self._range(run, args)
        result = player_groups.compare(
            self.storage, game_id, start, end, body.model_dump(mode="json")
        )
        result.pop("definition", None)
        for group in result["groups"]:
            group["examples"] = group.get("examples", [])[:5]
        return result

    def tool_list_saved_groups(self, run, game_id, args):
        items = []
        for item in group_library.list_items(self.storage, game_id):
            behavior, outcome = item["definition"]["behavior"], item["definition"].get("outcome")
            items.append(
                {
                    "id": item["id"],
                    "name": item["name"],
                    "kind": item["kind"],
                    "behavior": behavior,
                    "outcome": outcome,
                    "entry_level": item["definition"].get("entry_level"),
                    "window_hours": item["definition"].get("window_hours"),
                    "range_preset": item["definition"].get("range_preset"),
                }
            )
        return {"saved": items}

    def tool_propose_player_groups(self, run, game_id, args):
        population = self._group_population(run, args)
        outcome = self._group_outcome(args) if args.get("outcome") else None
        window = float((outcome or {}).get("window_hours") or args.get("window_hours") or 24)
        if outcome is not None:
            outcome.setdefault("window_hours", window)
        name = str(args.get("name") or args.get("title") or "").strip()[:80]
        saved = SavedPlayerGroup.model_validate(
            {
                "name": name or "Player groups",
                "kind": "check" if outcome else "groups",
                "definition": {
                    **population,
                    "window_hours": window,
                    "range_preset": "custom",
                    "version_mode": "custom",
                    "timezone": "utc",
                    "hide_test": bool(run.defaults["hide_test"])
                    and not args.get("include_test_data"),
                    "outcome": outcome,
                },
            }
        ).model_dump(mode="json")
        if args.get("save") and not args.get("name"):
            raise ToolError("Give it a name to save it in the library.")
        behavior = saved["definition"]["behavior"]
        plain = [
            f"New players first seen {population['start']} to {population['end']}",
            f"Split by: {behavior['kind'].replace('_', ' ')}"
            + (f" of level {behavior['level']}" if behavior["kind"] == "level_duration" else "")
            + (f" at {behavior['split']}" if behavior.get("split") is not None else ""),
        ]
        if outcome:
            what = (
                f"level {outcome['level']}"
                if outcome["kind"] == "level"
                else (outcome.get("event") or {}).get("event", "an event")
            )
            plain.append(f"Outcome: reaches {what} within {window:g} hours")
        if args.get("save"):
            plain.append(f"Saved to the library as “{saved['name']}”")
        payload = {"item": saved, "save": bool(args.get("save"))}
        return self._propose(run, game_id, "groups", args, payload, plain)
