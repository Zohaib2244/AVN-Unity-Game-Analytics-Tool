"""NutBot's proposals: conditions the assistant builds for the pages, shown as cards the person applies.

A proposal changes nothing by itself. It is validated here with the same models the pages' endpoints
use, then streamed to the browser as a `proposal` event; the person applies it from the card (or it
applies itself when they chose "apply automatically", always with an Undo). Applying writes into the
places the pages already read: the Players rule bar, the funnel draft, the saved highlight rules and
the level table's settings.
"""

from datetime import date

from .models import FunnelDefinition, PlayerRules, SavedHighlight
from .nutbot_base import RANGE_PROPS, STEPS, ToolError, _day, _tool
from .nutbot_tools import CONDITIONS

LEVEL_SORTS = ("level", "drop", "completion", "tries", "time")
OPS = {
    "eq": "is",
    "ne": "is not",
    "gt": "is above",
    "gte": "is at least",
    "lt": "is below",
    "lte": "is at most",
    "contains": "contains",
    "exists": "is present",
    "missing": "is missing",
}
AGGS = {
    "count": "how many times they did it",
    "max": "the highest",
    "min": "the lowest",
    "sum": "the total",
    "first": "when they first did it",
    "last": "when they last did it",
}
WHY = {
    "type": "string",
    "description": "One short sentence for the person: what this shows and why you chose it.",
}
TITLE = {
    "type": "string",
    "description": "A short name for the card button, e.g. 'Stuck at level 7'.",
}
METRICS = {
    "type": "array",
    "description": "Extra columns, at most 3.",
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
            "agg": {"type": "string", "enum": list(AGGS)},
            "of": {"type": "string"},
            "label": {"type": "string"},
        },
        "required": ["event"],
        "additionalProperties": False,
    },
}
HIGHLIGHT_TREE = {
    "type": "object",
    "description": (
        "{match: all|any, conditions: [...]} where each item is a test "
        "{field: 'event'|'param', param, op, value} or another group. Use field 'event' with "
        "value=<event name> to select an event, then param tests to narrow it."
    ),
}

PROPOSAL_TOOLS = [
    _tool(
        "propose_players_view",
        "Build a view of the Players page for the person: rule conditions (who did or never did what), extra columns and a sort. Shown as a card they apply; nothing changes until they do. Check the event and parameter names with list_events first, and test the rule with find_players so you can tell them how many players it matches.",
        {
            "title": TITLE,
            "why": WHY,
            "conditions": CONDITIONS,
            "metrics": METRICS,
            "sort": {
                "type": "string",
                "description": "last_seen (default), events, sessions, playtime, ... or metric0..metric2.",
            },
            "order": {"type": "string", "enum": ["asc", "desc"]},
            **{key: RANGE_PROPS[key] for key in ("start", "end")},
        },
        ["title", "why"],
    ),
    _tool(
        "propose_funnel",
        "Put a funnel in the Funnels page's draft for the person (optionally with its journeys), as a card they apply. Run it with run_funnel first so your answer can say what it shows.",
        {
            "title": TITLE,
            "why": WHY,
            "steps": STEPS,
            "window_hours": {"type": "number"},
            "scope": {"type": "string", "enum": ["player", "session"]},
            "show_journeys": {"type": "boolean"},
            **{key: RANGE_PROPS[key] for key in ("start", "end")},
        },
        ["title", "why", "steps"],
    ),
    _tool(
        "propose_highlight",
        "Propose a highlight rule for player timelines (colours matching events in a player's story, e.g. every failed level 7 or every purchase over 5), as a card that saves it to the game's highlight library when applied.",
        {
            "title": TITLE,
            "why": WHY,
            "name": {"type": "string", "description": "The rule's name, at most 80 characters."},
            "color": {
                "type": "string",
                "enum": ["orange", "cyan", "green", "pink", "violet", "gold"],
            },
            "conditions": HIGHLIGHT_TREE,
        },
        ["title", "why", "name", "conditions"],
    ),
    _tool(
        "propose_level_view",
        "Set up the Levels page: sort, who is counted (everyone or new players in their first session) and the dates. Shown as a card the person applies. Mention the level numbers worth looking at in your answer, since this only sets up the table.",
        {
            "title": TITLE,
            "why": WHY,
            "sort": {
                "type": "string",
                "enum": list(LEVEL_SORTS),
                "description": "drop = biggest drop first.",
            },
            "scope": {"type": "string", "enum": ["all", "first_session"]},
            **{key: RANGE_PROPS[key] for key in ("start", "end")},
        },
        ["title", "why"],
    ),
    _tool(
        "explain_conditions",
        "Turn player rules (conditions and columns) or a highlight tree into plain words, so you can read back what a rule on the page means or check your own before proposing it. Takes the same shapes as find_players / propose_highlight.",
        {"conditions": CONDITIONS, "metrics": METRICS, "highlight": HIGHLIGHT_TREE},
    ),
]


def _test_words(test):
    """One EventTest or group as a sentence."""
    if "conditions" in test:
        joiner = " and " if test.get("match", "all") == "all" else " or "
        return "(" + joiner.join(_test_words(item) for item in test["conditions"]) + ")"
    if test.get("field") == "event":
        return f"the event {OPS.get(test['op'], test['op'])} “{test['value']}”"
    value = "" if test["op"] in ("exists", "missing") else f" “{test['value']}”"
    return f"{test['param']} {OPS.get(test['op'], test['op'])}{value}"


