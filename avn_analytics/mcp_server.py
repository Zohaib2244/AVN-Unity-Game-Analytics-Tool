"""The read-only MCP server for outside agents (Claude Code, Codex, the Claude app, ...).

NutBot's tools already answer most questions; this serves the ones that only read, to anyone
holding an MCP key (mcp_keys.py). The list below is the whole surface: a tool that is not named
here cannot be called, whatever its name, so a new NutBot tool that changes data stays out until
someone adds it on purpose (tests/test_mcp.py checks that nothing here can write).

A key sees only the games its scope allows; every call also runs with no rights to write, and
the tools' own date and filter defaults are replaced by "the last 30 days, test data hidden".
"""

import copy
import json
import threading
import time
from collections import defaultdict, deque

from . import mcp_protocol
from .nutbot import TOOLS, Run
from .nutbot_extras import EXTRA_READ_ONLY
from .nutbot_playertools import PLAYER_READ_ONLY
from .nutbot_systems import SYSTEM_READ_ONLY

# Everything below only reads. Names that change data or build a card for a page are left out.
READ_ONLY_TOOLS = (
    "list_events",
    "get_overview",
    "run_funnel",
    "get_journeys",
    "list_journey_players",
    "get_player_story",
    "find_players",
    "get_level_progress",
    "get_player_events",
    "get_player_levels",
    "compare_player",
    "get_level_detail",
    "get_exits",
    "compare_cohorts",
    "get_behaviour",
    "get_level_features",
    "get_event_activity",
    "get_sessions",
    "get_retention",
    "compare_segments",
    "get_ad_revenue",
    "get_ad_health",
    "get_ad_serving",
    "get_acquisition",
    "get_ltv",
    "compare_player_groups",
    "list_saved_groups",
    "explain_conditions",
    *SYSTEM_READ_ONLY,
    *PLAYER_READ_ONLY,
    *EXTRA_READ_ONLY,
)
LOCAL_TOOLS = ("list_games",)

INSTRUCTIONS = (
    "Read-only analytics for mobile games. Call list_games first to get game ids, then pass "
    "game_id to every other tool. Dates are YYYY-MM-DD in UTC and default to the last 30 days; "
    "editor and development builds are left out unless include_test_data is true. Results are "
    "kept short, so ask for a narrower range or fewer rows when one is cut."
)

LIST_GAMES = {
    "name": "list_games",
    "description": "The games this key can read: id, name, platform, bundle id and workspace. "
    "Call this first; every other tool takes one of these ids as game_id.",
    "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
}

RANGE_WORDS = {
    "start": "First day, YYYY-MM-DD (UTC). Defaults to 29 days before the end.",
    "end": "Last day (included), YYYY-MM-DD (UTC). Defaults to today.",
    "include_test_data": "Include editor and development builds. Defaults to false.",
}


def external_tool(tool):
    """A NutBot tool as an outside agent should see it: no open game, no dashboard, read-only."""
    tool = copy.deepcopy(tool)
    schema = tool["inputSchema"]
    properties = schema["properties"]
    properties["game_id"] = {
        "type": "string",
        "description": "The game to read. Get ids from list_games.",
    }
    schema["required"] = ["game_id", *[item for item in schema["required"] if item != "game_id"]]
    for key, words in RANGE_WORDS.items():
        if key in properties:
            properties[key]["description"] = words
    tool["annotations"] = {
        "title": tool["name"].replace("_", " ").capitalize(),
        "readOnlyHint": True,
        "destructiveHint": False,
        "openWorldHint": False,
    }
    return tool


class McpServer:
    def __init__(self, settings, accounts, nutbot, keys):
        self.settings = settings
        self.accounts = accounts
        self.nutbot = nutbot
        self.keys = keys
        self._recent = defaultdict(deque)
        self._lock = threading.Lock()
        by_name = {tool["name"]: tool for tool in TOOLS}
        missing = [name for name in READ_ONLY_TOOLS if name not in by_name]
        if missing:
            raise RuntimeError(f"MCP tools that NutBot doesn't have: {', '.join(missing)}")
        list_games = copy.deepcopy(LIST_GAMES)
        list_games["annotations"] = {
            "title": "List games",
            "readOnlyHint": True,
            "destructiveHint": False,
            "openWorldHint": False,
        }
        self.tools = [list_games, *(external_tool(by_name[name]) for name in READ_ONLY_TOOLS)]

    # ---- one JSON-RPC message from someone holding a key

    def handle(self, key, payload):
        return mcp_protocol.handle(
            payload,
            tools=self.tools,
            call=lambda name, arguments: self._call(key, name, arguments),
            name="avn-analytics",
            instructions=INSTRUCTIONS,
        )

    def _within_rate(self, key_id):
        now = time.monotonic()
        with self._lock:
            recent = self._recent[key_id]
            while recent and now - recent[0] > 60:
                recent.popleft()
            if len(recent) >= self.settings.mcp_calls_per_minute:
                return False
            recent.append(now)
        return True

    def _call(self, key, name, arguments):
        if not isinstance(arguments, dict) or name not in (*LOCAL_TOOLS, *READ_ONLY_TOOLS):
            return f"There is no tool called {name}.", True
        if not self._within_rate(key["id"]):
            return "Too many calls this minute. Wait a little and try again.", True
        self.keys.used(key["id"])
        games = self.keys.games(key)
        if name == "list_games":
            return self._list_games(games)
        game_id = str(arguments.get("game_id") or "")
        if not game_id and len(games) == 1:
            game_id = games[0]["id"]
        if not game_id:
            return "Pass game_id. list_games shows the ids you can use.", True
        if game_id not in {game["id"] for game in games}:
            return "You can't look at that game.", True
        run = Run(
            token="mcp",
            principal=self.keys.principal(key),
            game_id=game_id,
            workspace_id=self.accounts.workspace_of_game(game_id),
            can_write=False,
            defaults=self.nutbot._defaults({}),
        )
        return self.nutbot._answer_tool(run, name, {**arguments, "game_id": game_id})

    def _list_games(self, games):
        with self.accounts.storage.connect(self.accounts.registry) as connection:
            names = {
                row["id"]: row["name"]
                for row in connection.execute("SELECT id, name FROM workspaces")
            }
        listed = [
            {
                "id": game["id"],
                "name": game["name"],
                "platform": game["platform"],
                "bundle_id": game["bundle_id"],
                "workspace": names.get(game.get("workspace_id"), ""),
                "archived": bool(game.get("archived_at")),
            }
            for game in games
        ]
        return json.dumps({"games": listed}, ensure_ascii=False), False
