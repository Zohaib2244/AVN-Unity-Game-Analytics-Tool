"""NutBot's harness: one Agent Client Protocol (ACP) client for every agent.

Claude, Codex and OpenCode each ship an ACP adapter (`claude-agent-acp`, `codex-acp`, `opencode
acp`): a stdio JSON-RPC process that runs the agent and reports what it does. This module starts
that process for one answer, opens a session with this app's MCP server as the agent's only tool
source, denies every permission the agent asks for that isn't one of those tools, turns the
agent's session updates into the events the browser streams (text, tool, tool_result, context,
usage) and reads the agent's model list from the session's config options.

The adapters keep their own transcript under NutBot's home (`data/nutbot/home`): a chat can be
continued there with `session/load`, and when that fails the chat is rebuilt from this app's own
record (see nutbot_chats.py). Sign-ins also live in that home: `claude auth login`, `codex login`
and `opencode auth login`, run with HOME pointing at it.
"""

import asyncio
import contextlib
import glob
import json
import os
import re
import time
from dataclasses import dataclass, field

from acp import Client, spawn_agent_process, text_block
from acp.schema import (
    AllowedOutcome,
    ClientCapabilities,
    DeniedOutcome,
    HttpHeader,
    HttpMcpServer,
    RequestPermissionResponse,
)

PROTOCOL_VERSION = 1
PROBE_SECONDS = 20  # how long listing an agent's models may take
MODELS_TTL = 3600  # how long a probed model list is kept
START_SECONDS = 60  # starting the adapter and opening the session
AVN_TOOL = re.compile(r"(?:^|[^a-z0-9])avn(?:[^a-z0-9]|$)", re.IGNORECASE)
SECRET_PATTERN = re.compile(r"(sk-ant-[A-Za-z0-9_\-]+|eyJ[A-Za-z0-9_\-\.]{20,}|Bearer\s+\S+)")


def scrub(text):
    return SECRET_PATTERN.sub("[hidden]", text or "")


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


def short_tool_name(title):
    """`mcp__avn__run_funnel`, `mcp.avn.run_funnel`, `avn_run_funnel` -> `run_funnel`."""
    title = title or ""
    for prefix in ("mcp__avn__", "mcp.avn.", "avn__", "avn_", "avn/", "avn."):
        if title.startswith(prefix):
            return title[len(prefix) :]
    return title


def is_avn_tool(title):
    return bool(AVN_TOOL.search(title or "")) and short_tool_name(title) != title


# ---------------------------------------------------------------------------- agents


@dataclass
class Turn:
    """What one answer needs from the harness, and what it collects."""

    token: str  # this run's bearer token for the MCP server
    prompt: str
    system: str
    model: str
    session_id: str | None = None  # the agent's own session to continue, if any
    replay: str = ""  # the earlier chat as text, used when that session can't be continued
    resumed: bool = False
    usage: dict = field(default_factory=dict)
    context: dict = field(default_factory=dict)
    config_options: list = field(default_factory=list)
    error: str = ""
    stop_reason: str = ""


