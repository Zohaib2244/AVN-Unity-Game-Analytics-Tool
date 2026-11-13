"""Ad revenue, ad health and ad serving, checked against a small game worked out by hand."""

import json
from datetime import date

import pytest
from fastapi.testclient import TestClient
from test_backend import AUTH, TOKEN, event, register, send

from avn_analytics import ads
from avn_analytics.api import create_app
from avn_analytics.config import Settings
from avn_analytics.exports import period_bounds
from avn_analytics.models import Filters

START, END = period_bounds("custom", date(2026, 10, 1), date(2026, 10, 5))


def ad(device, minute, second, **params):
    return event(
        name="AD_ANALYSIS",
        params=params,
        device_id=device,
        session_id=f"s-{device}",
        client_ts=f"2026-10-04T10:{minute:02d}:{second:02d}Z",
    )


def health(device, minute, **params):
    return event(
        name="AD_HEALTH_ANALYSIS",
        params={"STATE": "Snapshot", **params},
        device_id=device,
        session_id=f"s-{device}",
        client_ts=f"2026-10-04T10:{minute:02d}:00Z",
    )


COUNTERS = dict.fromkeys(
    (
        "LOAD_REQUESTS",
        "LOADED",
        "LOAD_FAILED",
        "REQUESTS",
        "NOT_READY",
        "BLOCKED",
        "SHOW_CALLS",
        "SHOW_CALLS_FAILED",
        "DISPLAYED",
        "IMPRESSIONS",
        "RECOVERED",
        "TIMEOUTS",
    ),
    0,
)


def inter(ad_id, state, **more):
    return {
        "AD_ID": ad_id,
        "FORMAT": "Interstitial",
        "PLACEMENT": "level_interstitial",
        "STATE": state,
        **more,
    }


def rewarded(ad_id, placement, state, **more):
    return {"AD_ID": ad_id, "FORMAT": "Rewarded", "PLACEMENT": placement, "STATE": state, **more}


def events_of_the_game():
    """Player a earns on three ads and is held back once; player b has a show nobody paid for."""
    paid = {"NETWORK": "AppLovin", "AD_UNIT": "u1", "PRECISION": "exact"}
    return [
        ad("a", 0, 0, **inter("ad1", "Show")),
        ad("a", 0, 30, **inter("ad1", "Closed", SECONDS_ON_SCREEN=30.0)),
        ad("a", 0, 31, **inter("ad1", "Revenue", REVENUE=0.004, **paid)),
        ad("a", 2, 0, **inter("ad2", "Show")),
        ad("a", 2, 20, **inter("ad2", "Closed", SECONDS_ON_SCREEN=20.0)),
        ad(
            "a", 2, 21, **inter("ad2", "Revenue", REVENUE=0.002, **{**paid, "NETWORK": "Unity Ads"})
        ),
        ad("a", 5, 0, **rewarded("ad3", "level_fail_revive", "Show")),
        ad(
            "a",
            5,
            40,
            **rewarded("ad3", "level_fail_revive", "Closed", SECONDS_ON_SCREEN=40.0, REWARDED=1),
        ),
        ad("a", 5, 41, **rewarded("ad3", "level_fail_revive", "Revenue", REVENUE=0.01, **paid)),
        ad("a", 7, 0, **inter("ad4", "Blocked", REASON="Cooldown")),
        ad("b", 0, 0, **inter("ad5", "Show")),
        ad("b", 0, 10, **inter("ad5", "Closed", SECONDS_ON_SCREEN=10.0)),
        ad("b", 3, 0, **rewarded("ad6", "level_complete_x2", "Failed", REASON="NotReady")),
        ad("b", 4, 0, **rewarded("ad7", "level_complete_x2", "Show")),
        ad(
            "b",
            4,
            30,
            **rewarded("ad7", "level_complete_x2", "Closed", SECONDS_ON_SCREEN=30.0, REWARDED=0),
        ),
        ad(
            "b",
            4,
            31,
            **rewarded(
                "ad7",
                "level_complete_x2",
                "Revenue",
                REVENUE=0.006,
                **{**paid, "NETWORK": "Unity Ads"},
            ),
        ),
        event(
            name="LEVEL_ANALYSIS",
            params={
                "STATE": "Completed",
                "LEVEL_NUMBER": 1,
                "BANNER_IMPRESSIONS": 3,
                "BANNER_REVENUE": 0.001,
            },
            device_id="a",
            session_id="s-a",
            client_ts="2026-10-04T10:08:00Z",
        ),
        health(
            "a",
            1,
            **{
                **COUNTERS,
                "FORMAT": "Interstitial",
                "LOAD_REQUESTS": 4,
                "LOADED": 3,
                "LOAD_FAILED": 1,
                "REQUESTS": 2,
                "BLOCKED": 1,
                "SHOW_CALLS": 2,
                "DISPLAYED": 2,
                "IMPRESSIONS": 2,
                "LAST_LOAD_ERROR": "Interstitial load failed: NoFill",
            },
        ),
        health(
            "b",
            1,
            **{
                **COUNTERS,
                "FORMAT": "Interstitial",
                "LOAD_REQUESTS": 6,
                "LOADED": 3,
                "LOAD_FAILED": 3,
                "REQUESTS": 1,
                "SHOW_CALLS": 1,
                "SHOW_CALLS_FAILED": 1,
                "LAST_LOAD_ERROR": "Interstitial load failed: NoFill",
            },
        ),
        health(
            "b",
            2,
            **{
                **COUNTERS,
                "FORMAT": "Rewarded",
                "LOAD_REQUESTS": 2,
                "LOADED": 2,
                "REQUESTS": 2,
                "NOT_READY": 1,
                "SHOW_CALLS": 1,
                "DISPLAYED": 1,
                "IMPRESSIONS": 1,
            },
        ),
    ]


