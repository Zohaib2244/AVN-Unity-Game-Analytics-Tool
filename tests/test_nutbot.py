import json
import stat
import sys

import pytest
from fastapi.testclient import TestClient
from test_backend import TOKEN, event, register, send

from avn_analytics.api import create_app
from avn_analytics.auth import Accounts, Principal
from avn_analytics.config import Settings
from avn_analytics.nutbot import TOOLS

FAKE_CLAUDE = """#!{python}
import json, sys
open(__file__ + ".args", "a").write(json.dumps(sys.argv[1:]) + "\\n")
prompt = sys.stdin.read()
open(__file__ + ".prompt", "w").write(prompt)
sid = sys.argv[sys.argv.index("--session-id") + 1] if "--session-id" in sys.argv else sys.argv[sys.argv.index("--resume") + 1]
def out(frame):
    print(json.dumps(frame), flush=True)
out({{"type": "system", "subtype": "init", "session_id": sid}})
out({{"type": "stream_event", "event": {{"type": "content_block_delta", "delta": {{"type": "text_delta", "text": "Hello "}}}}}})
out({{"type": "stream_event", "event": {{"type": "content_block_delta", "delta": {{"type": "text_delta", "text": "world"}}}}}})
out({{"type": "assistant", "message": {{"content": [{{"type": "text", "text": "Hello world"}}, {{"type": "tool_use", "name": "mcp__avn__get_context", "input": {{}}}}]}}}})
out({{"type": "user", "message": {{"content": [{{"type": "tool_result", "content": "ok"}}]}}}})
out({{"type": "result", "is_error": False, "result": "Hello world", "usage": {{"input_tokens": 10, "output_tokens": 5}}, "total_cost_usd": 0.001, "num_turns": 2}})
"""


