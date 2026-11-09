"""The read-only MCP server for outside agents: keys, scope, and that nothing here can write."""

import json

import pytest
from fastapi.testclient import TestClient
from test_backend import AUTH, TOKEN, event, register, send

from avn_analytics.api import create_app
from avn_analytics.config import Settings
from avn_analytics.mcp_server import READ_ONLY_TOOLS
from avn_analytics.nutbot import TOOLS

WRITING_WORDS = ("save", "set", "propose", "show", "delete", "update", "create", "restore")


def add_game(admin, name, bundle):
    response = admin.post(
        "/v1/games",
        headers=AUTH,
        json={"name": name, "bundle_id": bundle, "platform": "android"},
    )
    assert response.status_code == 201, response.text
    return response.json()


def make_settings(tmp_path, **more):
    return Settings(data_dir=tmp_path / "data", admin_token=TOKEN, **more)


@pytest.fixture
def world(tmp_path):
    """The admin app with two workspaces, a game in each, and events in the first game."""
    settings = make_settings(tmp_path)
    with TestClient(create_app(settings, admin=True)) as admin:
        first = register(admin, "com.avn.first")
        second = add_game(admin, "Second Game", "com.avn.second")
        other = admin.post("/v1/workspaces", headers=AUTH, json={"name": "Other"})
        assert other.status_code == 201, other.text
        other = other.json()
        moved = admin.post(
            f"/v1/games/{second['id']}/move", headers=AUTH, json={"workspace_id": other["id"]}
        )
        assert moved.status_code == 200, moved.text
        home = admin.get(f"/v1/games/{first['id']}", headers=AUTH).json()["workspace_id"]
        with TestClient(create_app(settings)) as ingest:
            events = []
            for device, levels in (("a", 3), ("b", 2)):
                names = [("first_open", {})]
                for level in range(1, levels + 1):
                    names += [
                        ("LEVEL_ANALYSIS", {"STATE": "Started", "LEVEL_NUMBER": level}),
                        ("LEVEL_ANALYSIS", {"STATE": "Completed", "LEVEL_NUMBER": level}),
                    ]
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
            assert send(ingest, first, events).status_code == 200
        yield admin, {"first": first, "second": second, "home": home, "other": other["id"]}


def make_key(admin, **body):
    response = admin.post(
        "/v1/mcp-keys", headers=AUTH, json={"name": "Partner", "workspace_ids": [], **body}
    )
    assert response.status_code == 201, response.text
    return response.json()


def rpc(admin, key, method, params=None, *, path="/mcp", ident=1, **headers):
    headers = {"Authorization": f"Bearer {key}", **headers} if key else headers
    return admin.post(
        path,
        headers=headers,
        json={"jsonrpc": "2.0", "id": ident, "method": method, "params": params or {}},
    )


def call(admin, key, tool, **arguments):
    response = rpc(admin, key, "tools/call", {"name": tool, "arguments": arguments})
    assert response.status_code == 200, response.text
    result = response.json()["result"]
    return result["isError"], result["content"][0]["text"]


# ---- the surface


def test_the_tool_list_only_reads():
    names = {tool["name"] for tool in TOOLS}
    assert set(READ_ONLY_TOOLS) <= names
    for name in READ_ONLY_TOOLS:
        assert not name.startswith(WRITING_WORDS), name


def test_tools_are_marked_read_only_and_need_a_game(world):
    admin, games = world
    key = make_key(admin, game_ids=[games["first"]["id"]])
    tools = rpc(admin, key["secret"], "tools/list").json()["result"]["tools"]
    assert [tool["name"] for tool in tools] == ["list_games", *READ_ONLY_TOOLS]
    for tool in tools:
        assert tool["annotations"]["readOnlyHint"] is True
        assert tool["annotations"]["destructiveHint"] is False
    for tool in tools[1:]:
        assert tool["inputSchema"]["required"][0] == "game_id"
        assert "dashboard" not in json.dumps(tool["inputSchema"])


def test_tools_that_change_things_cannot_be_called(world):
    admin, games = world
    key = make_key(admin, game_ids=[games["first"]["id"]])
    base = f"/v1/games/{games['first']['id']}"
    before = (
        admin.get(f"{base}/dictionary", headers=AUTH).json(),
        admin.get(f"{base}/insights/funnels", headers=AUTH).json(),
    )
    for name in ("save_funnel", "set_event_label", "show_in_dashboard", "propose_report", "x"):
        error, text = call(
            admin, key["secret"], name, game_id=games["first"]["id"], confirmed=True, name="n"
        )
        assert error and "no tool called" in text
    after = (
        admin.get(f"{base}/dictionary", headers=AUTH).json(),
        admin.get(f"{base}/insights/funnels", headers=AUTH).json(),
    )
    assert before == after