class AgentSpec:
    """How one agent's ACP adapter is started and configured."""

    id = ""
    label = ""
    adapter_name = ""  # the adapter's executable name on PATH
    login_file = ""  # the sign-in the CLI leaves in NutBot's home
    env_vars = ()  # environment variables that also count as a sign-in
    fallback_models = ()

    def __init__(self, settings):
        self.settings = settings

    def adapter(self):
        return resolve_binary(self.adapter_spec(), self.adapter_name)

    def adapter_spec(self):
        return ""

    def command(self):
        binary = self.adapter()
        return [binary] if binary else None

    def default_model(self):
        return ""

    def cheap_model(self):
        return ""

    def credentials(self):
        """Which sign-in the agent will find: a token in the environment or a login file."""
        found = {name: os.environ[name] for name in self.env_vars if os.environ.get(name)}
        home = self.settings.nutbot_home
        if not found and self.login_file and (home / self.login_file).is_file():
            found["AVN_LOGIN_FILE"] = self.login_file  # marker only; the CLI reads the file itself
        return found

    def status(self):
        if not self.adapter():
            return False, f"The {self.adapter_name} adapter wasn't found on the server."
        if not self.credentials() and not self.settings.nutbot_trust_logins:
            return False, "It isn't signed in on the server yet (see the setup notes)."
        return True, ""

    def env(self, home):
        """Environment for the adapter process (merged over the minimal base)."""
        return {k: v for k, v in self.credentials().items() if k != "AVN_LOGIN_FILE"}

    def session_meta(self, turn):
        """`_meta` for session/new: the system prompt, the model and the lock-down."""
        return {}

    def set_model_through_meta(self):
        """Whether the model can only be chosen through `session_meta` (not a config option)."""
        return False

    def instructions_file(self):
        """A file in the work directory the agent reads as instructions, if it has one."""
        return ""


class ClaudeSpec(AgentSpec):
    id = "claude"
    label = "Claude"
    adapter_name = "claude-agent-acp"
    login_file = ".claude/.credentials.json"
    env_vars = ("CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY")
    fallback_models = ("sonnet", "opus", "haiku")

    def adapter_spec(self):
        return self.settings.nutbot_claude_acp

    def default_model(self):
        return self.settings.nutbot_claude_model

    def cheap_model(self):
        return self.settings.nutbot_claude_cheap_model

    def env(self, home):
        env = {
            **super().env(home),
            "DISABLE_AUTOUPDATER": "1",
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
            "CLAUDE_CODE_ENABLE_TELEMETRY": "0",
            "CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION": "false",
        }
        claude = resolve_binary(self.settings.nutbot_claude_bin, "claude")
        if self.settings.nutbot_claude_bin and claude:
            env["CLAUDE_CODE_EXECUTABLE"] = claude
        return env

    def session_meta(self, turn):
        options = {
            # Only this app's tools: no built-ins, nothing from settings files, no slash commands.
            "tools": [],
            "allowedTools": ["mcp__avn__*"],
            "settingSources": [],
            "promptSuggestions": False,
            "maxTurns": 40,
            "extraArgs": {"strict-mcp-config": "", "disable-slash-commands": ""},
        }
        if turn.model:
            options["model"] = turn.model
        return {
            "disableBuiltInTools": True,
            "systemPrompt": turn.system,
            "claudeCode": {"options": options},
        }


class CodexSpec(AgentSpec):
    id = "codex"
    label = "Codex"
    adapter_name = "codex-acp"
    login_file = ".codex/auth.json"
    env_vars = ("CODEX_API_KEY", "OPENAI_API_KEY")
    fallback_models = ()

    def adapter_spec(self):
        return self.settings.nutbot_codex_acp

    def default_model(self):
        return self.settings.nutbot_codex_model

    def cheap_model(self):
        return self.settings.nutbot_codex_cheap_model

    def env(self, home):
        config = {
            # Only this app's tools: the shell, image and web tools are switched off and the
            # sandbox stays read-only. The permission broker refuses anything else anyway.
            "features": {
                "shell_tool": False,
                "unified_exec": False,
                "view_image": False,
                "web_search_request": False,
            },
            "sandbox_mode": "read-only",
            "web_search": "disabled",
            "project_doc_max_bytes": 65536,
        }
        env = {
            **super().env(home),
            "CODEX_HOME": str(home / ".codex"),
            "INITIAL_AGENT_MODE": "read-only",
            "NO_BROWSER": "1",
            "CODEX_CONFIG": json.dumps(config),
        }
        codex = resolve_binary(self.settings.nutbot_codex_bin, "codex")
        if self.settings.nutbot_codex_bin and codex:
            env["CODEX_PATH"] = codex
        return env

    def instructions_file(self):
        return "AGENTS.md"