@pytest.fixture
def game(tmp_path):
    settings = Settings(data_dir=tmp_path / "data", admin_token=TOKEN)
    with TestClient(create_app(settings, admin=True)) as admin:
        game = register(admin)
        with TestClient(create_app(settings)) as ingest:
            assert send(ingest, game, events_of_the_game()).status_code == 200
        yield admin, game, admin.app.state.storage


def by(groups):
    return {row["value"]: row for row in groups}


def test_revenue_adds_up_by_format_and_network(game):
    _, game, storage = game
    data = ads.revenue(storage, game["id"], START, END, Filters().model_dump())
    assert data["available"] is True
    assert data["full_screen"] == {
        "impressions": 4,
        "revenue": 0.022,
        "ecpm": 5.5,
        "players_paid_for": 2,
    }
    assert data["banner"]["impressions"] == 3 and data["banner"]["revenue"] == 0.001
    assert data["total_revenue"] == 0.023
    assert data["active_players"] == 2
    assert data["revenue_per_active_player"] == 0.0115 and data["arpdau"] == 0.0115
    # five ads started, four of them have a revenue report
    assert data["ads_shown"] == 5 and data["ads_shown_with_revenue_reported"] == 4
    assert data["share_of_shows_with_revenue"] == 0.8
    formats = by(data["groups"])
    assert (
        formats["Interstitial"]["impressions"] == 2 and formats["Interstitial"]["revenue"] == 0.006
    )
    assert formats["Interstitial"]["ecpm"] == 3.0 and formats["Rewarded"]["ecpm"] == 8.0
    assert round(sum(g["share_of_full_screen_revenue"] for g in data["groups"]), 3) == 1.0
    networks = by(
        ads.revenue(storage, game["id"], START, END, Filters().model_dump(), "network")["groups"]
    )
    assert networks["AppLovin"]["revenue"] == 0.014 and networks["Unity Ads"]["revenue"] == 0.008
    days = ads.revenue(storage, game["id"], START, END, Filters().model_dump(), "day")["groups"]
    assert [row["value"] for row in days] == ["2026-10-04"]


def test_revenue_respects_filters_and_says_when_there_is_nothing(game):
    _, game, storage = game
    only_b = Filters(app_versions=["nope"]).model_dump()
    assert ads.revenue(storage, game["id"], START, END, only_b)["available"] is False
    elsewhere = period_bounds("custom", date(2026, 1, 1), date(2026, 1, 5))
    assert (
        "No ad events"
        in ads.revenue(storage, game["id"], *elsewhere, Filters().model_dump())["note"]
    )
    with pytest.raises(ValueError, match="group_by"):
        ads.revenue(storage, game["id"], START, END, Filters().model_dump(), "player")


def test_health_sums_the_snapshots_and_names_the_errors(game):
    _, game, storage = game
    data = ads.health(storage, game["id"], START, END, Filters().model_dump())
    assert data["total"]["snapshots"] == 3 and data["total"]["load_requests"] == 12
    formats = by(data["groups"])
    interstitial = formats["Interstitial"]
    assert interstitial["snapshots"] == 2 and interstitial["players"] == 2
    assert interstitial["load_requests"] == 10 and interstitial["loaded"] == 6
    assert interstitial["load_failed"] == 4 and interstitial["load_success_rate"] == 0.6
    assert interstitial["load_failure_rate"] == 0.4
    assert interstitial["ad_requests"] == 3 and interstitial["blocked_by_game_rules"] == 1
    assert interstitial["show_calls"] == 3 and interstitial["show_calls_failed"] == 1
    assert interstitial["displayed_per_show_call"] == round(2 / 3, 4)
    assert formats["Rewarded"]["not_ready_rate"] == 0.5
    assert data["last_load_errors"] == [
        {
            "error": "Interstitial load failed: NoFill",
            "format": "Interstitial",
            "snapshots": 2,
            "players": 2,
        }
    ]