def test_handshake(world):
    admin, games = world
    key = make_key(admin, game_ids=[games["first"]["id"]])["secret"]
    reply = rpc(admin, key, "initialize", {"protocolVersion": "2025-06-18"}).json()["result"]
    assert reply["capabilities"] == {"tools": {}}
    assert reply["serverInfo"]["name"] == "avn-analytics" and "list_games" in reply["instructions"]
    assert (
        admin.post(
            "/mcp",
            headers={"Authorization": f"Bearer {key}"},
            json={"jsonrpc": "2.0", "method": "notifications/initialized"},
        ).status_code
        == 202
    )
    assert rpc(admin, key, "ping").json()["result"] == {}
    assert admin.get("/mcp", headers={"Authorization": f"Bearer {key}"}).status_code == 405
    assert (
        admin.post("/mcp", headers={"Authorization": f"Bearer {key}"}, json=[]).status_code == 400
    )


# ---- keys


def test_keys_can_be_shown_again_and_managed(world):
    admin, games = world
    made = make_key(admin, game_ids=[games["first"]["id"]])
    assert made["secret"].startswith("avn_mcp_") and made["endpoint"].endswith("/mcp")
    assert made["link"] is None and made["games"] == 1 and made["calls"] == 0
    listed = admin.get("/v1/mcp-keys", headers=AUTH).json()
    assert listed["keys"][0]["secret"] == made["secret"]  # the same key, every time

    assert call(admin, made["secret"], "list_games")[0] is False
    used = admin.get("/v1/mcp-keys", headers=AUTH).json()["keys"][0]
    assert used["calls"] == 1 and used["last_used_at"]

    off = admin.patch(f"/v1/mcp-keys/{made['id']}", headers=AUTH, json={"enabled": False}).json()
    assert off["enabled"] is False and off["secret"] == made["secret"]
    assert rpc(admin, made["secret"], "ping").status_code == 401
    admin.patch(f"/v1/mcp-keys/{made['id']}", headers=AUTH, json={"enabled": True})
    assert rpc(admin, made["secret"], "ping").status_code == 200

    fresh = admin.post(f"/v1/mcp-keys/{made['id']}/regenerate", headers=AUTH).json()
    assert fresh["secret"] != made["secret"] and fresh["id"] == made["id"]
    assert rpc(admin, made["secret"], "ping").status_code == 401  # the old one is dead
    assert rpc(admin, fresh["secret"], "ping").status_code == 200

    assert admin.delete(f"/v1/mcp-keys/{made['id']}", headers=AUTH).status_code == 204
    assert rpc(admin, fresh["secret"], "ping").status_code == 401
    assert admin.get("/v1/mcp-keys", headers=AUTH).json()["keys"] == []
    actions = [item["action"] for item in admin.app.state.accounts.audit_log()]
    assert {"mcp.key_create", "mcp.key_regenerate", "mcp.key_delete"} <= set(actions)


def test_a_key_needs_a_name_and_something_to_read(world):
    admin, games = world
    assert admin.post("/v1/mcp-keys", headers=AUTH, json={"name": "x"}).status_code == 400
    assert (
        admin.post(
            "/v1/mcp-keys",
            headers=AUTH,
            json={"name": "", "game_ids": [games["first"]["id"]]},
        ).status_code
        == 400
    )
    unknown = "00000000-0000-4000-8000-000000000000"
    assert (
        admin.post(
            "/v1/mcp-keys", headers=AUTH, json={"name": "x", "game_ids": [unknown]}
        ).status_code
        == 400
    )
    assert (
        admin.post(
            "/v1/mcp-keys", headers=AUTH, json={"name": "x", "workspace_ids": [unknown]}
        ).status_code
        == 400
    )


def test_only_the_admin_manages_keys(tmp_path):
    settings = make_settings(
        tmp_path, access_team_domain="team.example", access_audience="aud", lan_admin=False
    )
    with TestClient(create_app(settings, admin=True)) as admin:
        assert admin.get("/v1/mcp-keys").status_code == 401
        assert admin.post("/v1/mcp-keys", json={"name": "x"}).status_code == 401


def test_without_a_valid_key_nothing_is_served(world):
    admin, games = world
    key = make_key(admin, game_ids=[games["first"]["id"]])["secret"]
    for headers in ({}, {"Authorization": "Bearer nope"}, {"Authorization": "Bearer avn_mcp_x"}):
        response = admin.post("/mcp", headers=headers, json={"method": "ping"})
        assert response.status_code == 401
        assert "Bearer" in response.headers["www-authenticate"]
    # the admin token and ingest keys are not MCP keys
    assert admin.post("/mcp", headers=AUTH, json={"method": "ping"}).status_code == 401
    assert (
        admin.post(
            "/mcp", headers={"Authorization": f"Bearer {games['first']['key']['api_key']}"}, json={}
        ).status_code
        == 401
    )
    assert rpc(admin, key, "ping").status_code == 200


def test_a_key_in_the_link_works_only_when_switched_on(world):
    admin, games = world
    made = make_key(admin, game_ids=[games["first"]["id"]])
    link = f"/mcp/{made['secret']}"
    assert rpc(admin, None, "ping", path=link).status_code == 401  # off by default
    on = admin.patch(f"/v1/mcp-keys/{made['id']}", headers=AUTH, json={"url_access": True}).json()
    assert on["link"].endswith(link)
    assert rpc(admin, None, "ping", path=link).status_code == 200
    assert rpc(admin, None, "ping", path="/mcp/avn_mcp_wrong").status_code == 401
    # the header keeps working either way
    assert rpc(admin, made["secret"], "ping").status_code == 200