class OpenCodeSpec(AgentSpec):
    id = "opencode"
    label = "OpenCode"
    adapter_name = "opencode"
    login_file = ".local/share/opencode/auth.json"
    env_vars = (
        "OPENCODE_API_KEY",
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "OPENROUTER_API_KEY",
        "GOOGLE_GENERATIVE_AI_API_KEY",
    )
    fallback_models = ()

    def adapter_spec(self):
        return self.settings.nutbot_opencode_bin

    def command(self):
        binary = self.adapter()
        return [binary, "acp"] if binary else None

    def default_model(self):
        return self.settings.nutbot_opencode_model

    def cheap_model(self):
        return self.settings.nutbot_opencode_cheap_model

    def credentials(self):
        found = super().credentials()
        # The free "opencode/…" models need no key.
        return found or (
            {"OPENCODE_FREE": "1"} if self.default_model().startswith("opencode/") else {}
        )

    def set_model_through_meta(self):
        return True

    def env(self, home):
        config = {
            "$schema": "https://opencode.ai/config.json",
            "autoupdate": False,
            "share": "disabled",
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
        }
        return {
            **super().env(home),
            "OPENCODE_CONFIG_CONTENT": json.dumps(config),
            "OPENCODE_DISABLE_AUTOUPDATE": "1",
        }

    def instructions_file(self):
        return "AGENTS.md"

    def session_meta(self, turn):
        return {"model": turn.model} if turn.model else {}


# ---------------------------------------------------------------------------- the client


class TurnClient(Client):
    """The ACP client of one answer: permissions, and session updates -> browser events."""

    def __init__(self, turn, events, log):
        self.turn = turn
        self.events = events  # asyncio.Queue of dicts for the browser
        self.log = log  # list of (tool title, raw input, raw output, status) for the trace
        self.titles = {}
        self.open_tools = {}
        self.replaying = False

    def emit(self, event):
        if not self.replaying:
            self.events.put_nowait(event)

    async def request_permission(self, session_id, tool_call, options, **kwargs):
        call_id = getattr(tool_call, "tool_call_id", "") or ""
        title = getattr(tool_call, "title", None) or self.titles.get(call_id, "")
        if is_avn_tool(title):
            for kind in ("allow_always", "allow_session", "allow_once"):
                chosen = next((o for o in options if o.kind == kind), None)
                if chosen:
                    return RequestPermissionResponse(
                        outcome=AllowedOutcome(option_id=chosen.option_id, outcome="selected")
                    )
        self.log.append({"tool": title or call_id, "denied": True})
        for kind in ("reject_always", "reject_session", "reject_once"):
            chosen = next((o for o in options if o.kind == kind), None)
            if chosen:
                return RequestPermissionResponse(
                    outcome=AllowedOutcome(option_id=chosen.option_id, outcome="selected")
                )
        return RequestPermissionResponse(outcome=DeniedOutcome(outcome="cancelled"))

    async def session_update(self, session_id, update, **kwargs):
        kind = getattr(update, "session_update", "")
        if kind == "agent_message_chunk":
            text = getattr(update.content, "text", None)
            if text:
                self.emit({"type": "text", "text": text})
        elif kind == "tool_call":
            title = update.title or ""
            self.titles[update.tool_call_id] = title
            entry = {
                "tool": short_tool_name(title),
                "input": _compact(update.raw_input),
                "started": time.time(),
            }
            self.open_tools[update.tool_call_id] = entry
            self.log.append(entry)
            self.emit({"type": "tool", "id": update.tool_call_id, "name": short_tool_name(title)})
            if update.status in ("completed", "failed"):
                self._finish(update.tool_call_id, update)
        elif kind == "tool_call_update":
            if update.title:
                self.titles[update.tool_call_id] = update.title
            entry = self.open_tools.get(update.tool_call_id)
            if entry is not None and update.raw_input is not None and not entry.get("input"):
                entry["input"] = _compact(update.raw_input)
            if update.status in ("completed", "failed"):
                self._finish(update.tool_call_id, update)
        elif kind == "usage_update":
            cost = getattr(update, "cost", None)
            self.turn.context = {
                "used": update.used,
                "size": update.size,
                "cost_usd": getattr(cost, "amount", None) if cost else None,
            }
            self.emit({"type": "context", **self.turn.context})
        elif kind == "config_option_update":
            self.turn.config_options = _options(update.config_options)

    def _finish(self, call_id, update):
        entry = self.open_tools.pop(call_id, None)
        ok = update.status == "completed"
        if entry is not None:
            entry["ok"] = ok
            entry["ms"] = int((time.time() - entry.pop("started", time.time())) * 1000)
            if update.raw_output is not None:
                entry["output"] = _compact(update.raw_output, 2000)
        self.emit({"type": "tool_result", "id": call_id, "ok": ok})

    # No file, terminal or elicitation capability is advertised, so the agent never calls these.
    async def read_text_file(self, *args, **kwargs):
        raise RuntimeError("NutBot has no file access")

    async def write_text_file(self, *args, **kwargs):
        raise RuntimeError("NutBot has no file access")

    async def create_terminal(self, *args, **kwargs):
        raise RuntimeError("NutBot has no terminal")

    async def terminal_output(self, *args, **kwargs):
        raise RuntimeError("NutBot has no terminal")

    async def release_terminal(self, *args, **kwargs):
        raise RuntimeError("NutBot has no terminal")

    async def wait_for_terminal_exit(self, *args, **kwargs):
        raise RuntimeError("NutBot has no terminal")

    async def kill_terminal(self, *args, **kwargs):
        raise RuntimeError("NutBot has no terminal")

    async def create_elicitation(self, *args, **kwargs):
        raise RuntimeError("NutBot cannot ask questions this way")

    async def complete_elicitation(self, *args, **kwargs):
        pass

    async def ext_method(self, method, params):
        return {}

    async def ext_notification(self, method, params):
        pass

    def on_connect(self, conn):
        pass


