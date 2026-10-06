"""NutBot: an assistant inside the dashboard that works through a local AI agent CLI.

A chat message starts the CLI (claude, opencode or codex) with this app's own tools attached over
MCP. The CLI gets no shell and no file access (its built-in tools are switched off); it can only
call the tools below, and every tool runs as the person who asked, limited to their games. The
answer streams back to the browser as newline-delimited JSON.

Who may use it is a per-workspace setting (see auth.py); this module checks nothing about roles
except whether the person may write (save funnels, edit labels), which needs a lead or admin.
"""

import asyncio
import glob
import json
import os
import re
import secrets
import time
from collections import Counter, deque
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from uuid import uuid4

from fastapi import HTTPException

from . import insights, journeys
from .exports import period_bounds
from .models import (
    EventDefinition,
    Filters,
    FunnelDefinition,
    FunnelQuery,
    PlayerRules,
    timestamp,
)

MAX_MESSAGE = 4000
MAX_CONTEXT = 3000
MAX_TOOL_CALLS = 40
IDLE_SECONDS = 120  # no output at all from the CLI for this long means it is stuck
MAX_TOOL_RESULT = 14000
MAX_SESSIONS = 2000
RUN_TTL = 900
TEST_ENVIRONMENTS = ["editor", "development", "test", "debug"]
SKILL = Path(__file__).parent / "skill" / "SKILL.md"
DEBUG_FILE = os.environ.get("AVN_NUTBOT_DEBUG_FILE", "")  # development only: raw CLI output
SECRET_PATTERN = re.compile(r"(sk-ant-[A-Za-z0-9_\-]+|eyJ[A-Za-z0-9_\-\.]{20,}|Bearer\s+\S+)")


def _version_key(path):
    return [int(part) if part.isdigit() else 0 for part in re.split(r"(\d+)", path)]


def resolve_binary(spec, fallback_name):
    """A configured path or glob (newest match wins), else whatever is on PATH."""
    if spec:
        matches = sorted(glob.glob(spec), key=_version_key)
        for candidate in reversed(matches):
            if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
                return candidate
        return None
    for folder in os.environ.get("PATH", "").split(os.pathsep):
        candidate = os.path.join(folder, fallback_name)
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


def scrub(text):
    return SECRET_PATTERN.sub("[hidden]", text or "")


# ---------------------------------------------------------------------------- harnesses


@dataclass
class Invocation:
    args: list
    stdin: str | None = None
    env: dict = field(default_factory=dict)


class Harness:
    id = ""
    label = ""
    env_vars = ()
    models = ()

    def __init__(self, settings):
        self.settings = settings

    def binary(self):
        raise NotImplementedError

    def default_model(self):
        raise NotImplementedError

    # A file the CLI's own sign-in leaves in NutBot's home (for example after
    # `docker compose exec admin claude auth login`), relative to that home.
    login_file = ""

    def credentials(self):
        found = {name: os.environ[name] for name in self.env_vars if os.environ.get(name)}
        home = self.settings.nutbot_home
        if not found and self.login_file and (home / self.login_file).is_file():
            found["AVN_LOGIN_FILE"] = self.login_file  # marker only; the CLI reads the file itself
        return found

    def status(self):
        if self.id == "codex" and not self.settings.nutbot_allow_codex:
            return (
                False,
                "Codex can't be limited to this app's tools, so it stays off "
                "unless AVN_NUTBOT_ALLOW_CODEX=true.",
            )
        if not self.binary():
            return False, f"The {self.id} command wasn't found on the server."
        if not self.credentials():
            return False, "No sign-in token is configured for it (see the setup notes)."
        return True, ""

    def describe(self):
        ok, reason = self.status()
        model = self.default_model()
        return {
            "id": self.id,
            "label": self.label,
            "available": ok,
            "reason": reason,
            "default_model": model,
            "models": [model, *[item for item in self.models if item != model]] if model else [],
        }

    def build(self, run, prompt, system, model, session_id, resume):
        raise NotImplementedError

    def parse(self, line, state):
        """One line of the CLI's output -> list of events for the browser."""
        raise NotImplementedError


class ClaudeHarness(Harness):
    id = "claude"
    label = "Claude"
    env_vars = ("CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY")
    login_file = ".claude/.credentials.json"
    models = ("claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-4-5")

    def binary(self):
        return resolve_binary(self.settings.nutbot_claude_bin, "claude")

    def default_model(self):
        return self.settings.nutbot_claude_model

    def build(self, run, prompt, system, model, session_id, resume):
        mcp = {
            "mcpServers": {
                "avn": {
                    "type": "http",
                    "url": f"{self.settings.nutbot_internal_url}/nutbot/mcp",
                    "headers": {"Authorization": f"Bearer {run.token}"},
                }
            }
        }
        args = [
            self.binary(),
            "-p",
            "--output-format",
            "stream-json",
            "--verbose",
            "--include-partial-messages",
            "--model",
            model,
            "--mcp-config",
            json.dumps(mcp),
            "--strict-mcp-config",
            "--tools",
            "",
            "--allowedTools",
            "mcp__avn",
            "--disable-slash-commands",
            "--max-turns",
            "30",
            "--system-prompt",
            system,
            *(["--resume", session_id] if resume else ["--session-id", session_id]),
        ]
        return Invocation(
            args,
            stdin=prompt,
            env={
                **self.credentials(),
                "DISABLE_AUTOUPDATER": "1",
                "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
                "CLAUDE_CODE_ENABLE_TELEMETRY": "0",
            },
        )

    def parse(self, line, state):
        try:
            frame = json.loads(line)
        except ValueError:
            return []
        kind = frame.get("type")
        events = []
        if kind == "system" and frame.get("subtype") == "init":
            events.append({"type": "session", "id": frame.get("session_id")})
        elif kind == "stream_event":
            event = frame.get("event") or {}
            delta = event.get("delta") or {}
            if event.get("type") == "content_block_delta" and delta.get("type") == "text_delta":
                state["streamed"] = True
                events.append({"type": "text", "text": delta.get("text", "")})
        elif kind == "assistant":
            for block in (frame.get("message") or {}).get("content") or []:
                if block.get("type") == "tool_use":
                    events.append(tool_event(block.get("name", ""), block.get("input")))
                elif block.get("type") == "text" and not state.get("streamed"):
                    events.append({"type": "text", "text": block.get("text", "")})
            state["streamed"] = False
        elif kind == "user":
            for block in (frame.get("message") or {}).get("content") or []:
                if isinstance(block, dict) and block.get("type") == "tool_result":
                    events.append({"type": "tool_result", "ok": not block.get("is_error")})
        elif kind == "result":
            state["finished"] = True
            if frame.get("is_error"):
                events.append(
                    {
                        "type": "error",
                        "message": scrub(
                            str(frame.get("result") or "The agent stopped with an error.")
                        ),
                    }
                )
            usage = frame.get("usage") or {}
            events.append(
                {
                    "type": "usage",
                    "input_tokens": usage.get("input_tokens"),
                    "output_tokens": usage.get("output_tokens"),
                    "cache_read_tokens": usage.get("cache_read_input_tokens"),
                    "cost_usd": frame.get("total_cost_usd"),
                    "turns": frame.get("num_turns"),
                }
            )
        return events