def test_the_public_address_comes_from_the_setting(tmp_path):
    settings = make_settings(tmp_path, mcp_public_url="https://data.example.org")
    with TestClient(create_app(settings, admin=True)) as admin:
        game = register(admin)
        made = make_key(admin, game_ids=[game["id"]], url_access=True)
        assert made["endpoint"] == "https://data.example.org/mcp"
        assert made["link"] == f"https://data.example.org/mcp/{made['secret']}"


def test_switched_off_there_is_no_server(tmp_path):
    with TestClient(create_app(make_settings(tmp_path, mcp_enabled=False), admin=True)) as admin:
        assert admin.post("/mcp", json={"method": "ping"}).status_code == 404
        assert admin.get("/v1/mcp-keys", headers=AUTH).json() == {"enabled": False, "keys": []}


def test_the_ingest_service_has_no_mcp(tmp_path):
    with TestClient(create_app(make_settings(tmp_path))) as ingest:
        assert ingest.post("/mcp", json={"method": "ping"}).status_code == 404


# ---- what a key can read


def test_a_key_sees_only_the_games_in_its_scope(world):
    admin, games = world
    single = make_key(admin, game_ids=[games["first"]["id"]])["secret"]
    listed = json.loads(call(admin, single, "list_games")[1])["games"]
    assert [game["id"] for game in listed] == [games["first"]["id"]]
    assert listed[0]["name"] == "Test Game" and listed[0]["platform"] == "android"

    error, text = call(admin, single, "get_overview", game_id=games["second"]["id"])
    assert error and "can't look" in text
    error, text = call(
        admin, single, "get_overview", game_id="00000000-0000-4000-8000-000000000000"
    )
    assert error and "can't look" in text  # the same answer as for a game that isn't there

    whole = make_key(admin, workspace_ids=[games["other"]])["secret"]
    assert [g["id"] for g in json.loads(call(admin, whole, "list_games")[1])["games"]] == [
        games["second"]["id"]
    ]
    both = make_key(admin, workspace_ids=[games["other"]], game_ids=[games["first"]["id"]])
    assert both["games"] == 2 and both["workspaces"] == 1
    assert len(json.loads(call(admin, both["secret"], "list_games")[1])["games"]) == 2


def test_a_workspace_key_covers_games_added_later(world):
    admin, games = world
    key = make_key(admin, workspace_ids=[games["home"]])["secret"]
    before = json.loads(call(admin, key, "list_games")[1])["games"]
    third = add_game(admin, "Third Game", "com.avn.third")
    after = json.loads(call(admin, key, "list_games")[1])["games"]
    assert len(after) == len(before) + 1 and third["id"] in {g["id"] for g in after}


def test_a_key_with_one_game_can_leave_the_id_out(world):
    admin, games = world
    key = make_key(admin, game_ids=[games["first"]["id"]])["secret"]
    error, text = call(admin, key, "get_overview", start="2026-10-01", end="2026-10-05")
    assert not error and json.loads(text)["events"]
    both = make_key(admin, workspace_ids=[games["other"]], game_ids=[games["first"]["id"]])
    error, text = call(admin, both["secret"], "get_overview")
    assert error and "list_games" in text


def test_read_tools_answer_with_real_numbers(world):
    admin, games = world
    key = make_key(admin, game_ids=[games["first"]["id"]])["secret"]
    arguments = {"game_id": games["first"]["id"], "start": "2026-10-01", "end": "2026-10-05"}
    error, text = call(admin, key, "get_overview", **arguments)
    assert not error
    totals = json.loads(text)
    assert totals["players"] == 2 and totals["events"] > 0
    error, text = call(admin, key, "list_events", **arguments)
    assert not error and "LEVEL_ANALYSIS" in text
    error, text = call(admin, key, "get_level_progress", **arguments)
    table = json.loads(text)
    assert not error and [row[table["columns"].index("level")] for row in table["rows"]] == [
        1,
        2,
        3,
    ], text
    # the default range is the last 30 days, so these old events are not in it
    error, text = call(admin, key, "get_overview", game_id=games["first"]["id"])
    assert not error and json.loads(text)["events"] == 0


def test_calls_are_limited_per_key(tmp_path):
    with TestClient(
        create_app(make_settings(tmp_path, mcp_calls_per_minute=2), admin=True)
    ) as admin:
        game = register(admin)
        busy = make_key(admin, game_ids=[game["id"]])["secret"]
        calm = make_key(admin, game_ids=[game["id"]])["secret"]
        assert not call(admin, busy, "list_games")[0]
        assert not call(admin, busy, "list_games")[0]
        error, text = call(admin, busy, "list_games")
        assert error and "Too many calls" in text
        assert not call(admin, calm, "list_games")[0]  # another key is not held back