def _compact(value, limit=600):
    if value is None:
        return None
    try:
        text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    except (TypeError, ValueError):
        text = str(value)
    return scrub(text[:limit])


def _options(config_options):
    """The session's select options as plain dicts: id, category, current, values."""
    items = []
    for option in config_options or []:
        values = []
        for choice in getattr(option, "options", None) or []:
            if hasattr(choice, "value"):
                values.append({"value": choice.value, "name": choice.name or choice.value})
            else:  # a group of options
                for inner in getattr(choice, "options", None) or []:
                    values.append({"value": inner.value, "name": inner.name or inner.value})
        items.append(
            {
                "id": option.id,
                "name": option.name,
                "category": getattr(option, "category", None),
                "current": getattr(option, "current_value", None),
                "values": values,
            }
        )
    return items


def models_from_options(options):
    return [v["value"] for o in options for v in o["values"] if o.get("category") == "model"]


# ---------------------------------------------------------------------------- the harness


class AcpHarness:
    """Starts an agent's ACP adapter for one answer and streams what it does."""

    def __init__(self, settings):
        self.settings = settings
        self.specs = {
            spec.id: spec
            for spec in (ClaudeSpec(settings), CodexSpec(settings), OpenCodeSpec(settings))
        }
        self.probed = {}  # harness id -> {"at", "options", "models", "error"}
        self.instructions_written = {}

    # ---- listing

    def describe(self, spec):
        ok, reason = spec.status()
        probe = self.probed.get(spec.id) or {}
        models = probe.get("models") or list(spec.fallback_models)
        default = spec.default_model()
        if default and default not in models:
            models = [default, *models]
        return {
            "id": spec.id,
            "label": spec.label,
            "available": ok,
            "reason": reason,
            "default_model": default or (models[0] if models else None),
            "cheap_model": spec.cheap_model() or None,
            "models": models if ok else [],
            "models_from": "agent" if probe.get("models") else "fallback",
            "probe_error": probe.get("error", ""),
        }

    def stale(self, spec):
        probe = self.probed.get(spec.id)
        return not probe or time.time() - probe["at"] > MODELS_TTL

    async def probe(self, spec):
        """Ask the agent which models and settings it offers (a session with no prompt)."""
        if not spec.status()[0]:
            return
        result = {"at": time.time(), "options": [], "models": [], "error": ""}
        try:
            async with asyncio.timeout(PROBE_SECONDS):
                options = await self._probe(spec)
            result["options"] = options
            result["models"] = models_from_options(options)
        except Exception as error:  # noqa: BLE001 - the agent is outside our control
            result["error"] = scrub(str(error))[:300]
        self.probed[spec.id] = result

    async def _probe(self, spec):
        home, work = self._dirs(spec)
        client = TurnClient(Turn(token="", prompt="", system="", model=""), asyncio.Queue(), [])
        async with spawn_agent_process(
            client, *spec.command(), env=self._env(spec, home), cwd=str(work)
        ) as (conn, process):
            await conn.initialize(
                protocol_version=PROTOCOL_VERSION, client_capabilities=ClientCapabilities()
            )
            session = await conn.new_session(cwd=str(work), mcp_servers=[])
            options = _options(session.config_options)
            with contextlib.suppress(Exception):
                await conn.close_session(session_id=session.session_id)
            process.terminate()
            return options

    # ---- a turn

    async def run(self, spec, turn, events, log):
        """Run one answer. Events for the browser go to `events`; the turn keeps the totals.

        Ends by putting None on the queue. Never raises: problems become `turn.error`.
        """
        home, work = self._dirs(spec)
        self._write_instructions(spec, work, turn.system)
        client = TurnClient(turn, events, log)
        process = None
        try:
            async with spawn_agent_process(
                client, *spec.command(), env=self._env(spec, home), cwd=str(work)
            ) as (conn, process):
                async with asyncio.timeout(START_SECONDS):
                    init = await conn.initialize(
                        protocol_version=PROTOCOL_VERSION, client_capabilities=ClientCapabilities()
                    )
                    if (
                        init.auth_methods
                        and not spec.credentials()
                        and not self.settings.nutbot_trust_logins
                    ):
                        turn.error = f"{spec.label} isn't signed in on the server."
                        return
                    session_id = await self._open(conn, spec, turn, work, client)
                    await self._choose_model(conn, spec, turn, session_id)
                prompt = turn.prompt
                if turn.replay and not turn.resumed:
                    prompt = f"{turn.replay}\n\n---\n\n{turn.prompt}"
                response = await conn.prompt(session_id=session_id, prompt=[text_block(prompt)])
                turn.stop_reason = response.stop_reason or ""
                turn.usage = _usage(response)
                if turn.config_options:
                    probe = self.probed.setdefault(
                        spec.id, {"at": time.time(), "options": [], "models": [], "error": ""}
                    )
                    probe.update(
                        at=time.time(),
                        options=turn.config_options,
                        models=models_from_options(turn.config_options),
                    )
                with contextlib.suppress(Exception):
                    async with asyncio.timeout(5):
                        await conn.close_session(session_id=session_id)
        except asyncio.CancelledError:
            turn.error = "Stopped."
            raise
        except FileNotFoundError:
            turn.error = f"The {spec.adapter_name} adapter could not be started."
        except TimeoutError:
            turn.error = f"{spec.label} took too long to start."
        except Exception as error:  # noqa: BLE001 - anything the adapter does wrong
            turn.error = _explain(error)
        finally:
            if process is not None and process.returncode is None:
                with contextlib.suppress(ProcessLookupError):
                    process.kill()
            events.put_nowait(None)

    async def _open(self, conn, spec, turn, work, client):
        servers = [
            HttpMcpServer(
                type="http",
                name="avn",
                url=f"{self.settings.nutbot_internal_url}/nutbot/mcp",
                headers=[HttpHeader(name="Authorization", value=f"Bearer {turn.token}")],
            )
        ]
        meta = spec.session_meta(turn)
        if turn.session_id:
            client.replaying = True  # a load replays the old messages; the browser has them
            try:
                loaded = await conn.load_session(
                    cwd=str(work), session_id=turn.session_id, mcp_servers=servers, **meta
                )
                turn.resumed = True
                turn.config_options = _options(getattr(loaded, "config_options", None))
                return turn.session_id
            except Exception:  # noqa: BLE001 - the transcript is gone or the adapter can't
                turn.resumed = False
            finally:
                client.replaying = False
        session = await conn.new_session(cwd=str(work), mcp_servers=servers, **meta)
        turn.session_id = session.session_id
        turn.config_options = _options(session.config_options)
        return session.session_id

    async def _choose_model(self, conn, spec, turn, session_id):
        if not turn.model or spec.set_model_through_meta():
            return
        for option in turn.config_options:
            if option.get("category") != "model":
                continue
            if option["current"] == turn.model:
                return
            if any(v["value"] == turn.model for v in option["values"]):
                response = await conn.set_config_option(
                    config_id=option["id"], session_id=session_id, value=turn.model
                )
                turn.config_options = _options(getattr(response, "config_options", None))
            return

    # ---- helpers

    def _dirs(self, spec):
        home = self.settings.nutbot_home
        home.mkdir(parents=True, exist_ok=True, mode=0o700)
        work = self.settings.nutbot_dir / "work" / spec.id
        work.mkdir(parents=True, exist_ok=True, mode=0o700)
        (self.settings.nutbot_dir / "tmp").mkdir(parents=True, exist_ok=True, mode=0o700)
        return home, work

    def _env(self, spec, home):
        return {
            "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
            "HOME": str(home),
            "TMPDIR": str(self.settings.nutbot_dir / "tmp"),
            "LANG": "C.UTF-8",
            "NO_COLOR": "1",
            **spec.env(home),
        }

    def _write_instructions(self, spec, work, system):
        """Agents without a system-prompt setting read AGENTS.md from the work directory."""
        name = spec.instructions_file()
        if not name:
            return
        if self.instructions_written.get(spec.id) == system:
            return
        (work / name).write_text(system, encoding="utf-8")
        self.instructions_written[spec.id] = system


