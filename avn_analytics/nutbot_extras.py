"""NutBot's discovery and bookkeeping tools: setup, data health, guide, version comparison, saved items."""

from . import compare, game_setup, group_library, highlights, insights
from .nutbot_base import RANGE_PROPS, ToolError, _tool
from .segments import SegmentedTools

SAVED_KINDS = ("funnels", "groups", "highlights", "reports")
MAX_SAVED = 40
STEP_NAMES = 12

EXTRA_TOOLS = [
    _tool(
        "get_game_setup",
        "What this game sends and what that lets you ask: the events it sent in the range with their STATE values and parameter names, which of the specialised tools (ads, attribution, stability, economy, onboarding, store, level attempts) have data to read for this game, the newest app versions with players and first/last seen, and the player-count thresholds the dashboard uses for 'too small to trust'. Call this right after list_games for a game you haven't looked at.",
        {key: RANGE_PROPS[key] for key in ("start", "end")},
    ),
    _tool(
        "get_data_health",
        "Is the game's data still arriving and complete: when the newest event was received, events and players received per day, how late events arrive (median, p90, share over an hour), events by environment (production, development...), and event names that were sent earlier but have gone quiet in the last two days (a release may have dropped them). Check this first when numbers look wrong.",
        {
            "days": {
                "type": "integer",
                "minimum": 2,
                "maximum": 60,
                "description": "How many days back. Default 14.",
            }
        },
    ),
    _tool(
        "get_analysis_guide",
        "How to read this game's data and report on it: how players, sessions and events work, what to check before concluding, how to report, plus a map of which tool answers which question. `topic` picks a guide: core (default), digest (a periodic summary), exits (why players leave), level-review, player-review, release-check (is a new build healthy). Read core once at the start.",
        {
            "topic": {
                "type": "string",
                "enum": list(game_setup.TOPICS),
                "description": "Default core.",
            }
        },
    ),
    _tool(
        "compare_versions",
        "Two app versions side by side with the same range and filters: players, sessions, new players, events per player, level completion rate and median time to complete a level, ad revenue per active player and ARPDAU, ads load success rate, problem-exit rate (crashes, ANRs, memory kills), and retention. Use it to judge a release: is the new build better or worse. Players on both count in both.",
        {
            **RANGE_PROPS,
            "version_a": {
                "type": "string",
                "description": "The first app version, for example 0.0.8 (usually the older).",
            },
            "version_b": {
                "type": "string",
                "description": "The second app version, for example 0.0.9 (usually the newer).",
            },
        },
        ["version_a", "version_b"],
    ),
    _tool(
        "list_saved",
        "What the team saved for this game: funnels (the steps), player groups and named checks, timeline highlight rules, or NutBot reports (title and headline; read one in full with get_report). Reading only; use a saved funnel's steps with run_funnel.",
        {"kind": {"type": "string", "enum": list(SAVED_KINDS), "description": "What to list."}},
        ["kind"],
    ),
    _tool(
        "get_report",
        "One saved NutBot report in full (title, headline figure, text). Get ids from list_saved with kind reports.",
        {"report_id": {"type": "string"}},
        ["report_id"],
    ),
]
EXTRA_LABELS = {
    "get_game_setup": "Reading what the game sends",
    "get_data_health": "Checking the data feed",
    "get_analysis_guide": "Reading the analysis guide",
    "compare_versions": "Comparing two versions",
    "list_saved": "Reading what the team saved",
    "get_report": "Reading a saved report",
}
EXTRA_READ_ONLY = tuple(tool["name"] for tool in EXTRA_TOOLS)


def _funnel(item):
    steps = item.get("steps") or []
    return {
        "id": item["id"],
        "name": item["name"],
        "steps": [
            step.get("event") if isinstance(step, dict) else str(step)
            for step in steps[:STEP_NAMES]
        ],
        "window_hours": item.get("window_hours"),
        "scope": item.get("scope"),
    }


class ExtraTools(SegmentedTools):
    """Handlers of EXTRA_TOOLS; NutBot supplies storage, reports and the range helpers."""

    def tool_get_game_setup(self, run, game_id, args):
        start, end = self._range(run, args)
        return game_setup.setup(self.storage, game_id, start, end)

    def tool_get_data_health(self, run, game_id, args):
        return game_setup.data_health(self.storage, game_id, args.get("days"))

    def tool_get_analysis_guide(self, run, game_id, args):
        return game_setup.guide(args.get("topic"))

    def tool_compare_versions(self, run, game_id, args):
        start, end = self._range(run, args)
        return compare.versions(
            self.storage,
            game_id,
            start,
            end,
            self._filters(run, args),
            args.get("version_a"),
            args.get("version_b"),
        )

    def tool_list_saved(self, run, game_id, args):
        kind = args.get("kind")
        if kind not in SAVED_KINDS:
            raise ToolError(f"kind is one of: {', '.join(SAVED_KINDS)}.")
        if kind == "funnels":
            items = [_funnel(item) for item in insights.saved_funnels(self.storage, game_id)]
        elif kind == "groups":
            items = group_library.list_items(self.storage, game_id)
        elif kind == "highlights":
            items = highlights.list_rules(self.storage, game_id)
        else:
            items = [
                {key: value for key, value in report.items() if key != "email"}
                for report in self.reports.list(game_id)
            ]
        return {"kind": kind, "total": len(items), "items": items[:MAX_SAVED]}

    def tool_get_report(self, run, game_id, args):
        report = self.reports.get(str(args.get("report_id") or ""), game_id)
        if report is None:
            raise ToolError("That report doesn't exist in this game.")
        return {key: value for key, value in report.items() if key != "email"}