def test_serving_says_what_was_wanted_shown_held_back_and_why(game):
    _, game, storage = game
    data = ads.serving(storage, game["id"], START, END, Filters().model_dump())
    places = by(data["groups"])
    interstitial = places["level_interstitial"]
    assert interstitial["wanted"] == 4 and interstitial["shown"] == 3
    assert interstitial["shown_share"] == 0.75
    assert interstitial["blocked"] == 1 and interstitial["blocked_by"] == {"Cooldown": 1}
    assert interstitial["failed"] == 0 and interstitial["closed"] == 3
    assert interstitial["with_revenue"] == 2 and interstitial["reward_given_share"] is None
    assert interstitial["average_seconds_on_screen"] == 20.0
    double = places["level_complete_x2"]
    assert double["wanted"] == 2 and double["shown"] == 1
    assert double["failed_by"] == {"NotReady": 1} and double["reward_given_share"] == 0.0
    assert places["level_fail_revive"]["reward_given_share"] == 1.0
    pacing = data["pacing"]
    assert pacing["sessions"] == 2 and pacing["ads_shown_per_session"] == 2.5
    assert pacing["interstitials_in_same_session_gaps"] == 1
    assert pacing["median_seconds_between_interstitials"] == 120.0
    kinds = by(
        ads.serving(storage, game["id"], START, END, Filters().model_dump(), "format")["groups"]
    )
    assert kinds["Rewarded"]["wanted"] == 3


def test_a_game_without_ad_events_gets_a_sentence_not_zeros(tmp_path):
    settings = Settings(data_dir=tmp_path / "data", admin_token=TOKEN)
    with TestClient(create_app(settings, admin=True)) as admin:
        game = register(admin)
        with TestClient(create_app(settings)) as ingest:
            assert send(ingest, game, [event()]).status_code == 200
        storage = admin.app.state.storage
        for read in (ads.revenue, ads.health, ads.serving):
            data = read(storage, game["id"], START, END, Filters().model_dump())
            assert data["available"] is False and "may not send" in data["note"]


def test_the_ad_tools_are_served_to_agents_with_a_key(game):
    admin, game, _ = game
    made = admin.post(
        "/v1/mcp-keys", headers=AUTH, json={"name": "ads", "game_ids": [game["id"]]}
    ).json()
    headers = {"Authorization": f"Bearer {made['secret']}"}
    listed = admin.post(
        "/mcp", headers=headers, json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"}
    ).json()["result"]["tools"]
    assert {"get_ad_revenue", "get_ad_health", "get_ad_serving"} <= {t["name"] for t in listed}
    for name in ("get_ad_revenue", "get_ad_health", "get_ad_serving"):
        reply = admin.post(
            "/mcp",
            headers=headers,
            json={
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {
                    "name": name,
                    "arguments": {
                        "game_id": game["id"],
                        "start": "2026-10-01",
                        "end": "2026-10-05",
                    },
                },
            },
        ).json()["result"]
        assert reply["isError"] is False
        assert json.loads(reply["content"][0]["text"])["available"] is True
    reply = admin.post(
        "/mcp",
        headers=headers,
        json={
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {
                "name": "get_ad_revenue",
                "arguments": {"game_id": game["id"], "group_by": "player"},
            },
        },
    ).json()["result"]
    assert reply["isError"] is True and "group_by" in reply["content"][0]["text"]


def test_load_success_rate_stays_a_share_when_loads_were_not_all_requested():
    """Real plugins count refreshes and preloads as loaded without a request (seen: 28.7k loaded
    against 13.7k requests), so the rate is loaded / (loaded + failed), never above 1."""
    row = dict.fromkeys(ads.HEALTH_COUNTERS, 0) | {
        "snapshots": 1,
        "players": 1,
        "load_requests": 1,
        "loaded": 3,
        "load_failed": 1,
    }
    shown = ads._health_row(row)
    assert shown["load_success_rate"] == 0.75 and shown["load_failure_rate"] == 0.25