def _usage(response):
    usage = getattr(response, "usage", None)
    meta = getattr(response, "field_meta", None) or {}
    quota = (meta.get("quota") or {}).get("token_count") or {}
    return {
        "input_tokens": getattr(usage, "input_tokens", None) or quota.get("inputTokens"),
        "output_tokens": getattr(usage, "output_tokens", None) or quota.get("outputTokens"),
        "cache_read_tokens": getattr(usage, "cached_read_tokens", None)
        or quota.get("cachedInputTokens"),
        "cache_write_tokens": getattr(usage, "cached_write_tokens", None)
        or quota.get("cachedWriteTokens"),
        "total_tokens": getattr(usage, "total_tokens", None) or quota.get("totalTokens"),
    }


def _explain(error):
    text = scrub(str(error) or type(error).__name__)
    data = getattr(error, "data", None)
    if data:
        text = f"{text}: {scrub(json.dumps(data) if not isinstance(data, str) else data)}"
    lowered = text.lower()
    if "auth" in lowered and ("required" in lowered or "login" in lowered):
        return "The agent isn't signed in on the server. An admin needs to sign it in again."
    if "rate" in lowered and "limit" in lowered:
        return "The agent's usage limit is reached for now. Try again later or switch agent."
    return text[:400] or "The agent stopped with an error."
