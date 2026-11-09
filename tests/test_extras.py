"""Game setup, data health, the guide, version comparison and saved items for agents."""

import json
from datetime import UTC, date, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from test_backend import AUTH, TOKEN, event, register, send

from avn_analytics import compare, game_setup
from avn_analytics.api import create_app
from avn_analytics.config import Settings
from avn_analytics.exports import period_bounds
from avn_analytics.models import Filters

START, END = period_bounds("custom", date(2026, 10, 1), date(2026, 10, 10))


def at(device, day, name, version="1.0", **params):
    return event(
        name=name,
        params=params,
        device_id=device,
        session_id=f"s-{device}-{day}",
        app_version=version,
        client_ts=f"2026-10-{day:02d}T10:00:00Z",
    )


def level(device, day, state, version, **params):
    return at(device, day, "LEVEL_ANALYSIS", version, STATE=state, LEVEL_NUMBER=1, **params)


def events_of_the_game():
    """Version 1.0 has two players (two completions, 10 s and 20 s, one failure); 2.0 has one
    player (one completion, 30 s, no failure)."""
    return [
        at("p1", 1, "first_open", "1.0"),
        at("p1", 1, "session_start", "1.0"),
        level("p1", 1, "Started", "1.0", ATTEMPT_ID="a1"),
        level("p1", 1, "Completed", "1.0", ATTEMPT_ID="a1", SECONDS=10),
        at("p2", 1, "first_open", "1.0"),
        at("p2", 1, "session_start", "1.0"),
        level("p2", 1, "Started", "1.0", ATTEMPT_ID="a2"),
        level("p2", 1, "Failed", "1.0", ATTEMPT_ID="a2", SECONDS=15),
        level("p2", 1, "Started", "1.0", ATTEMPT_ID="a3"),
        level("p2", 1, "Completed", "1.0", ATTEMPT_ID="a3", SECONDS=20),
        at("p3", 2, "first_open", "2.0"),
        at("p3", 2, "session_start", "2.0"),
        level("p3", 2, "Started", "2.0", ATTEMPT_ID="a4"),
        level("p3", 2, "Completed", "2.0", ATTEMPT_ID="a4", SECONDS=30),
    ]


@pytest.fixture
def game(tmp_path):
    settings = Settings(data_dir=tmp_path / "data", admin_token=TOKEN)
    with TestClient(create_app(settings, admin=True)) as admin:
        game = register(admin)
        with TestClient(create_app(settings)) as ingest:
            assert send(ingest, game, events_of_the_game()).status_code == 200
        yield admin, game, admin.app.state.storage


def test_setup_says_what_the_game_sends_and_which_tools_have_data(game):
    _, game, storage = game
    data = game_setup.setup(storage, game["id"], START, END)
    names = {item["name"]: item for item in data["events_sent"]}
    assert names["LEVEL_ANALYSIS"]["events"] == 8  # 4 started, 3 completed, 1 failed
    assert set(names["LEVEL_ANALYSIS"]["states"]) == {"Started", "Completed", "Failed"}
    assert "STATE" in names["LEVEL_ANALYSIS"]["parameters"]
    tools = data["tools_with_data"]
    assert tools["get_level_attempts"] is True and tools["get_onboarding"] is True
    assert tools["get_ad_revenue"] is False and tools["get_acquisition"] is False
    assert "get_ad_revenue" in data["tools_without_data"]
    assert [row["app_version"] for row in data["app_versions"]] == ["2.0", "1.0"]
    assert data["game"]["name"] == "Test Game"


def test_data_health_shows_arrival_lag_and_events_that_went_quiet(tmp_path):
    settings = Settings(data_dir=tmp_path / "data", admin_token=TOKEN)
    with TestClient(create_app(settings, admin=True)) as admin:
        game = register(admin)
        now = datetime.now(UTC) - timedelta(seconds=30)
        sent = [
            event(name="alive", params={}, client_ts=now.isoformat()),
            event(name="retired", params={}, client_ts=now.isoformat()),
        ]
        with TestClient(create_app(settings)) as ingest:
            assert send(ingest, game, sent).status_code == 200
        storage = admin.app.state.storage
        assert game_setup.data_health(storage, game["id"])["event_names_gone_quiet"] == []
        old = (datetime.now(UTC) - timedelta(days=6)).isoformat(timespec="microseconds")
        with storage.connect(storage.game_path(game["id"])) as connection:
            connection.execute("UPDATE events SET server_ts=? WHERE name='retired'", (old,))
            late = (datetime.now(UTC) - timedelta(hours=3)).isoformat(timespec="microseconds")
            connection.execute("UPDATE events SET client_ts=? WHERE name='alive'", (late,))
        data = game_setup.data_health(storage, game["id"])
        assert data["available"] is True
        assert data["event_names_gone_quiet"] == ["retired"]
        assert data["hours_since_newest_event"] < 1
        assert sum(day["events"] for day in data["days"]) == 2
        # "alive" reached the server three hours after it happened; "retired" did not
        assert data["lag_seconds"]["share_over_one_hour"] == 0.5
        assert sum(data["events_by_environment"].values()) == 2