def _rule_words(rule):
    where = ""
    if rule.get("param"):
        value = "" if rule["op"] == "exists" else f" “{rule['value']}”"
        where = f" with {rule['param']} {OPS[rule['op']]}{value}"
    return f"{rule['event']}{where}"


def explain(conditions=(), metrics=(), highlight=None):
    lines = []
    for rule in conditions:
        times = f" at least {rule['min_times']} times" if rule["min_times"] > 1 else ""
        verb = "never did" if rule["does"] == "didnt" else "did"
        lines.append(f"Players who {verb} {_rule_words(rule)}{times}")
    for metric in metrics:
        of = metric.get("of") or metric.get("param")
        target = f" of {of}" if of and metric["agg"] in ("max", "min", "sum") else ""
        lines.append(f"Column: {AGGS[metric['agg']]}{target} on {_rule_words(metric)}")
    if highlight:
        lines.append(f"Highlights events where {_test_words(highlight)}")
    return lines


class ProposalTools:
    """Handlers of PROPOSAL_TOOLS; NutBot supplies the run, the range helper and the audit trail."""

    def _propose(self, run, game_id, kind, args, payload, plain):
        proposal = {
            "type": "proposal",
            "kind": kind,
            "title": str(args["title"])[:80],
            "why": str(args.get("why") or "")[:300],
            "game_id": game_id,
            "payload": payload,
            "plain": plain,
        }
        run.actions.append(proposal)
        return {
            "ok": True,
            "message": "The person now has a card for this. Nothing has changed yet; they apply it. "
            "Explain in your answer what it does and why you chose it.",
            "plain": plain,
        }

    def _dates(self, run, args):
        if not (args.get("start") or args.get("end")):
            return {}
        start = _day(args.get("start"), date.fromisoformat(run.defaults["start"]))
        end = _day(args.get("end"), date.fromisoformat(run.defaults["end"]))
        if end < start:
            raise ToolError("The end date is before the start date.")
        return {"start": start.isoformat(), "end": end.isoformat()}

    def tool_propose_players_view(self, run, game_id, args):
        rules = PlayerRules.model_validate(
            {"conditions": args.get("conditions") or [], "metrics": args.get("metrics") or []}
        )
        sort = str(args.get("sort") or "last_seen")
        if sort.startswith("metric") and not (
            sort[6:].isdigit() and int(sort[6:]) < len(rules.metrics)
        ):
            raise ToolError(f"{sort} needs that many metrics.")
        conditions = [item.model_dump() for item in rules.conditions]
        metrics = [item.model_dump() for item in rules.metrics]
        payload = {
            "conditions": conditions,
            "metrics": metrics,
            "sort": sort,
            "order": "asc" if args.get("order") == "asc" else "desc",
            **self._dates(run, args),
        }
        return self._propose(run, game_id, "players", args, payload, explain(conditions, metrics))

    def tool_propose_funnel(self, run, game_id, args):
        definition = FunnelDefinition.model_validate(
            {
                "steps": args.get("steps") or [],
                "window_hours": args.get("window_hours"),
                "scope": args.get("scope", "player"),
            }
        ).model_dump()
        payload = {
            **definition,
            "show_journeys": bool(args.get("show_journeys")),
            **self._dates(run, args),
        }
        plain = [
            f"Step {number}: {step['label'] or _rule_words(step)}"
            for number, step in enumerate(definition["steps"], 1)
        ]
        return self._propose(run, game_id, "funnel", args, payload, plain)

    def tool_propose_highlight(self, run, game_id, args):
        saved = SavedHighlight.model_validate(
            {
                "name": str(args.get("name") or "")[:80],
                "color": args.get("color", "gold"),
                "conditions": args.get("conditions") or {},
            }
        ).model_dump()
        payload = {
            "name": saved["name"],
            "color": saved["color"],
            "conditions": saved["conditions"],
        }
        return self._propose(
            run, game_id, "highlight", args, payload, explain(highlight=saved["conditions"])
        )

    def tool_propose_level_view(self, run, game_id, args):
        sort = args.get("sort", "level")
        scope = args.get("scope", "all")
        if sort not in LEVEL_SORTS or scope not in ("all", "first_session"):
            raise ToolError(
                "sort is one of level, drop, completion, tries, time; scope all or first_session."
            )
        payload = {"sort": sort, "scope": scope, **self._dates(run, args)}
        plain = [
            f"Sorted by {sort}",
            "New players in their first session" if scope == "first_session" else "Everyone active",
        ]
        return self._propose(run, game_id, "levels", args, payload, plain)

    def tool_explain_conditions(self, run, game_id, args):
        rules = PlayerRules.model_validate(
            {"conditions": args.get("conditions") or [], "metrics": args.get("metrics") or []}
        )
        highlight = None
        if args.get("highlight"):
            highlight = SavedHighlight.model_validate(
                {"name": "x", "conditions": args["highlight"]}
            ).model_dump()["conditions"]
        lines = explain(
            [item.model_dump() for item in rules.conditions],
            [item.model_dump() for item in rules.metrics],
            highlight,
        )
        return {"plain": lines or ["Nothing to explain: no conditions given."]}