@pytest.fixture
def failing_game(tmp_path):
    """The small game plus load failures: two phones with no internet (events sent minutes late)."""
    settings = Settings(data_dir=tmp_path / "data", admin_token=TOKEN)
    extra = []
    for device, second in (("a", 10), ("a", 20), ("b", 30)):
        sent = ad(
            device,
            9,
            second,
            AD_ID=f"load-{device}-{second}",
            FORMAT="Interstitial",
            AD_UNIT="unit-1",
            STATE="LoadFailed",
            LOAD_MS=2000,
            LEVEL_NUMBER=7,
            ERROR="NetworkError: Unable to resolve host",
        )
        sent["client_ts"] = f"2026-10-04T09:{second:02d}:00Z"  # made long before it arrived
        extra.append(sent)
    with TestClient(create_app(settings, admin=True)) as admin:
        game = register(admin)
        with TestClient(create_app(settings)) as ingest:
            assert send(ingest, game, [*events_of_the_game(), *extra]).status_code == 200
        yield admin, game, admin.app.state.storage


def test_ad_states_count_every_state_per_format(game):
    _, game, storage = game
    from avn_analytics import ad_report

    data = ad_report.states(storage, game["id"], START, END, Filters().model_dump())
    rows = {row["format"]: row for row in data["formats"]}
    assert rows["Interstitial"]["asked"] == 3 and rows["Interstitial"]["shown"] == 3
    assert rows["Interstitial"]["blocked"] == 1 and rows["Interstitial"]["revenue"] == 0.006
    assert rows["Rewarded"]["asked"] == 2 and rows["Rewarded"]["show_failed"] == 1
    assert rows["Rewarded"]["revenue"] == 0.016
    assert data["total"]["asked"] == 5 and data["total"]["shown_share"] == 1.0


def test_ad_states_for_one_player_leave_the_others_out(game):
    _, game, storage = game
    from avn_analytics import ad_report

    data = ad_report.states(storage, game["id"], START, END, Filters().model_dump(), "b")
    rows = {row["format"]: row for row in data["formats"]}
    assert rows["Interstitial"]["asked"] == 1 and rows["Interstitial"]["blocked"] == 0
    assert rows["Rewarded"]["show_failed"] == 1 and rows["Rewarded"]["revenue"] == 0.006
    assert ads.revenue(storage, game["id"], START, END, Filters().model_dump(), player="b")[
        "groups"
    ]


def test_every_failure_is_listed_with_its_kind_and_players(failing_game):
    _, game, storage = failing_game
    from avn_analytics import ad_report

    data = ad_report.failures(storage, game["id"], START, END, Filters().model_dump())
    listed = {(row["format"], row["kind"], row["reason"]): row for row in data["rows"]}
    network = listed[("Interstitial", "load_failed", "NetworkError: Unable to resolve host")]
    assert network["times"] == 3 and network["players"] == 2 and network["late"] == 3
    assert listed[("Interstitial", "blocked", "Cooldown")]["times"] == 1
    assert listed[("Rewarded", "show_failed", "NotReady")]["players"] == 1
    assert [row["times"] for row in data["rows"]] == sorted(
        (row["times"] for row in data["rows"]), reverse=True
    )
    mine = ad_report.failures(storage, game["id"], START, END, Filters().model_dump(), "b")
    assert {row["kind"] for row in mine["rows"]} == {"load_failed", "show_failed"}


def test_one_failure_in_detail_says_when_where_and_whether_it_arrived_late(failing_game):
    _, game, storage = failing_game
    from avn_analytics import ad_report

    reason = "NetworkError: Unable to resolve host"
    detail = ad_report.failure(
        storage,
        game["id"],
        START,
        END,
        Filters().model_dump(),
        "Interstitial",
        "load_failed",
        reason,
    )
    assert detail["times"] == 3 and detail["players"] == 2
    assert detail["late_share"] == 1.0 and detail["load_seconds"] == 2.0
    # the test events were all made days before they were sent, so everything is "late" here
    assert detail["late_baseline"] == 1.0
    assert detail["level_low"] == 7 == detail["level_high"] == detail["level_median"]
    assert detail["ad_units"][0]["value"] == "unit-1" and detail["ad_units"][0]["times"] == 3
    assert (
        detail["when"]["unit"] == "hour" and sum(p["times"] for p in detail["when"]["points"]) == 3
    )
    assert [row["value"] for row in detail["top_players"]][0] == "a"
    assert len(detail["latest"]) == 3 and detail["latest"][0]["sent_after_seconds"] > 3600
    gone = ad_report.failure(
        storage, game["id"], START, END, Filters().model_dump(), "Banner", "blocked", "Nope"
    )
    assert gone["available"] is False
    with pytest.raises(ValueError):
        ad_report.failure(
            storage, game["id"], START, END, Filters().model_dump(), "x", "weird", "y"
        )