class OpenCodeHarness(Harness):
    id = "opencode"
    label = "OpenCode"
    env_vars = (
        "OPENCODE_API_KEY",
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "OPENROUTER_API_KEY",
        "GOOGLE_GENERATIVE_AI_API_KEY",
    )
    login_file = ".local/share/opencode/auth.json"
    models = ("opencode/big-pickle",)

    def binary(self):
        return resolve_binary(self.settings.nutbot_opencode_bin, "opencode")

    def default_model(self):
        return self.settings.nutbot_opencode_model

    def credentials(self):
        found = super().credentials()
        # The free "opencode/…" models need no key.
        return found or (
            {"OPENCODE_FREE": "1"} if self.default_model().startswith("opencode/") else {}
        )

    def build(self, run, prompt, system, model, session_id, resume):
        config = {
            "$schema": "https://opencode.ai/config.json",
            "autoupdate": False,
            "share": "disabled",
            "mcp": {
                "avn": {
                    "type": "remote",
                    "url": f"{self.settings.nutbot_internal_url}/nutbot/mcp",
                    "headers": {"Authorization": f"Bearer {run.token}"},
                    "enabled": True,
                }
            },
            # Only this app's tools: every built-in tool is switched off.
            "tools": {
                name: False
                for name in (
                    "bash",
                    "read",
                    "write",
                    "edit",
                    "patch",
                    "glob",
                    "grep",
                    "list",
                    "webfetch",
                    "websearch",
                    "todowrite",
                    "todoread",
                    "task",
                    "skill",
                    "lsp",
                )
            },
            "permission": {
                "bash": "deny",
                "edit": "deny",
                "webfetch": "deny",
                "external_directory": "deny",
            },
            "instructions": [],
        }
        args = [self.binary(), "run", "--format", "json", "--model", model]
        if resume:
            args += ["--session", session_id]
        # opencode takes the prompt as an argument; the system rules ride along at the top.
        args.append(f"{system}\n\n---\n\n{prompt}")
        return Invocation(
            args,
            env={
                **self.credentials(),
                "OPENCODE_CONFIG_CONTENT": json.dumps(config),
                "OPENCODE_DISABLE_AUTOUPDATE": "1",
            },
        )

    def parse(self, line, state):
        try:
            frame = json.loads(line)
        except ValueError:
            return []
        part = frame.get("part") or {}
        kind = frame.get("type")
        events = []
        if frame.get("sessionID") and not state.get("session"):
            state["session"] = frame["sessionID"]
            events.append({"type": "session", "id": frame["sessionID"]})
        if kind == "text" and part.get("text"):
            events.append({"type": "text", "text": part["text"]})
        elif kind in ("tool_use", "tool"):
            tool = part.get("tool") or part.get("name") or ""
            status = (part.get("state") or {}).get("status")
            if status in (None, "pending", "running"):
                events.append(tool_event(tool, (part.get("state") or {}).get("input")))
            else:
                events.append({"type": "tool_result", "ok": status == "completed"})
        elif kind == "step_finish":
            tokens = part.get("tokens") or {}
            events.append(
                {
                    "type": "usage",
                    "input_tokens": tokens.get("input"),
                    "output_tokens": tokens.get("output"),
                    "cache_read_tokens": (tokens.get("cache") or {}).get("read"),
                    "cost_usd": part.get("cost"),
                    "turns": None,
                }
            )
            if part.get("reason") == "stop":
                state["finished"] = True
        elif kind == "error":
            events.append(
                {"type": "error", "message": scrub(json.dumps(frame.get("error") or frame)[:400])}
            )
        return events


