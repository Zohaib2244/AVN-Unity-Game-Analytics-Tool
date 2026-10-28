"""A stand-in ACP agent for the NutBot tests: speaks the real protocol over stdio.

Writes what it receives to `<this file>.log` (one JSON line per request) so tests can check the
session meta, the environment and the prompts, and behaves on cue words in the prompt:
"please fail" raises during the prompt, "please take long" sleeps, "lose session" makes the next
load_session fail. It asks permission for one of this app's tools and for a shell command, and
records which outcome the client chose for each.
"""

import asyncio
import json
import os
import sys
from uuid import uuid4

from acp import run_agent
from acp.helpers import (
    start_tool_call,
    update_agent_message_text,
    update_tool_call,
)
from acp.schema import (
    AgentCapabilities,
    InitializeResponse,
    LoadSessionResponse,
    McpCapabilities,
    NewSessionResponse,
    PermissionOption,
    PromptResponse,
    SessionConfigOptionSelect,
    SessionConfigSelectOption,
    ToolCallUpdate,
    Usage,
    UsageUpdate,
)

LOG = os.environ.get("FAKE_ACP_LOG") or __file__ + ".log"
LOST = os.environ.get("FAKE_ACP_LOST") or os.path.dirname(__file__) + "/lost-sessions.txt"


def log(kind, **data):
    with open(LOG, "a", encoding="utf-8") as handle:
        handle.write(json.dumps({"kind": kind, **data}, default=str) + "\n")


def options(model, effort="medium"):
    """A model setting, plus an effort setting that only the large model offers."""
    items = [
        SessionConfigOptionSelect(
            type="select",
            id="model",
            name="Model",
            category="model",
            currentValue=model,
            options=[
                SessionConfigSelectOption(value="fake-large", name="Fake large"),
                SessionConfigSelectOption(value="fake-small", name="Fake small"),
            ],
        )
    ]
    if model == "fake-large":
        items.append(
            SessionConfigOptionSelect(
                type="select",
                id="effort",
                name="Effort",
                category="thought_level",
                currentValue=effort,
                options=[
                    SessionConfigSelectOption(value=level, name=level.title())
                    for level in ("low", "medium", "high")
                ],
            )
        )
    return items


class FakeAgent:
    def __init__(self):
        self.conn = None
        self.model = "fake-large"
        self.effort = "medium"
        self.prompts = {}

    def on_connect(self, conn):
        self.conn = conn

    async def initialize(self, protocol_version, client_capabilities=None, client_info=None, **kw):
        log(
            "initialize",
            protocol_version=protocol_version,
            capabilities=client_capabilities.model_dump() if client_capabilities else None,
            env={k: v for k, v in os.environ.items() if k.startswith(("CLAUDE", "HOME", "CODEX"))},
        )
        return InitializeResponse(
            protocol_version=1,
            agent_capabilities=AgentCapabilities(
                load_session=True, mcp_capabilities=McpCapabilities(http=True)
            ),
            auth_methods=[],
        )

    async def new_session(self, cwd, additional_directories=None, mcp_servers=None, **kw):
        session_id = str(uuid4())
        meta = kw or {}
        model = (meta.get("claudeCode") or {}).get("options", {}).get("model") or meta.get("model")
        if model in ("fake-large", "fake-small"):
            self.model = model
        log(
            "new_session",
            session_id=session_id,
            cwd=cwd,
            mcp_servers=[s.model_dump(by_alias=True) for s in (mcp_servers or [])],
            meta=meta,
            instructions=os.path.exists(os.path.join(cwd, "AGENTS.md")),
        )
        return NewSessionResponse(
            session_id=session_id, config_options=options(self.model, self.effort)
        )

    async def load_session(self, cwd, session_id, mcp_servers=None, **kw):
        lost = os.path.exists(LOST) and session_id in open(LOST, encoding="utf-8").read()
        log("load_session", session_id=session_id, lost=lost, meta=kw or {})
        if lost:
            raise RuntimeError("no such session")
        # A replay of the old messages, which the client must ignore.
        await self.conn.session_update(
            session_id=session_id, update=update_agent_message_text("REPLAYED OLD TEXT")
        )
        return LoadSessionResponse(config_options=options(self.model, self.effort))

    async def set_config_option(self, config_id, session_id, value, **kw):
        log("set_config_option", config_id=config_id, value=value)
        if config_id == "model":
            self.model = value
        elif config_id == "effort":
            self.effort = value
        from acp.schema import SetSessionConfigOptionResponse

        return SetSessionConfigOptionResponse(config_options=options(self.model, self.effort))

    async def set_session_mode(self, session_id, mode_id, **kw):
        return None

    async def authenticate(self, method_id, **kw):
        return None

    async def cancel(self, session_id, **kw):
        log("cancel", session_id=session_id)

    async def close_session(self, session_id, **kw):
        log("close_session", session_id=session_id)
        return None

    async def prompt(self, session_id, prompt, **kw):
        text = "".join(getattr(block, "text", "") for block in prompt)
        log("prompt", session_id=session_id, text=text, model=self.model, effort=self.effort)
        if "lose session" in text:
            with open(LOST, "a", encoding="utf-8") as handle:
                handle.write(session_id + "\n")
        send = self.conn.session_update
        if "please fail" in text:
            raise RuntimeError("the fake agent was asked to fail")
        if "please take long" in text:
            await asyncio.sleep(30)
        # One of this app's tools (allowed), then a shell command (must be refused).
        for call_id, title in (("c1", "mcp__avn__get_context"), ("c2", "Bash")):
            await send(
                session_id=session_id,
                update=start_tool_call(call_id, title, kind="other", status="pending"),
            )
            outcome = await self.conn.request_permission(
                session_id=session_id,
                tool_call=ToolCallUpdate(toolCallId=call_id, title=title),
                options=[
                    PermissionOption(option_id="y", name="Allow", kind="allow_once"),
                    PermissionOption(option_id="n", name="Reject", kind="reject_once"),
                ],
            )
            chosen = getattr(outcome.outcome, "option_id", outcome.outcome.outcome)
            log("permission", title=title, outcome=chosen)
            await send(
                session_id=session_id,
                update=update_tool_call(
                    call_id,
                    status="completed" if chosen == "y" else "failed",
                    raw_input={"word": "ping"},
                    raw_output="ok" if chosen == "y" else "denied",
                ),
            )
        for piece in ("Hello ", "world"):
            await send(session_id=session_id, update=update_agent_message_text(piece))
        await send(
            session_id=session_id,
            update=UsageUpdate(sessionUpdate="usage_update", used=1234, size=200000),
        )
        return PromptResponse(
            stop_reason="end_turn",
            usage=Usage(total_tokens=15, input_tokens=10, output_tokens=5, cached_read_tokens=0),
        )

    async def list_sessions(self, cwd=None, cursor=None, **kw):
        from acp.schema import ListSessionsResponse

        return ListSessionsResponse(sessions=[])

    async def fork_session(self, session_id, cwd, **kw):
        raise RuntimeError("not supported")

    async def resume_session(self, session_id, cwd, **kw):
        raise RuntimeError("not supported")

    async def ext_method(self, method, params):
        return {}

    async def ext_notification(self, method, params):
        pass


if __name__ == "__main__":
    try:
        asyncio.run(run_agent(FakeAgent()))
    except (KeyboardInterrupt, BrokenPipeError):
        pass
    sys.exit(0)