@pytest.fixture
def bot(tmp_path, monkeypatch):
    script = tmp_path / "claude"
    script.write_text(FAKE_CLAUDE.format(python=sys.executable))
    script.chmod(script.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("CLAUDE_CODE_OAUTH_TOKEN", "test-token")
    settings = Settings(
        data_dir=tmp_path / "data",
        admin_token=TOKEN,
        nutbot_claude_bin=str(script),
        nutbot_daily_limit=3,
    )
    with TestClient(create_app(settings, admin=True)) as admin:
        yield admin, script, settings


def chat(admin, game, **body):
    response = admin.post(f"/v1/games/{game['id']}/nutbot/chat", json={"message": "hi", **body})
    return response, [json.loads(line) for line in response.text.splitlines() if line]


def test_chat_streams_text_tools_and_usage(bot):
    admin, script, _ = bot
    game = register(admin)
    response, events = chat(
        admin,
        game,
        context={"page": "funnels", "range": {"from": "2026-10-01", "to": "2026-10-05"}},
    )
    assert response.status_code == 200
    types = [item["type"] for item in events]
    assert types[0] == "session" and types[-1] == "done"
    assert "".join(item["text"] for item in events if item["type"] == "text") == "Hello world"
    tool = next(item for item in events if item["type"] == "tool")
    assert tool["name"] == "get_context" and tool["label"] == "Looking at the game"
    assert {"type": "tool_result", "ok": True} in events
    assert next(item for item in events if item["type"] == "usage")["output_tokens"] == 5
    args = json.loads(open(f"{script}.args").readline())
    assert args[args.index("--tools") + 1] == ""  # no built-in tools: only this app's
    assert args[args.index("--model") + 1] == "claude-sonnet-5-5"
    assert "--strict-mcp-config" in args and "--session-id" in args
    config = json.loads(args[args.index("--mcp-config") + 1])
    assert config["mcpServers"]["avn"]["headers"]["Authorization"].startswith("Bearer ")
    prompt = open(f"{script}.prompt").read()
    assert "dashboard range: 2026-10-01 to 2026-10-05" in prompt and prompt.endswith("hi")


def test_chat_resumes_only_your_own_session(bot):
    admin, script, _ = bot
    game = register(admin)
    _, first = chat(admin, game)
    session = first[0]["id"]
    chat(admin, game, session_id=session)
    lines = [json.loads(line) for line in open(f"{script}.args")]
    assert "--resume" in lines[1] and lines[1][lines[1].index("--resume") + 1] == session
    chat(admin, game, session_id="11111111-1111-1111-1111-111111111111")  # not ours: fresh chat
    assert "--session-id" in json.loads(open(f"{script}.args").readlines()[2])


def test_chat_limits_and_availability(bot, monkeypatch):
    admin, _, _ = bot
    game = register(admin)
    for _ in range(3):
        assert chat(admin, game)[0].status_code == 200
    assert (
        admin.post(f"/v1/games/{game['id']}/nutbot/chat", json={"message": "x"}).status_code == 429
    )
    harnesses = admin.get("/v1/nutbot").json()
    claude = next(item for item in harnesses["harnesses"] if item["id"] == "claude")
    assert claude["available"] and claude["default_model"] == "claude-sonnet-5-5"
    assert (
        next(item for item in harnesses["harnesses"] if item["id"] == "codex")["available"] is False
    )
    monkeypatch.delenv("CLAUDE_CODE_OAUTH_TOKEN")
    assert admin.get("/v1/nutbot").json()["harnesses"][0]["available"] is False
    refused = admin.post(
        f"/v1/games/{game['id']}/nutbot/chat", json={"message": "x", "harness": "codex"}
    )
    assert refused.status_code == 409


def test_workspace_nutbot_access_rules():
    lead = Principal("l@x.io", "L", False, "access", {"w1": "lead"})
    member = Principal("m@x.io", "M", False, "access", {"w1": "member"})
    admin = Principal("a@x.io", "A", True, "access")
    allowed = Accounts.nutbot_allowed
    assert [allowed(who, "w1", "admins") for who in (admin, lead, member)] == [True, False, False]
    assert [allowed(who, "w1", "leads") for who in (admin, lead, member)] == [True, True, False]
    assert [allowed(who, "w1", "everyone") for who in (admin, lead, member)] == [True, True, True]
    assert allowed(lead, "other", "everyone") is False  # no role in that workspace


def test_workspace_setting_is_stored_and_listed(bot):
    admin, _, _ = bot
    workspace = admin.get("/v1/workspaces").json()[0]
    assert workspace["nutbot_access"] == "leads" and workspace["nutbot"] is True
    assert (
        admin.patch(
            f"/v1/workspaces/{workspace['id']}/nutbot", json={"access": "everyone"}
        ).status_code
        == 200
    )
    assert admin.get("/v1/workspaces").json()[0]["nutbot_access"] == "everyone"
    assert (
        admin.patch(
            f"/v1/workspaces/{workspace['id']}/nutbot", json={"access": "nobody"}
        ).status_code
        == 400
    )


# ---- the tools the agent calls (JSON-RPC over MCP)


def rpc(admin_app, token, method, params=None, ident=1):
    nutbot = admin_app.app.state.nutbot
    return nutbot.mcp(
        token, {"jsonrpc": "2.0", "id": ident, "method": method, "params": params or {}}
    )


@pytest.fixture
def tools(bot):
    admin, _, settings = bot
    game = register(admin)
    ingest_settings = settings
    with TestClient(create_app(ingest_settings)) as ingest:
        events = []
        for device, levels in (("a", 3), ("b", 2)):
            names = [("first_open", {})]
            for level in range(1, levels + 1):
                names += [
                    ("LEVEL_ANALYSIS", {"Started": str(level)}),
                    ("LEVEL_ANALYSIS", {"Completed": str(level)}),
                ]
            names.append(("done", {}))
            for index, (name, params) in enumerate(names):
                events.append(
                    event(
                        name=name,
                        params=params,
                        device_id=device,
                        session_id=f"s-{device}",
                        client_ts=f"2026-10-04T10:{index:02d}:00Z",
                    )
                )
        assert send(ingest, game, events).status_code == 200
    nutbot = admin.app.state.nutbot
    from avn_analytics.auth import Principal as P
    from avn_analytics.nutbot import Run

    def make(can_write=True):
        run = Run(
            token="t" + str(len(nutbot.runs)),
            principal=P("local", "Local admin", True, "local"),
            game_id=game["id"],
            workspace_id=admin.app.state.accounts.workspace_of_game(game["id"]),
            can_write=can_write,
            defaults={
                "start": "2026-10-01",
                "end": "2026-10-05",
                "hide_test": False,
                "filters": {
                    k: []
                    for k in ("environments", "app_versions", "builds", "countries", "platforms")
                },
            },
        )
        nutbot.runs[run.token] = run
        return run

    return admin, game, nutbot, make


def call(nutbot, run, tool, /, **arguments):
    status, body = nutbot.mcp(
        run.token,
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": tool, "arguments": arguments},
        },
    )
    assert status == 200
    result = body["result"]
    return result["isError"], result["content"][0]["text"]


def test_mcp_handshake_and_tool_list(tools):
    _, _, nutbot, make = tools
    run = make()
    status, body = nutbot.mcp(
        run.token,
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {"protocolVersion": "2025-06-18"},
        },
    )
    assert status == 200 and body["result"]["capabilities"] == {"tools": {}}
    assert nutbot.mcp(run.token, {"jsonrpc": "2.0", "method": "notifications/initialized"}) == (
        202,
        None,
    )
    listed = nutbot.mcp(run.token, {"jsonrpc": "2.0", "id": 2, "method": "tools/list"})[1][
        "result"
    ]["tools"]
    assert [tool["name"] for tool in listed] == [tool["name"] for tool in TOOLS]
    assert nutbot.mcp("wrong", {"jsonrpc": "2.0", "id": 3, "method": "tools/list"})[0] == 401