def test_data_health_of_a_game_that_never_received_anything(tmp_path):
    settings = Settings(data_dir=tmp_path / "data", admin_token=TOKEN)
    with TestClient(create_app(settings, admin=True)) as admin:
        game = register(admin)
        data = game_setup.data_health(admin.app.state.storage, game["id"])
        assert data["available"] is False and "not received" in data["note"]


def test_guide_has_topics_and_a_tool_map():
    data = game_setup.guide()
    assert data["topic"] == "core" and "Players are keyed" in data["guide"]
    assert "get_ad_revenue" in data["tool_map"] and "release-check" in data["topics"]
    with pytest.raises(ValueError, match="topic"):
        game_setup.guide("../secrets")


def test_two_versions_side_by_side(game):
    _, game, storage = game
    data = compare.versions(storage, game["id"], START, END, Filters().model_dump(), "1.0", "2.0")
    rows = {row["metric"]: row for row in data["rows"]}
    assert rows["players"]["1.0"] == 2 and rows["players"]["2.0"] == 1
    assert rows["players"]["change"] == -1 and rows["players"]["change_percent"] == -50.0
    assert rows["new_players"]["1.0"] == 2 and rows["new_players"]["2.0"] == 1
    # 1.0: two completions and one failure; 2.0: one completion
    assert rows["level_completion_rate"]["1.0"] == round(2 / 3, 4)
    assert rows["level_completion_rate"]["2.0"] == 1.0
    assert rows["level_completion_rate"]["change"] == round(1.0 - round(2 / 3, 4), 4)
    assert rows["median_seconds_to_complete_a_level"]["1.0"] == 15.0
    assert rows["median_seconds_to_complete_a_level"]["2.0"] == 30.0
    # no ads, no launches: the game doesn't send them, so the answer is None, not zero
    for key in ("arpdau", "ads_load_success_rate", "problem_exit_rate"):
        assert rows[key]["1.0"] is None and "change" not in rows[key]
    assert set(data["retention"]) == {"1.0", "2.0"}
    nobody = compare.versions(storage, game["id"], START, END, Filters().model_dump(), "1.0", "9.9")
    assert "No players on 9.9" in nobody["note"]
    for bad in (("1.0", "1.0"), ("", "2.0")):
        with pytest.raises(ValueError, match="two different"):
            compare.versions(storage, game["id"], START, END, Filters().model_dump(), *bad)


def test_agents_use_the_extra_tools_through_a_key(game):
    admin, game, _ = game
    admin.post(
        f"/v1/games/{game['id']}/insights/funnels",
        headers=AUTH,
        json={
            "name": "Install to level",
            "steps": [{"event": "first_open"}, {"event": "LEVEL_ANALYSIS"}],
            "window_hours": 24,
        },
    ).raise_for_status()
    nutbot = admin.app.state.nutbot
    report = nutbot.reports.create(game["id"], "someone@example.org", "Level 1 is easy", "Body")
    made = admin.post(
        "/v1/mcp-keys", headers=AUTH, json={"name": "x", "game_ids": [game["id"]]}
    ).json()
    headers = {"Authorization": f"Bearer {made['secret']}"}

    def call(name, **arguments):
        reply = admin.post(
            "/mcp",
            headers=headers,
            json={
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {
                    "name": name,
                    "arguments": {
                        "game_id": game["id"],
                        "start": "2026-10-01",
                        "end": "2026-10-10",
                        **arguments,
                    },
                },
            },
        ).json()["result"]
        text = reply["content"][0]["text"]
        return reply["isError"], text if reply["isError"] else json.loads(text)

    error, data = call("get_game_setup")
    assert not error and data["tools_with_data"]["get_level_designs"] is True
    error, data = call("get_data_health", days=5)
    assert not error and data["available"] is True
    error, data = call("get_analysis_guide", topic="exits")
    assert not error and data["topic"] == "exits"
    error, text = call("get_analysis_guide", topic="nope")
    assert error and "topic" in text
    error, data = call("compare_versions", version_a="1.0", version_b="2.0")
    assert not error and data["versions"] == ["1.0", "2.0"]
    error, text = call("compare_versions", version_a="1.0")
    assert error
    error, data = call("list_saved", kind="funnels")
    assert not error and data["items"][0]["steps"] == ["first_open", "LEVEL_ANALYSIS"]
    assert data["items"][0]["name"] == "Install to level"
    error, data = call("list_saved", kind="reports")
    assert not error and data["items"][0]["title"] == "Level 1 is easy"
    assert "email" not in data["items"][0]  # who wrote it is not for outside readers
    error, data = call("get_report", report_id=report["id"])
    assert not error and data["body"] == "Body" and "email" not in data
    error, text = call("get_report", report_id="nope")
    assert error and "doesn't exist" in text
    error, text = call("list_saved", kind="chats")
    assert error and "kind is one of" in text
    for kind in ("groups", "highlights"):
        error, data = call("list_saved", kind=kind)
        assert not error and data["total"] == 0