class CodexHarness(Harness):
    id = "codex"
    label = "Codex"
    env_vars = ("OPENAI_API_KEY", "CODEX_API_KEY")
    models = ()

    def binary(self):
        return resolve_binary(self.settings.nutbot_codex_bin, "codex")

    def default_model(self):
        return self.settings.nutbot_codex_model

    def build(self, run, prompt, system, model, session_id, resume):
        url = f"{self.settings.nutbot_internal_url}/nutbot/mcp"
        args = [
            self.binary(),
            "exec",
            "--json",
            "--skip-git-repo-check",
            "--sandbox",
            "read-only",
            "-c",
            f'mcp_servers.avn.url="{url}"',
            "-c",
            'mcp_servers.avn.bearer_token_env_var="AVN_NUTBOT_RUN_TOKEN"',
            *(["-m", model] if model else []),
            "-",
        ]
        return Invocation(
            args,
            stdin=f"{system}\n\n---\n\n{prompt}",
            env={**self.credentials(), "AVN_NUTBOT_RUN_TOKEN": run.token},
        )

    def parse(self, line, state):
        try:
            frame = json.loads(line)
        except ValueError:
            return []
        events = []
        item = frame.get("item") or {}
        kind = frame.get("type")
        if kind == "thread.started" and frame.get("thread_id"):
            events.append({"type": "session", "id": frame["thread_id"]})
        elif kind == "item.completed" and item.get("type") == "agent_message":
            events.append({"type": "text", "text": item.get("text", "")})
        elif kind == "item.started" and item.get("type") == "mcp_tool_call":
            events.append(tool_event(item.get("tool", ""), item.get("arguments")))
        elif kind == "item.completed" and item.get("type") == "mcp_tool_call":
            events.append({"type": "tool_result", "ok": item.get("status") == "completed"})
        elif kind == "turn.completed":
            state["finished"] = True
        elif kind in ("error", "turn.failed"):
            events.append({"type": "error", "message": scrub(json.dumps(frame)[:400])})
        return events


TOOL_LABELS = {
    "get_context": "Looking at the game",
    "list_events": "Listing events",
    "get_overview": "Reading the overview",
    "run_funnel": "Running a funnel",
    "get_journeys": "Following players",
    "list_journey_players": "Finding the players",
    "get_player_story": "Reading a player's story",
    "find_players": "Searching players",
    "get_level_progress": "Checking the levels",
    "save_funnel": "Saving a funnel",
    "set_event_label": "Updating the event dictionary",
    "show_in_dashboard": "Preparing a view",
}


def tool_event(name, arguments):
    short = name.split("__")[-1]
    return {
        "type": "tool",
        "name": short,
        "label": TOOL_LABELS.get(short, short.replace("_", " ").capitalize()),
    }


# ---------------------------------------------------------------------------- tools


def _day(value, fallback):
    if not value:
        return fallback
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError as error:
        raise ToolError(f"“{value}” is not a date; use YYYY-MM-DD.") from error


class ToolError(Exception):
    """A problem the model can read and fix; reported as an error result, not a crash."""


FILTER_SCHEMA = {
    "type": "object",
    "description": "Optional narrowing: lists of values to keep.",
    "properties": {
        key: {"type": "array", "items": {"type": "string"}}
        for key in ("environments", "app_versions", "builds", "countries", "platforms")
    },
    "additionalProperties": False,
}
RANGE_PROPS = {
    "start": {
        "type": "string",
        "description": "First day, YYYY-MM-DD. Defaults to the dashboard's range.",
    },
    "end": {"type": "string", "description": "Last day (included), YYYY-MM-DD."},
    "filters": FILTER_SCHEMA,
    "include_test_data": {
        "type": "boolean",
        "description": "Include editor/development builds. Defaults to what the dashboard shows.",
    },
}
STEP_SCHEMA = {
    "type": "object",
    "properties": {
        "event": {"type": "string", "description": "Exact event name from list_events."},
        "param": {"type": "string", "description": "Optional parameter to test on that event."},
        "op": {
            "type": "string",
            "enum": ["eq", "ne", "gt", "gte", "lt", "lte", "contains", "exists"],
        },
        "value": {"type": "string"},
        "label": {"type": "string", "description": "A short plain-words name for the step."},
    },
    "required": ["event"],
    "additionalProperties": False,
}
STEPS = {"type": "array", "items": STEP_SCHEMA, "minItems": 2, "maxItems": 100}
GAME_ID = {
    "type": "string",
    "description": "Optional: another game you can see. Defaults to the open game.",
}


def _tool(name, description, properties, required=()):
    return {
        "name": name,
        "description": description,
        "inputSchema": {
            "type": "object",
            "properties": {"game_id": GAME_ID, **properties},
            "required": list(required),
            "additionalProperties": False,
        },
    }


