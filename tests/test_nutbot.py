import json
import stat
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from test_backend import TOKEN, event, register, send

from avn_analytics.api import create_app
from avn_analytics.auth import Principal
from avn_analytics.config import Settings
from avn_analytics.nutbot import TOOLS
from avn_analytics.nutbot_limits import Limits, parse_claude_usage, parse_codex_limits

FAKE_AGENT = Path(__file__).parent / "fake_acp_agent.py"


@pytest.fixture
def bot(tmp_path, monkeypatch):
    """The admin app with the fake ACP agent standing in for the Claude adapter."""
    import sys

    launcher = tmp_path / "claude-agent-acp"
    launcher.write_text(
        "#!/bin/sh\n"
        f"FAKE_ACP_LOG={tmp_path}/agent.log FAKE_ACP_LOST={tmp_path}/lost.txt "
        f"exec {sys.executable} {FAKE_AGENT}\n"
    )
    launcher.chmod(launcher.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("CLAUDE_CODE_OAUTH_TOKEN", "test-token")

    async def fake_claude_limits(self):
        return [{"name": "week", "used_percent": 91.0, "resets_at": None, "minutes": 10080}]

    monkeypatch.setattr(Limits, "_claude", fake_claude_limits)  # never touch the network
    settings = Settings(
        data_dir=tmp_path / "data",
        admin_token=TOKEN,
        nutbot_claude_acp=str(launcher),
        nutbot_daily_limit=5,
        nutbot_run_seconds=4,
    )
    with TestClient(create_app(settings, admin=True)) as admin:
        yield admin, tmp_path, settings


def chat(admin, game, **body):
    response = admin.post(f"/v1/games/{game['id']}/nutbot/chat", json={"message": "hi", **body})
    return response, [json.loads(line) for line in response.text.splitlines() if line]


def agent_log(tmp_path):
    try:
        return [json.loads(line) for line in (tmp_path / "agent.log").read_text().splitlines()]
    except FileNotFoundError:
        return []


def test_chat_streams_text_tools_usage_and_is_recorded(bot):
    admin, tmp_path, settings = bot
    game = register(admin)
    response, events = chat(
        admin,
        game,
        context={"page": "funnels", "range": {"from": "2026-10-01", "to": "2026-10-05"}},
    )
    assert response.status_code == 200
    types = [item["type"] for item in events]
    assert types[0] == "chat" and types[-1] == "done"
    assert events[0]["title"] == "hi"  # the chat is named from the first message
    assert "".join(item["text"] for item in events if item["type"] == "text") == "Hello world"
    tools = [item for item in events if item["type"] == "tool"]
    assert [tool["name"] for tool in tools] == ["get_context", "Bash"]
    results = [item for item in events if item["type"] == "tool_result"]
    assert [item["ok"] for item in results] == [True, False]  # our tool ran, the shell did not
    assert next(item for item in events if item["type"] == "context")["used"] == 1234
    assert next(item for item in events if item["type"] == "usage")["output_tokens"] == 5
    assert "91%" in next(item for item in events if item["type"] == "notice")["text"]
    # What the agent was given: a locked-down session with only this app's MCP server.
    log = agent_log(tmp_path)
    init = next(item for item in log if item["kind"] == "initialize")
    assert init["capabilities"]["fs"]["read_text_file"] is False
    assert not init["capabilities"]["terminal"]
    assert init["env"]["HOME"] == str(settings.nutbot_home)
    session = next(item for item in log if item["kind"] == "new_session")
    options = session["meta"]["claudeCode"]["options"]
    assert session["meta"]["disableBuiltInTools"] is True and options["tools"] == []
    assert options["model"] == "sonnet" and options["settingSources"] == []
    assert "NutBot" in session["meta"]["systemPrompt"]
    server = session["mcp_servers"][0]
    assert server["url"].endswith("/nutbot/mcp") and server["name"] == "avn"
    assert server["headers"][0]["value"].startswith("Bearer ")
    permissions = {item["title"]: item["outcome"] for item in log if item["kind"] == "permission"}
    assert permissions == {"mcp__avn__get_context": "y", "Bash": "n"}
    prompt = next(item for item in log if item["kind"] == "prompt")["text"]
    assert "dashboard range: 2026-10-01 to 2026-10-05" in prompt and prompt.endswith("hi")
    assert f"game: {game['name']}" in prompt
    # The chat is in this app's own record.
    chats = admin.get(f"/v1/games/{game['id']}/nutbot/chats").json()["chats"]
    assert len(chats) == 1 and chats[0]["title"] == "hi" and chats[0]["messages"] == 2
    assert chats[0]["id"] == events[0]["id"] and chats[0]["agent_session"]
    stored = admin.get(f"/v1/games/{game['id']}/nutbot/chats/{chats[0]['id']}").json()
    answer = stored["messages"][1]
    assert answer["text"] == "Hello world" and answer["usage"]["output_tokens"] == 5
    assert answer["tools"][0]["tool"] == "get_context" and "input" not in answer["tools"][0]
    assert answer["context"] == {"used": 1234, "size": 200000}
    trace = admin.get(f"/v1/games/{game['id']}/nutbot/chats/{chats[0]['id']}/trace").json()
    assert trace["messages"][1]["tools"][0]["input"] == '{"word": "ping"}'


def test_chat_continues_the_agent_session_or_rebuilds_from_the_record(bot):
    admin, tmp_path, _ = bot
    game = register(admin)
    _, first = chat(admin, game)
    chat_id = first[0]["id"]
    session = next(item for item in agent_log(tmp_path) if item["kind"] == "new_session")
    _, second = chat(admin, game, chat_id=chat_id, message="and then?")
    log = agent_log(tmp_path)
    loaded = next(item for item in log if item["kind"] == "load_session")
    assert loaded["session_id"] == session["session_id"] and loaded["lost"] is False
    assert second[-1]["resumed"] is True
    assert "REPLAYED" not in "".join(i["text"] for i in second if i["type"] == "text")
    prompts = [item["text"] for item in log if item["kind"] == "prompt"]
    assert "Most recent messages" not in prompts[-1]  # the agent has its own transcript
    chat(admin, game, chat_id=chat_id, message="now lose session")
    assert chat(admin, game, chat_id=chat_id, message="still there?")[1][-1]["resumed"] is False
    prompts = [item["text"] for item in agent_log(tmp_path) if item["kind"] == "prompt"]
    assert "Most recent messages:" in prompts[-1] and "User: hi" in prompts[-1]
    assert prompts[-1].endswith("still there?")
    assert admin.get(f"/v1/games/{game['id']}/nutbot/chats").json()["chats"][0]["messages"] == 8


def test_chat_limits_availability_and_models(bot, monkeypatch):
    admin, _, _ = bot
    game = register(admin)
    info = admin.get("/v1/nutbot").json()
    claude = next(item for item in info["harnesses"] if item["id"] == "claude")
    # Only what the agent reported: the configured "sonnet" isn't offered, so its own model leads.
    assert claude["available"] and claude["models"] == ["fake-large", "fake-small"]
    assert claude["default_model"] == "fake-large" and claude["models_from"] == "agent"
    assert claude["cheap_model"] == "haiku"
    assert next(item for item in info["harnesses"] if item["id"] == "codex")["available"] is False
    for _ in range(5):
        assert chat(admin, game)[0].status_code == 200
    assert (
        admin.post(f"/v1/games/{game['id']}/nutbot/chat", json={"message": "x"}).status_code == 429
    )
    monkeypatch.delenv("CLAUDE_CODE_OAUTH_TOKEN")
    assert admin.get("/v1/nutbot").json()["harnesses"][0]["available"] is False
    refused = admin.post(
        f"/v1/games/{game['id']}/nutbot/chat", json={"message": "x", "harness": "codex"}
    )
    assert refused.status_code == 409


def test_effort_levels_are_listed_per_model_and_applied(bot):
    admin, tmp_path, _ = bot
    game = register(admin)
    claude = next(i for i in admin.get("/v1/nutbot").json()["harnesses"] if i["id"] == "claude")
    # The large model offers effort levels, the small one none: each is probed once.
    assert [level["value"] for level in claude["efforts"]["fake-large"]] == [
        "low",
        "medium",
        "high",
    ]
    assert "fake-small" not in claude["efforts"]
    assert chat(admin, game, model="fake-large", effort="high")[0].status_code == 200
    log = agent_log(tmp_path)
    assert {"kind": "set_config_option", "config_id": "effort", "value": "high"} in log
    assert [item for item in log if item["kind"] == "prompt"][-1]["effort"] == "high"
    # A level the model doesn't offer is left alone rather than failing the answer.
    assert chat(admin, game, model="fake-small", effort="high")[0].status_code == 200
    assert [item for item in agent_log(tmp_path) if item["kind"] == "prompt"][-1]["model"] == (
        "fake-small"
    )
    bad = admin.post(
        f"/v1/games/{game['id']}/nutbot/chat", json={"message": "x", "effort": "max; rm"}
    )
    assert bad.status_code == 400


def test_hidden_models_are_never_listed_or_run(tmp_path, monkeypatch):
    import sys

    launcher = tmp_path / "claude-agent-acp"
    launcher.write_text(
        f"#!/bin/sh\nFAKE_ACP_LOG={tmp_path}/agent.log exec {sys.executable} {FAKE_AGENT}\n"
    )
    launcher.chmod(launcher.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("CLAUDE_CODE_OAUTH_TOKEN", "test-token")
    monkeypatch.setenv("AVN_NUTBOT_HIDE_MODELS", " Fake-Large , *fable* ")
    monkeypatch.setenv("AVN_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("AVN_ADMIN_TOKEN", TOKEN)
    monkeypatch.setenv("AVN_NUTBOT_CLAUDE_ACP", str(launcher))
    monkeypatch.setenv("AVN_NUTBOT_CLAUDE_MODEL", "fake-large")
    settings = Settings.from_env()
    assert settings.nutbot_hide_models == ("fake-large", "*fable*")
    with TestClient(create_app(settings, admin=True)) as admin:
        game = register(admin)
        info = admin.get("/v1/nutbot").json()
        claude = next(item for item in info["harnesses"] if item["id"] == "claude")
        # The hidden configured default is dropped too, and so are its effort levels.
        assert claude["models"] == ["fake-small"] and claude["default_model"] == "fake-small"
        assert claude["efforts"] == {}
        refused = admin.post(
            f"/v1/games/{game['id']}/nutbot/chat",
            json={"message": "x", "model": "FAKE-LARGE"},
        )
        assert refused.status_code == 400
        assert (
            admin.post(
                f"/v1/games/{game['id']}/nutbot/chats", json={"model": "claude-fable-5-1"}
            ).status_code
            == 400
        )
        assert chat(admin, game)[0].status_code == 200
        prompts = [item for item in agent_log(tmp_path) if item["kind"] == "prompt"]
        assert prompts[-1]["model"] == "fake-small"


def test_chats_are_listed_renamed_deleted_restored_and_private(bot):
    admin, _, _ = bot
    game = register(admin)
    base = f"/v1/games/{game['id']}/nutbot/chats"
    created = admin.post(base, json={"title": "Level 7"}).json()
    assert created["harness"] == "claude" and created["model"] == "sonnet"
    assert admin.patch(f"{base}/{created['id']}", json={"title": "Level seven"}).status_code == 200
    assert admin.get(base).json()["chats"][0]["title"] == "Level seven"
    assert admin.delete(f"{base}/{created['id']}").status_code == 200
    assert admin.get(base).json()["chats"] == []
    assert chat(admin, game, chat_id=created["id"])[0].status_code == 404
    assert admin.post(f"{base}/{created['id']}/restore").status_code == 200
    assert [c["id"] for c in admin.get(base).json()["chats"]] == [created["id"]]
    other = admin.app.state.nutbot.chats.create(game["id"], "someone@else.io", "claude", "")
    assert admin.get(f"{base}/{other['id']}").status_code == 404
    assert chat(admin, game, chat_id=other["id"])[0].status_code == 404


def test_usage_ledger_and_limit_parsing(bot):
    admin, _, _ = bot
    game = register(admin)
    chat(admin, game)
    usage = admin.get("/v1/nutbot/usage").json()
    assert usage["rows"][0]["answers"] == 1 and usage["rows"][0]["output_tokens"] == 5
    assert usage["rows"][0]["harness"] == "claude" and usage["people"] == []
    everyone = admin.get("/v1/nutbot/usage?everyone=1").json()
    assert everyone["people"][0]["email"] == "local" and everyone["people"][0]["chats"] == 1
    limits = admin.get("/v1/nutbot/limits").json()
    assert limits["agents"]["claude"]["windows"][0]["used_percent"] == 91.0
    assert limits["warn_percent"] == 80
    assert parse_claude_usage(
        {"five_hour": {"utilization": 12.5, "resets_at": 1700000000}, "seven_day": {}}
    ) == [
        {
            "name": "5 hours",
            "used_percent": 12.5,
            "resets_at": "2023-11-14T22:13:20Z",
            "minutes": 300,
        },
        {"name": "week", "used_percent": None, "resets_at": None, "minutes": 10080},
    ]
    assert parse_codex_limits(
        {
            "rateLimits": {
                "primary": {"usedPercent": 40, "windowDurationMins": 300, "resetsAt": 1700000000},
                "secondary": {"used_percent": 7, "window_duration_mins": 10080},
            }
        }
    ) == [
        {
            "name": "5 hours",
            "used_percent": 40.0,
            "resets_at": "2023-11-14T22:13:20Z",
            "minutes": 300,
        },
        {"name": "week", "used_percent": 7.0, "resets_at": None, "minutes": 10080},
    ]


def test_agent_failures_and_timeouts_are_reported(bot):
    admin, _, _ = bot
    game = register(admin)
    _, events = chat(admin, game, message="please fail")
    assert "asked to fail" in next(item for item in events if item["type"] == "error")["message"]
    chats = admin.get(f"/v1/games/{game['id']}/nutbot/chats").json()["chats"]
    stored = admin.get(f"/v1/games/{game['id']}/nutbot/chats/{chats[0]['id']}").json()
    assert "asked to fail" in stored["messages"][1]["error"]
    _, events = chat(admin, game, message="please take long")
    assert "too long" in next(item for item in events if item["type"] == "error")["message"]


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


def test_find_players_can_sort_and_filter_by_events(tools):
    _, _, nutbot, make = tools
    run = make()
    error, text = call(
        nutbot,
        run,
        "find_players",
        conditions=[{"event": "LEVEL_ANALYSIS", "param": "Completed", "op": "gte", "value": "3"}],
        metrics=[{"event": "LEVEL_ANALYSIS", "param": "Started", "op": "exists", "agg": "max"}],
        sort="metric0",
    )
    data = json.loads(text)
    assert (
        not error
        and [p["player"] for p in data["players"]] == ["a"]
        and data["players"][0]["metrics"] == [3.0]
    )
    error, text = call(nutbot, run, "find_players", metrics=[{"event": "x", "agg": "max"}])
    assert error


def test_player_tools_count_events_levels_and_compare(tools):
    _, _, nutbot, make = tools
    run = make()
    error, text = call(nutbot, run, "get_player_events", player="a")
    data = json.loads(text)
    assert not error and data["total_events"] == 8
    levels = next(row for row in data["events"] if row["event"] == "LEVEL_ANALYSIS")
    assert levels["times"] == 6 and levels["sessions"] == 1
    started = next(p for p in levels["params"] if p["param"] == "Started")
    assert {v["value"] for v in started["values"]} == {"1", "2", "3"}
    error, text = call(
        nutbot,
        run,
        "get_player_events",
        player="a",
        event="LEVEL_ANALYSIS",
        param_filters={"Started": "2"},
    )
    assert json.loads(text)["total_events"] == 1
    error, text = call(nutbot, run, "get_player_events", player="nobody")
    assert error and "No events" in text

    error, text = call(nutbot, run, "get_player_levels", player="a")
    data = json.loads(text)
    assert not error and [row["level"] for row in data["levels"]] == [1, 2, 3]
    assert data["levels"][0]["completes"] == 1 and data["levels"][0]["status"] == "passed"
    assert data["summary"]["highest_level_passed"] == 3 and data["summary"]["sessions"] == 1

    error, text = call(nutbot, run, "compare_player", player="a")
    data = json.loads(text)
    assert not error and data["all_active_players"]["players"] == 2
    assert data["all_active_players"]["events"]["percentile"] == 100


def test_level_exit_and_cohort_tools(tools):
    _, _, nutbot, make = tools
    run = make()
    error, text = call(nutbot, run, "get_level_detail", level=3)
    data = json.loads(text)
    assert not error and data["level"] == 3 and data["rows"][-1]["level"] == 3
    assert data["groups"]
    error, text = call(nutbot, run, "get_level_detail", level=99)
    assert error and "Nobody started level 99" in text

    error, text = call(nutbot, run, "get_exits")
    data = json.loads(text)
    assert not error and "levels" in data and data["levels_in_range"] == 3

    error, text = call(
        nutbot,
        run,
        "compare_cohorts",
        a={"name": "finishers", "conditions": [{"event": "done"}]},
        b={
            "name": "never finished level 3",
            "conditions": [
                {
                    "event": "LEVEL_ANALYSIS",
                    "param": "Completed",
                    "op": "eq",
                    "value": "3",
                    "does": "didnt",
                }
            ],
        },
    )
    data = json.loads(text)
    assert not error and (data["a"]["players"], data["b"]["players"]) == (2, 1)
    assert data["b"]["name"] == "never finished level 3"
    error, text = call(nutbot, run, "compare_cohorts", a={"name": "x"}, b="no")
    assert error


def test_behaviour_finds_sequences_loops_and_dominant_values(tools):
    admin, game, nutbot, make = tools
    run = make()
    error, text = call(nutbot, run, "get_behaviour")
    data = json.loads(text)
    assert not error and data["players"] == 2
    pairs = {item["sequence"]: item["players"] for item in data["common_pairs"]}
    assert pairs["LEVEL_ANALYSIS → done"] == 2
    assert data["events"]["most_used"][0]["event"] == "LEVEL_ANALYSIS"
    error, text = call(nutbot, run, "get_behaviour", start="2026-01-01", end="2026-01-02")
    assert error and "No identified players" in text


def test_proposals_are_checked_queued_and_change_nothing(tools):
    admin, game, nutbot, make = tools
    run = make(can_write=False)
    before = admin.get(f"/v1/games/{game['id']}/insights/funnels").json()
    error, text = call(
        nutbot,
        run,
        "propose_players_view",
        title="Stuck at 3",
        why="Players who started level 3 but never finished it.",
        conditions=[
            {"event": "LEVEL_ANALYSIS", "param": "Started", "op": "eq", "value": "3"},
            {
                "event": "LEVEL_ANALYSIS",
                "param": "Completed",
                "op": "eq",
                "value": "3",
                "does": "didnt",
            },
        ],
        metrics=[{"event": "LEVEL_ANALYSIS", "param": "Started", "op": "exists", "agg": "count"}],
        sort="metric0",
    )
    assert not error, text
    proposal = run.actions.popleft()
    assert proposal["type"] == "proposal" and proposal["kind"] == "players"
    assert proposal["payload"]["sort"] == "metric0" and len(proposal["payload"]["conditions"]) == 2
    assert proposal["plain"][1].startswith("Players who never did LEVEL_ANALYSIS with Completed")
    error, text = call(nutbot, run, "propose_players_view", title="x", why="y", sort="metric2")
    assert error and "metric2" in text
    error, text = call(
        nutbot,
        run,
        "propose_players_view",
        title="x",
        why="y",
        conditions=[{"event": "a", "op": "nope"}],
    )
    assert error
    error, _ = call(
        nutbot,
        run,
        "propose_funnel",
        title="Onboarding",
        why="The first levels.",
        steps=[{"event": "first_open"}, {"event": "done", "label": "Finished"}],
        show_journeys=True,
        start="2026-10-01",
        end="2026-10-03",
    )
    funnel = run.actions.popleft()
    assert (
        not error
        and funnel["payload"]["show_journeys"]
        and funnel["payload"]["end"] == "2026-10-03"
    )
    assert funnel["plain"] == ["Step 1: first_open", "Step 2: Finished"]
    error, text = call(nutbot, run, "propose_funnel", title="x", why="y", steps=[{"event": "a"}])
    assert error
    tree = {
        "match": "all",
        "conditions": [
            {"field": "event", "op": "eq", "value": "LEVEL_ANALYSIS"},
            {"field": "param", "param": "Started", "op": "gte", "value": "7"},
        ],
    }
    error, _ = call(
        nutbot,
        run,
        "propose_highlight",
        title="Deep levels",
        why="w",
        name="Deep",
        color="pink",
        conditions=tree,
    )
    assert not error and run.actions.popleft()["plain"] == [
        "Highlights events where (the event is “LEVEL_ANALYSIS” and Started is at least “7”)"
    ]
    error, text = call(
        nutbot,
        run,
        "propose_highlight",
        title="x",
        why="y",
        name="n",
        conditions={"match": "all", "conditions": []},
    )
    assert error
    error, _ = call(
        nutbot,
        run,
        "propose_level_view",
        title="Worst first",
        why="w",
        sort="drop",
        scope="first_session",
    )
    assert not error and run.actions.popleft()["payload"] == {
        "sort": "drop",
        "scope": "first_session",
    }
    error, text = call(nutbot, run, "propose_level_view", title="x", why="y", sort="sideways")
    assert error
    error, text = call(
        nutbot, run, "explain_conditions", conditions=[{"event": "done", "min_times": 3}]
    )
    assert not error and json.loads(text)["plain"] == ["Players who did done at least 3 times"]
    # A proposal never writes: not even for someone who may save things.
    assert admin.get(f"/v1/games/{game['id']}/insights/funnels").json() == before


def test_slash_skills_expand_for_the_agent_but_the_chat_keeps_what_was_typed(bot):
    admin, tmp_path, _ = bot
    game = register(admin)
    skills = admin.get("/v1/nutbot/skills").json()["skills"]
    assert {"level-review", "player-review", "exits", "digest", "release-check"} <= {
        s["name"] for s in skills
    }
    assert admin.get("/v1/nutbot").json()["skills"] == skills
    _, events = chat(admin, game, message="/level-review 12")
    chat_id = next(e for e in events if e["type"] == "chat")["id"]
    prompt = [r for r in agent_log(tmp_path) if r["kind"] == "prompt"][-1]["text"]
    assert "Review 12." in prompt and "get_level_detail" in prompt
    stored = admin.get(f"/v1/games/{game['id']}/nutbot/chats/{chat_id}").json()["messages"]
    assert stored[0]["text"] == "/level-review 12"
    # Not a skill: sent as typed.
    _, _ = chat(admin, game, message="/nonsense 3", chat_id=chat_id)
    assert [r for r in agent_log(tmp_path) if r["kind"] == "prompt"][-1]["text"].endswith(
        "/nonsense 3"
    )


def test_reports_are_saved_listed_pinned_and_guarded(bot, tmp_path):
    admin, _, _ = bot
    game = register(admin)
    base = f"/v1/games/{game['id']}/nutbot/reports"
    made = admin.post(
        base,
        json={
            "title": "Level 7 review",
            "body": "34% leave at level 7.",
            "headline": {"title": "Level 7 exits", "value": "34%", "sub": "of starters"},
        },
    )
    assert made.status_code == 201
    report = made.json()
    assert report["pinned"] is False and report["headline"]["value"] == "34%"
    assert admin.post(base, json={"title": "", "body": "x"}).status_code == 400
    assert [r["title"] for r in admin.get(base).json()["reports"]] == ["Level 7 review"]
    assert "body" not in admin.get(base).json()["reports"][0]
    assert admin.get(f"{base}/{report['id']}").json()["body"] == "34% leave at level 7."
    pinned = admin.patch(f"{base}/{report['id']}", json={"pinned": True, "title": "L7"}).json()
    assert pinned["pinned"] is True and pinned["title"] == "L7"
    assert len(admin.get(base + "?pinned=true").json()["reports"]) == 1
    assert admin.delete(f"{base}/{report['id']}").status_code == 204
    assert admin.get(base).json()["reports"] == []
    assert admin.get(f"{base}/{report['id']}").status_code == 404
    assert admin.post(f"{base}/{report['id']}/restore").json()["title"] == "L7"
    assert admin.get(base + "?pinned=true").json()["reports"] == []  # deleting unpinned it


def test_report_tool_only_offers_a_card_and_saving_is_the_persons(tools):
    admin, game, nutbot, make = tools
    run = make(can_write=False)
    base = f"/v1/games/{game['id']}/nutbot/reports"
    error, text = call(
        nutbot,
        run,
        "propose_report",
        title="Exits",
        body="Level 3 loses the most players.",
        headline={"title": "Top exit", "value": "Level 3"},
    )
    assert not error and "Nothing has changed" in json.loads(text)["message"]
    # The agent's call saves nothing: the person gets a card.
    assert admin.get(base).json()["reports"] == []
    card = run.actions.popleft()
    assert card["kind"] == "report" and card["payload"]["headline"]["value"] == "Level 3"
    assert card["plain"][0] == "Saves “Exits” to this game's Reports"
    # Save on the card posts the payload; pressing it twice keeps one report.
    chat_id = "11111111-1111-4111-8111-111111111111"
    first = admin.post(base, json={**card["payload"], "chat_id": chat_id}).json()
    again = admin.post(base, json={**card["payload"], "chat_id": chat_id}).json()
    assert first["id"] == again["id"] and len(admin.get(base).json()["reports"]) == 1
    error, text = call(nutbot, run, "propose_report", title="Empty", body="  ")
    assert error and "needs a title" in text
    error, text = call(
        nutbot, run, "propose_report", title="Bad", body="x", headline={"title": "t"}
    )
    assert error and not run.actions
    names = {tool["name"] for tool in TOOLS}
    assert "propose_report" in names and "save_report" not in names


def test_skills_offer_reports_instead_of_saving_them():
    folder = Path(__file__).parents[1] / "avn_analytics" / "nutbot_skills"
    for skill in folder.glob("*.md"):
        assert "save_report" not in skill.read_text(), skill.name


def test_agent_home_and_work_directories_follow_the_settings(tmp_path):
    data = Settings(data_dir=tmp_path / "data", admin_token=TOKEN)
    assert data.nutbot_home == tmp_path / "data" / "nutbot" / "home"
    assert data.nutbot_dir == tmp_path / "data" / "nutbot"
    moved = Settings(data_dir=tmp_path / "data", admin_token=TOKEN, nutbot_home_dir=tmp_path / "h")
    assert moved.nutbot_home == tmp_path / "h" and moved.nutbot_dir == tmp_path / "data" / "nutbot"


def test_player_group_tools_compare_list_and_propose(tools):
    admin, game, nutbot, make = tools
    run = make()
    behavior = {"kind": "level_duration", "level": 1, "split": 90}
    outcome = {"kind": "level", "level": 3, "window_hours": 24}
    error, text = call(nutbot, run, "compare_player_groups", behavior=behavior, outcome=outcome)
    data = json.loads(text)
    assert not error, text
    assert "definition" not in data and [g["id"] for g in data["groups"]][:2] == ["a", "b"]
    assert data["counts"]["eligible"] + data["counts"]["pending"] + data["counts"]["excluded"] >= 0
    error, text = call(
        nutbot, run, "compare_player_groups", behavior={"kind": "event_count"}, outcome=outcome
    )
    assert error  # an event count needs an event and a split

    assert json.loads(call(nutbot, run, "list_saved_groups")[1]) == {"saved": []}
    base = f"/v1/games/{game['id']}/insights/group-library"
    item = {
        "name": "Fast starters",
        "kind": "check",
        "definition": {
            "start": "2026-10-01",
            "end": "2026-10-05",
            "entry_level": 1,
            "behavior": {**behavior, "event": None},
            "outcome": outcome,
            "window_hours": 24,
        },
    }
    assert admin.post(base, json=item).status_code == 201
    saved = json.loads(call(nutbot, run, "list_saved_groups")[1])["saved"]
    assert saved[0]["name"] == "Fast starters" and saved[0]["kind"] == "check"

    error, text = call(
        nutbot,
        run,
        "propose_player_groups",
        title="Fast vs slow",
        why="Does a quick first level predict reaching level 3?",
        behavior=behavior,
        outcome=outcome,
        save=True,
        name="Fast vs slow",
    )
    assert not error, text
    proposal = run.actions.popleft()
    assert proposal["kind"] == "groups" and proposal["payload"]["save"] is True
    assert proposal["payload"]["item"]["kind"] == "check"
    assert proposal["plain"][-1] == "Saved to the library as “Fast vs slow”"
    error, text = call(
        nutbot, run, "propose_player_groups", title="x", why="y", behavior=behavior, save=True
    )
    assert error and "name" in text
    assert admin.get(base).json()[0]["name"] == "Fast starters"  # proposing saved nothing
    error, text = call(nutbot, run, "get_context")
    assert "published_builds" in json.loads(text)


def test_answers_lead_with_the_finding_not_with_ruled_out_causes(bot):
    admin, _, _ = bot
    prompt = admin.app.state.nutbot.system_prompt()
    assert "question that was asked" in prompt
    assert "ruling out causes nobody mentioned" in prompt