def test_read_tools_answer_with_real_numbers(tools):
    _, game, nutbot, make = tools
    run = make()
    error, text = call(nutbot, run, "get_context")
    assert not error and json.loads(text)["game"]["id"] == game["id"]
    error, text = call(
        nutbot, run, "run_funnel", steps=[{"event": "first_open"}, {"event": "done"}]
    )
    assert not error and [step["players"] for step in json.loads(text)["steps"]] == [2, 2]
    error, text = call(
        nutbot, run, "get_journeys", steps=[{"event": "first_open"}, {"event": "done"}]
    )
    journeys = json.loads(text)
    assert journeys["started"] == 2 and {j["steps"][0] for j in journeys["journeys"]} == {
        "Levels 1–3 (all completed)",
        "Levels 1–2 (all completed)",
    }
    error, text = call(nutbot, run, "get_level_progress")
    assert [row["level"] for row in json.loads(text)["levels"]] == [1, 2, 3]
    error, text = call(nutbot, run, "get_player_story", player="a")
    assert "Played levels 1–3, completed all" in text
    error, text = call(nutbot, run, "list_events")
    assert "LEVEL_ANALYSIS" in text
    error, text = call(nutbot, run, "run_funnel", steps=[{"event": "first_open"}])
    assert error and "steps" in text.lower()


def test_writes_need_confirmation_and_a_lead(tools):
    admin, game, nutbot, make = tools
    steps = [{"event": "first_open"}, {"event": "done"}]
    run = make()
    error, text = call(nutbot, run, "save_funnel", name="Quick", steps=steps, confirmed=False)
    assert not error and json.loads(text)["needs_confirmation"] is True
    assert admin.get(f"/v1/games/{game['id']}/insights/funnels").json() == []
    error, text = call(nutbot, run, "save_funnel", name="Quick", steps=steps, confirmed=True)
    assert json.loads(text)["saved"] is True
    assert [f["name"] for f in admin.get(f"/v1/games/{game['id']}/insights/funnels").json()] == [
        "Quick"
    ]
    error, text = call(nutbot, run, "set_event_label", event="done", confirmed=True)
    assert error and "description" in text
    error, text = call(
        nutbot,
        run,
        "set_event_label",
        event="done",
        description="Done",
        labels="* => All done",
        hidden=True,
        confirmed=True,
    )
    assert json.loads(text)["saved"] is True
    saved = admin.get(f"/v1/games/{game['id']}/dictionary").json()["done"]
    assert saved["labels"] == "* => All done" and saved["hidden"] is True
    reader = make(can_write=False)
    error, text = call(nutbot, reader, "save_funnel", name="No", steps=steps, confirmed=True)
    assert error and "lead" in text


def test_show_in_dashboard_queues_an_action_and_other_games_are_blocked(tools):
    admin, game, nutbot, make = tools
    run = make()
    error, _ = call(
        nutbot,
        run,
        "show_in_dashboard",
        page="funnels",
        title="Open it",
        funnel={"steps": [{"event": "first_open"}, {"event": "done"}]},
    )
    assert not error
    action = run.actions.popleft()
    assert (
        action["type"] == "action"
        and action["page"] == "funnels"
        and action["game_id"] == game["id"]
    )
    error, text = call(nutbot, run, "get_overview", game_id="00000000-0000-0000-0000-000000000000")
    assert error
    outsider = make()
    outsider.principal = Principal("x@x.io", "X", False, "access", {})
    error, text = call(
        nutbot, outsider, "get_overview", game_id="00000000-0000-0000-0000-000000000000"
    )
    assert error and "can't look" in text


def test_mcp_route_requires_loopback_and_token(bot):
    admin, _, _ = bot
    assert admin.post("/nutbot/mcp", json={"method": "ping"}).status_code == 403  # no bearer token
    assert (
        admin.post(
            "/nutbot/mcp", json={"method": "ping"}, headers={"Authorization": "Bearer x"}
        ).status_code
        == 403
    )  # not loopback


def test_abandoned_slot_does_not_lock_the_person_out(bot):
    admin, _, settings = bot
    game = register(admin)
    nutbot = admin.app.state.nutbot
    principal = Principal("local", "Local admin", True, "local")
    nutbot.prepare(principal, admin.get(f"/v1/games/{game['id']}").json(), None, {"message": "hi"})
    # prepared but never streamed (the browser left): the next message is refused only briefly
    assert (
        admin.post(f"/v1/games/{game['id']}/nutbot/chat", json={"message": "again"}).status_code
        == 429
    )
    token, _ = nutbot.active["local"]
    nutbot.active["local"] = (token, 0)  # pretend it is old
    assert chat(admin, game)[0].status_code == 200