TOOLS = [
    _tool(
        "get_context",
        "The open game, its workspace, the dashboard's current date range and filters, the games you can look at, and the event dictionary in short. Call this first.",
        {},
    ),
    _tool(
        "list_events",
        "Every event name in the date range with counts and the parameters each carries (with example values). Use it to find exact names before building a funnel.",
        RANGE_PROPS,
    ),
    _tool(
        "get_overview",
        "Totals for the range: events, players, sessions, new players, a per-day series, and breakdowns by version, country, platform and environment.",
        RANGE_PROPS,
    ),
    _tool(
        "run_funnel",
        "Count players who do the steps in order. Returns, per step, players reached, % of step 1, % of previous, median time from the previous step, and how many stopped there.",
        {
            **RANGE_PROPS,
            "steps": STEPS,
            "window_hours": {
                "type": "number",
                "description": "Later steps must happen within this many hours of step 1.",
            },
            "scope": {
                "type": "string",
                "enum": ["player", "session"],
                "description": "player = across sessions (default); session = within one session.",
            },
            "breakdown": {
                "type": "string",
                "enum": ["environment", "app_version", "build", "country", "platform"],
            },
        },
        ["steps"],
    ),
    _tool(
        "get_journeys",
        "What players did between two funnel steps, in plain words (levels folded into ranges), grouped into the most common journeys, plus where players stopped. steps are the funnel; route_from/route_to pick which two steps to look between (1-based; default first to last).",
        {
            **RANGE_PROPS,
            "steps": STEPS,
            "route_from": {"type": "integer", "minimum": 1},
            "route_to": {"type": "integer", "minimum": 2},
            "span": {
                "type": "string",
                "enum": ["session", "all"],
                "description": "session = only the session they started in (default); all = all sessions.",
            },
            "ignore": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Event names to leave out.",
            },
        },
        ["steps"],
    ),
    _tool(
        "list_journey_players",
        "The players behind one journey or one exit from get_journeys. Pass the same arguments as get_journeys plus target: {steps, status} for a journey (copy both from get_journeys) or {exit} for a stopping point.",
        {
            **RANGE_PROPS,
            "steps": STEPS,
            "route_from": {"type": "integer", "minimum": 1},
            "route_to": {"type": "integer", "minimum": 2},
            "span": {"type": "string", "enum": ["session", "all"]},
            "ignore": {"type": "array", "items": {"type": "string"}},
            "target": {
                "type": "object",
                "properties": {
                    "steps": {"type": "array", "items": {"type": "string"}},
                    "status": {"type": "string", "enum": ["reached", "stopped", "continued"]},
                    "exit": {"type": "string"},
                },
                "additionalProperties": False,
            },
        },
        ["steps", "target"],
    ),
    _tool(
        "get_player_story",
        "One player's sessions as readable lines: what they did, levels played, power-ups used, how long levels took, when they came back.",
        {
            "player": {
                "type": "string",
                "description": "Player ID as returned by the other tools.",
            },
            **{key: RANGE_PROPS[key] for key in ("start", "end")},
        },
        ["player"],
    ),
    _tool(
        "find_players",
        "Players active in the range with sessions, events, version, country, environment. Sort them, keep only players who did (or never did) an event, and add columns computed from events (times they did it, highest/lowest/total of a parameter, first/last time), e.g. the top spenders of a power-up or players who never completed level 3.",
        {
            **RANGE_PROPS,
            "search": {"type": "string"},
            "limit": {"type": "integer", "minimum": 1, "maximum": 25},
            "sort": {
                "type": "string",
                "description": "last_seen (default), first_seen, events, sessions, or metric0..metric2 for one of the columns below.",
            },
            "order": {"type": "string", "enum": ["asc", "desc"]},
            "conditions": {
                "type": "array",
                "description": "Players must satisfy all of these.",
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
            },
            "metrics": {
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
                        "agg": {
                            "type": "string",
                            "enum": ["count", "max", "min", "sum", "first", "last"],
                        },
                        "of": {
                            "type": "string",
                            "description": "Parameter to compare or total (max/min/sum); defaults to param.",
                        },
                    },
                    "required": ["event"],
                    "additionalProperties": False,
                },
            },
        },
    ),
    _tool(
        "get_level_progress",
        "Per level: players started and finished, completion %, tries per player, fails, restarts, median and slowest-10% time, power-ups used, and players whose last level event was there.",
        RANGE_PROPS,
    ),
    _tool(
        "save_funnel",
        "Save a funnel to the game so the team can reopen it. Changes data: tell the user what will be saved, wait for a yes, then call with confirmed=true. Needs a team lead or admin.",
        {
            "name": {"type": "string"},
            "steps": STEPS,
            "window_hours": {"type": "number"},
            "scope": {"type": "string", "enum": ["player", "session"]},
            "confirmed": {"type": "boolean"},
        },
        ["name", "steps", "confirmed"],
    ),
    _tool(
        "set_event_label",
        "Set how an event reads in stories and journeys (and optionally hide it as noise) in the event dictionary. Rules are lines like 'Started => Started level {Started}'. Changes data: ask the user first, then call with confirmed=true. Needs a team lead or admin.",
        {
            "event": {"type": "string"},
            "labels": {
                "type": "string",
                "description": "One rule per line: parameter => text. '*' matches any.",
            },
            "hidden": {"type": "boolean"},
            "description": {
                "type": "string",
                "description": "Required only when the event has no dictionary entry yet.",
            },
            "confirmed": {"type": "boolean"},
        },
        ["event", "confirmed"],
    ),
    _tool(
        "show_in_dashboard",
        "Add a shortcut button that opens something in the dashboard: a funnel, the journeys view, a player's story, the levels table or overview. It is only a shortcut: still write the findings in your answer.",
        {
            "page": {
                "type": "string",
                "enum": ["overview", "funnels", "players", "levels", "dictionary", "exports"],
            },
            "title": {
                "type": "string",
                "description": "Button text, e.g. “Open the level 1–5 funnel”.",
            },
            "funnel": {
                "type": "object",
                "properties": {
                    "steps": STEPS,
                    "window_hours": {"type": "number"},
                    "scope": {"type": "string", "enum": ["player", "session"]},
                },
                "additionalProperties": False,
            },
            "player": {"type": "string"},
            **{key: RANGE_PROPS[key] for key in ("start", "end")},
            "show_journeys": {
                "type": "boolean",
                "description": "On the funnels page, also run the journeys view.",
            },
        },
        ["page", "title"],
    ),
]


@dataclass
class Run:
    token: str
    principal: object
    game_id: str
    workspace_id: str | None
    can_write: bool
    defaults: dict
    created: float = field(default_factory=time.time)
    calls: int = 0
    actions: deque = field(default_factory=deque)


class NutBot:
    def __init__(self, settings, storage, accounts):
        self.settings = settings
        self.storage = storage
        self.accounts = accounts
        self.runs = {}
        self.active = {}
        self.daily = Counter()
        self.harnesses = {
            "claude": ClaudeHarness(settings),
            "opencode": OpenCodeHarness(settings),
            "codex": CodexHarness(settings),
        }
        self._sessions = None

    # ---- harness listing

    def describe(self):
        items = [harness.describe() for harness in self.harnesses.values()]
        return {
            "enabled": self.settings.nutbot_enabled,
            "default": self.settings.nutbot_default_harness,
            "harnesses": items,
        }

    # ---- session ownership: a chat can only be resumed by the person and game it belongs to

    @property
    def _sessions_file(self):
        return self.settings.nutbot_home.parent / "sessions.json"

    def _load_sessions(self):
        if self._sessions is None:
            try:
                self._sessions = json.loads(self._sessions_file.read_text())
            except (OSError, ValueError):
                self._sessions = {}
        return self._sessions

    def _remember_session(self, session_id, email, game_id, harness):
        sessions = self._load_sessions()
        sessions[session_id] = {
            "email": email,
            "game": game_id,
            "harness": harness,
            "at": timestamp(),
        }
        if len(sessions) > MAX_SESSIONS:
            for key in sorted(sessions, key=lambda k: sessions[k]["at"])[
                : len(sessions) - MAX_SESSIONS
            ]:
                sessions.pop(key, None)
        try:
            self._sessions_file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            self._sessions_file.write_text(json.dumps(sessions))
        except OSError:
            pass

    def _owns_session(self, session_id, email, game_id, harness):
        entry = self._load_sessions().get(session_id)
        return bool(
            entry
            and entry["email"] == email
            and entry["game"] == game_id
            and entry["harness"] == harness
        )

    # ---- running a chat turn

    def _admit(self, principal):
        if not self.settings.nutbot_enabled:
            raise HTTPException(404, "NutBot is turned off on this server")
        today = datetime.now(UTC).date().isoformat()
        if self.daily[(principal.email, today)] >= self.settings.nutbot_daily_limit:
            raise HTTPException(429, "You've reached today's NutBot message limit")
        live = self._live()
        if principal.email in live:
            raise HTTPException(429, "NutBot is still answering your last message")
        if len(live) >= 3:
            raise HTTPException(429, "NutBot is busy; try again in a moment")
        return today

    def _live(self):
        """People with an answer in progress. A slot whose stream never started (the browser went
        away first) is dropped once it is older than the longest allowed answer."""
        limit = self.settings.nutbot_run_seconds + 30
        now = time.time()
        for email, (token, since) in list(self.active.items()):
            if token not in self.runs or now - since > limit:
                self.active.pop(email, None)
                self.runs.pop(token, None)
        return dict(self.active)

    def _prune(self):
        now = time.time()
        for token in [t for t, run in self.runs.items() if now - run.created > RUN_TTL]:
            self.runs.pop(token, None)

    def prepare(self, principal, game, workspace_id, body):
        """Check a chat request and set it up; raises HTTP errors before anything streams."""
        message = (body.get("message") or "").strip()
        if not message:
            raise HTTPException(400, "Write a message first")
        if len(message) > MAX_MESSAGE:
            raise HTTPException(400, "That message is too long")
        harness = self.harnesses.get(body.get("harness") or self.settings.nutbot_default_harness)
        if harness is None:
            raise HTTPException(400, "Unknown assistant")
        ok, reason = harness.status()
        if not ok:
            raise HTTPException(409, reason)
        model = (body.get("model") or harness.default_model() or "").strip()
        if model and not re.fullmatch(r"[A-Za-z0-9._:/\-]{1,80}", model):
            raise HTTPException(400, "Unknown model")
        today = self._admit(principal)
        self._prune()
        context = body.get("context") or {}
        defaults = self._defaults(context)
        run = Run(
            token=secrets.token_urlsafe(32),
            principal=principal,
            game_id=game["id"],
            workspace_id=workspace_id,
            can_write=principal.manages_games_in(workspace_id)
            if workspace_id
            else principal.is_admin,
            defaults=defaults,
        )
        session_id = body.get("session_id") or ""
        resume = bool(session_id) and self._owns_session(
            session_id, principal.email, game["id"], harness.id
        )
        if not resume:
            session_id = str(uuid4()) if harness.id == "claude" else ""
        system = self.system_prompt(game, run, context)
        prompt = self.user_prompt(message, context, defaults)
        invocation = harness.build(run, prompt, system, model, session_id, resume)
        self.runs[run.token] = run
        self.active[principal.email] = (run.token, time.time())
        self.daily[(principal.email, today)] += 1
        self.accounts.audit(principal, "nutbot.chat", game["id"], f"{harness.id}/{model}")
        return {
            "run": run,
            "harness": harness,
            "invocation": invocation,
            "session_id": session_id,
            "game_id": game["id"],
        }

    async def stream(self, prep):
        """Yields the events of one answer (dicts); the API layer turns them into NDJSON."""
        run, harness, invocation = prep["run"], prep["harness"], prep["invocation"]
        principal, session_id = run.principal, prep["session_id"]
        home = self.settings.nutbot_home
        work = home / "work"
        work.mkdir(parents=True, exist_ok=True, mode=0o700)
        (home / "tmp").mkdir(exist_ok=True, mode=0o700)
        env = {
            "PATH": "/usr/local/bin:/usr/bin:/bin",
            "HOME": str(home),
            "TMPDIR": str(home / "tmp"),
            "LANG": "C.UTF-8",
            **{k: v for k, v in invocation.env.items() if k != "AVN_LOGIN_FILE"},
        }
        state = {"streamed": False, "finished": False}
        process = None
        started = time.time()
        last_output = started
        sent_session = False
        try:
            process = await asyncio.create_subprocess_exec(
                *invocation.args,
                stdin=asyncio.subprocess.PIPE
                if invocation.stdin is not None
                else asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=str(work),
                env=env,
                limit=4 * 1024 * 1024,
            )
            if invocation.stdin is not None:
                process.stdin.write(invocation.stdin.encode())
                await process.stdin.drain()
                process.stdin.close()
            stderr_task = asyncio.create_task(process.stderr.read(8000))
            while True:
                remaining = self.settings.nutbot_run_seconds - (time.time() - started)
                if remaining <= 0:
                    yield {
                        "type": "error",
                        "message": "That took too long, so I stopped. Try a narrower question.",
                    }
                    break
                try:
                    raw = await asyncio.wait_for(
                        process.stdout.readline(), timeout=min(remaining, 2.0)
                    )
                except TimeoutError:
                    while run.actions:
                        yield run.actions.popleft()
                    if time.time() - last_output > IDLE_SECONDS:
                        yield {
                            "type": "error",
                            "message": "The assistant stopped responding, so I ended this answer. Try again.",
                        }
                        break
                    continue
                last_output = time.time()
                while run.actions:
                    yield run.actions.popleft()
                if not raw:
                    break
                if DEBUG_FILE:
                    with open(DEBUG_FILE, "ab") as debug:
                        debug.write(raw)
                for event in harness.parse(raw.decode("utf-8", "replace").strip(), state):
                    if event["type"] == "session":
                        if event.get("id") and not sent_session:
                            sent_session = True
                            session_id = event["id"]
                            self._remember_session(
                                session_id, principal.email, prep["game_id"], harness.id
                            )
                            yield {"type": "session", "id": session_id}
                        continue
                    yield event
            while run.actions:
                yield run.actions.popleft()
            code = await asyncio.wait_for(process.wait(), timeout=10)
            if code not in (0, None) and not state["finished"]:
                tail = scrub((await stderr_task).decode("utf-8", "replace").strip())[-400:]
                yield {
                    "type": "error",
                    "message": tail or f"The assistant stopped unexpectedly (exit {code}).",
                }
        except FileNotFoundError:
            yield {"type": "error", "message": f"The {harness.id} command could not be started."}
        finally:
            self.runs.pop(run.token, None)
            self.active.pop(principal.email, None)
            if process and process.returncode is None:
                process.kill()
                try:
                    await asyncio.wait_for(process.wait(), timeout=5)
                except TimeoutError:
                    pass
        if session_id and not sent_session:
            self._remember_session(session_id, principal.email, prep["game_id"], harness.id)
            yield {"type": "session", "id": session_id}
        yield {"type": "done", "seconds": round(time.time() - started, 1)}

    # ---- prompts

    def _defaults(self, context):
        today = datetime.now(UTC).date()
        rng = context.get("range") or {}
        try:
            end = date.fromisoformat(str(rng.get("to"))[:10])
            start = date.fromisoformat(str(rng.get("from"))[:10])
        except ValueError:
            end, start = today, today - timedelta(days=29)
        filters = context.get("filters") or {}
        return {
            "start": start.isoformat(),
            "end": end.isoformat(),
            "hide_test": bool(context.get("hide_test", True)),
            "filters": {
                key: [str(v)[:128] for v in (filters.get(key) or [])][:50]
                for key in ("environments", "app_versions", "builds", "countries", "platforms")
            },
        }

    def user_prompt(self, message, context, defaults):
        page = re.sub(r"[^a-z]", "", str(context.get("page") or ""))[:20]
        notes = [
            f"page: {page or 'unknown'}",
            f"dashboard range: {defaults['start']} to {defaults['end']}",
        ]
        notes.append("editor/development data: " + ("hidden" if defaults["hide_test"] else "shown"))
        active = {k: v for k, v in defaults["filters"].items() if v}
        if active:
            notes.append(f"filters: {json.dumps(active)}")
        if context.get("player"):
            notes.append(f"open player: {str(context['player'])[:128]}")
        draft = context.get("funnel")
        if isinstance(draft, dict) and draft.get("steps"):
            notes.append("funnel being edited: " + json.dumps(draft)[:MAX_CONTEXT])
        return f"[{'; '.join(notes)}]\n\n{message}"

    def system_prompt(self, game, run, context):
        definitions = self.storage.get_dictionary(game["id"])
        lines = []
        for name, definition in list(definitions.items())[:80]:
            extra = (
                f" | story rules: {definition['labels'].replace(chr(10), ' ; ')}"
                if definition.get("labels")
                else ""
            )
            hidden = " | hidden from stories" if definition.get("hidden") else ""
            params = ", ".join(definition.get("params", {})) or "no documented parameters"
            lines.append(f"- {name}: {definition['description'][:200]} ({params}){extra}{hidden}")
        try:
            skill = SKILL.read_text(encoding="utf-8")
            skill = skill.split("---", 2)[2].strip() if skill.startswith("---") else skill
        except OSError:
            skill = ""
        role = (
            "a team lead or admin and may save funnels and edit the dictionary"
            if run.can_write
            else "read-only: you may look but not save or edit anything"
        )
        return f"""You are NutBot, the analytics assistant inside AVN Analytics, a self-hosted game analytics dashboard. You help {run.principal.name or run.principal.email} understand how players behave in their games and what to change.

Open game: {game["name"]} ({game["platform"]}, bundle {game["bundle_id"]}). The person is {role}.

How you work
- You can only act through the tools of the "avn" server. You have no shell, files or internet. Never guess numbers: get them from tools, and say when something is unknown or the sample is small.
- Start with get_context unless the question is trivial. Use list_events to find exact event names before building a funnel or journeys. Level starts/completions appear as e.g. "Started level 5": in funnels use the real event and parameter (see the catalog), not the readable label.
- To change data (save_funnel, set_event_label): say exactly what you will change, wait for a clear yes, then call the tool with confirmed=true. Never save things nobody asked for.
- Order of work: call the data tools you need; then WRITE YOUR ANSWER (the findings with their numbers, and what to try next) as normal text; only after that, if something is worth opening (a funnel, a player story, the levels table), call show_in_dashboard as the very last step to add a shortcut button. The button never replaces the written answer, and a reply that is only "I added a button" is wrong.
- Dates are UTC. The dashboard's current range and filters are given at the top of each message; use them unless the user asks otherwise.

Style: plain, friendly and brief, a little dry humour is fine, accuracy comes first. Lead with the answer, then the numbers behind it, then one or two concrete things worth trying. Short paragraphs, small markdown tables or bullet lists are fine. Don't repeat raw JSON.

Event dictionary for this game (written by the team):
{chr(10).join(lines) or "(empty so far)"}

Analysis guide
{skill}"""

    # ---- MCP (the agent CLI calls this)

    def mcp(self, token, payload):
        """Handle one JSON-RPC message. Returns (status, body or None)."""
        run = self.runs.get(token or "")
        if run is None:
            return 401, {"error": "This NutBot session has ended"}
        method, ident = payload.get("method"), payload.get("id")

        def reply(result=None, error=None):
            if error:
                return 200, {
                    "jsonrpc": "2.0",
                    "id": ident,
                    "error": {"code": -32000, "message": error},
                }
            return 200, {"jsonrpc": "2.0", "id": ident, "result": result}

        if method == "initialize":
            asked = (payload.get("params") or {}).get("protocolVersion") or "2025-06-18"
            return reply(
                {
                    "protocolVersion": asked,
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "avn-analytics", "version": "1"},
                }
            )
        if method in ("notifications/initialized", "notifications/cancelled") or (
            method or ""
        ).startswith("notifications/"):
            return 202, None
        if method == "ping":
            return reply({})
        if method == "tools/list":
            return reply({"tools": TOOLS})
        if method == "tools/call":
            params = payload.get("params") or {}
            name, arguments = params.get("name"), params.get("arguments") or {}
            run.calls += 1
            if run.calls > MAX_TOOL_CALLS:
                text, error = "Too many tool calls in one answer. Summarise what you have.", True
            else:
                text, error = self._call(run, name, arguments)
            return reply({"content": [{"type": "text", "text": text}], "isError": error})
        return reply(error=f"Unknown method {method}")

    def _call(self, run, name, arguments):
        handler = getattr(self, f"tool_{name}", None)
        if handler is None or not isinstance(arguments, dict):
            return f"There is no tool called {name}.", True
        try:
            game_id = arguments.get("game_id") or run.game_id
            if game_id != run.game_id and not self.accounts.can_see_game(
                run.principal, str(game_id)
            ):
                raise ToolError("You can't look at that game.")
            result = handler(run, str(game_id), arguments)
            text = json.dumps(result, ensure_ascii=False, default=str)
        except ToolError as error:
            return str(error), True
        except HTTPException as error:
            return str(error.detail), True
        except (KeyError, TypeError, ValueError) as error:
            return f"Bad arguments: {error}", True
        if len(text) > MAX_TOOL_RESULT:
            text = text[:MAX_TOOL_RESULT] + "\n…(cut: ask for a narrower range or fewer rows)"
        return text, False

    # ---- helpers for tools

    def _range(self, run, args):
        start = _day(args.get("start"), date.fromisoformat(run.defaults["start"]))
        end = _day(args.get("end"), date.fromisoformat(run.defaults["end"]))
        if end < start:
            raise ToolError("The end date is before the start date.")
        if (end - start).days > 365:
            raise ToolError("Pick a range of 366 days or fewer.")
        return period_bounds("custom", start, end)

    def _filters(self, run, args):
        given = args.get("filters") or {}
        chosen = {
            key: list(given.get(key, run.defaults["filters"][key]))
            for key in run.defaults["filters"]
        }
        include_test = args.get("include_test_data")
        hide = (not include_test) if include_test is not None else run.defaults["hide_test"]
        exclude = TEST_ENVIRONMENTS if hide and not chosen["environments"] else []
        return Filters(**chosen, exclude_environments=exclude).model_dump()

    def _funnel_query(self, args, run):
        start, end = self._range(run, args)
        raw = {
            "steps": args.get("steps") or [],
            "window_hours": args.get("window_hours"),
            "scope": args.get("scope", "player"),
            "start": start[:10],
            "end": end[:10],
        }
        return start, end, raw

    # ---- the tools

    def tool_get_context(self, run, game_id, args):
        game = self.storage.get_game(game_id)
        definitions = self.storage.get_dictionary(game_id)
        visible = [
            {"id": item["id"], "name": item["name"], "platform": item["platform"]}
            for item in self.accounts.games_in(run.principal, run.workspace_id)
        ]
        start, end = self._range(run, {})
        return {
            "game": {
                k: game[k] for k in ("id", "name", "platform", "bundle_id", "notes") if k in game
            },
            "dashboard": {
                "start": run.defaults["start"],
                "end": run.defaults["end"],
                "hides_editor_and_development": run.defaults["hide_test"],
                "filters": run.defaults["filters"],
            },
            "can_save_and_edit": run.can_write,
            "games_you_can_see": visible,
            "dictionary_events": {
                name: {
                    "description": definition["description"][:160],
                    "labels": definition.get("labels", ""),
                    "hidden": definition.get("hidden", False),
                }
                for name, definition in list(definitions.items())[:60]
            },
            "range_check": {"from": start[:10], "to_exclusive": end[:10]},
        }

    def tool_list_events(self, run, game_id, args):
        start, end = self._range(run, args)
        data = insights.catalog(self.storage, game_id, start, end, self._filters(run, args))
        for event in data["events"]:
            for param in event["params"]:
                param["values"] = param["values"][:8]
            event["params"] = event["params"][:10]
        return data

    def tool_get_overview(self, run, game_id, args):
        start, end = self._range(run, args)
        return insights.summary(self.storage, game_id, start, end, self._filters(run, args))

    def tool_run_funnel(self, run, game_id, args):
        start, end, raw = self._funnel_query(args, run)
        query = FunnelQuery.model_validate(
            {**raw, "breakdown": args.get("breakdown"), "filters": self._filters(run, args)}
        ).model_dump()
        result = insights.funnel(self.storage, game_id, start, end, query)
        for step in result["steps"]:
            step.pop("dropped_sample", None)
            step.pop("time_from_previous", None) if not step.get("time_from_previous") else None
        return result

    def _journey_query(self, run, args):
        from .models import JourneyQuery

        start, end, raw = self._funnel_query(args, run)
        query = JourneyQuery.model_validate(
            {
                **raw,
                "filters": self._filters(run, args),
                "route_from": args.get("route_from", 1),
                "route_to": args.get("route_to"),
                "ignore": args.get("ignore") or [],
                "span": args.get("span", "session"),
            }
        )
        return start, end, query.model_dump()

    def tool_get_journeys(self, run, game_id, args):
        start, end, query = self._journey_query(run, args)
        return journeys.journeys(self.storage, game_id, start, end, query)

    def tool_list_journey_players(self, run, game_id, args):
        from .models import JourneyTarget

        start, end, query = self._journey_query(run, args)
        query["target"] = JourneyTarget.model_validate(args.get("target") or {}).model_dump()
        data = journeys.journey_players(self.storage, game_id, start, end, query)
        data["players"] = data["players"][:25]
        return data

    def tool_get_player_story(self, run, game_id, args):
        start, end = self._range(run, args)
        data = journeys.player_story(self.storage, game_id, str(args["player"])[:128], start, end)
        compact = []
        for chapter in data.pop("chapters"):
            lines = []
            for segment in chapter["segments"][:60]:
                line = {"at": segment["t"][11:19], "text": segment["text"]}
                if segment.get("slowest"):
                    line["slowest_level"] = segment["slowest"]
                if segment.get("extras"):
                    line["also"] = [f"{e['text']} ×{e['count']}" for e in segment["extras"]]
                lines.append(line)
            compact.append(
                {
                    "session": chapter["number"],
                    "started": chapter["start"],
                    "seconds_played": chapter["seconds"],
                    "seconds_since_last_session": chapter["gap"],
                    "lines": lines,
                }
            )
        data["sessions_detail"] = compact
        return data

    def tool_find_players(self, run, game_id, args):
        start, end = self._range(run, args)
        limit = min(int(args.get("limit") or 15), 25)
        parsed = PlayerRules.model_validate(
            {"conditions": args.get("conditions") or [], "metrics": args.get("metrics") or []}
        )
        return insights.players(
            self.storage,
            game_id,
            start,
            end,
            self._filters(run, args),
            search=str(args.get("search") or "")[:128],
            limit=limit,
            sort=str(args.get("sort") or "last_seen"),
            order="asc" if args.get("order") == "asc" else "desc",
            conditions=[item.model_dump() for item in parsed.conditions],
            metrics=[item.model_dump() for item in parsed.metrics],
        )

    def tool_get_level_progress(self, run, game_id, args):
        start, end = self._range(run, args)
        return journeys.level_progress(self.storage, game_id, start, end, self._filters(run, args))

    def _need_write(self, run, args, summary):
        if not run.can_write:
            raise ToolError(
                "This person can look but not change things in this workspace (only team leads and admins can)."
            )
        if args.get("confirmed") is not True:
            return {
                "needs_confirmation": True,
                "message": f"Not done yet. Tell the user exactly this and ask for a yes: {summary} Then call again with confirmed=true.",
            }
        return None

    def tool_save_funnel(self, run, game_id, args):
        from .models import SavedFunnel

        steps = args.get("steps") or []
        pending = self._need_write(
            run, args, f"save a funnel called “{args.get('name')}” with {len(steps)} steps."
        )
        if pending:
            return pending
        saved = SavedFunnel.model_validate(
            {
                "name": str(args.get("name") or "")[:80],
                "steps": steps,
                "window_hours": args.get("window_hours"),
                "scope": args.get("scope", "player"),
            }
        )
        FunnelDefinition.model_validate(saved.model_dump(exclude={"name"}))
        result = insights.save_funnel(self.storage, game_id, None, saved.model_dump())
        self.accounts.audit(run.principal, "nutbot.save_funnel", game_id, saved.name)
        return {"saved": True, "id": result["id"], "name": saved.name}

    def tool_set_event_label(self, run, game_id, args):
        event = str(args.get("event") or "")
        existing = self.storage.get_dictionary(game_id).get(event)
        if existing is None and not args.get("description"):
            raise ToolError("That event has no dictionary entry yet; pass a short description too.")
        change = []
        if args.get("labels") is not None:
            change.append(f"set its story rules to: {args['labels'][:200]}")
        if args.get("hidden") is not None:
            change.append("hide it from stories" if args["hidden"] else "show it in stories")
        pending = self._need_write(
            run,
            args,
            f"update the dictionary entry for {event}: {'; '.join(change) or 'no change'}.",
        )
        if pending:
            return pending
        definition = EventDefinition.model_validate(
            {
                "description": (existing or {}).get("description")
                or str(args.get("description"))[:4000],
                "params": (existing or {}).get("params", {}),
                "labels": args["labels"]
                if args.get("labels") is not None
                else (existing or {}).get("labels", ""),
                "hidden": args["hidden"]
                if args.get("hidden") is not None
                else bool((existing or {}).get("hidden")),
            }
        )
        self.storage.set_definition(game_id, event, definition)
        self.accounts.audit(run.principal, "nutbot.dictionary", game_id, event)
        return {"saved": True, "event": event}

    def tool_show_in_dashboard(self, run, game_id, args):
        action = {
            "type": "action",
            "action": "open",
            "page": args["page"],
            "title": str(args["title"])[:80],
            "game_id": game_id,
        }
        for key in ("player", "start", "end", "show_journeys"):
            if args.get(key) is not None:
                action[key] = args[key]
        if args.get("funnel"):
            FunnelDefinition.model_validate(args["funnel"])
            action["funnel"] = args["funnel"]
        run.actions.append(action)
        return {
            "ok": True,
            "message": "The user now has the button. If you have not yet written out your findings with their numbers, do that now in your reply.",
        }
