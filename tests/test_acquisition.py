"""Acquisition, player value by source and segments, checked against a small game by hand."""

import json
from datetime import date

import pytest
from fastapi.testclient import TestClient
from test_backend import AUTH, TOKEN, event, register, send

from avn_analytics import acquisition, ads, segments
from avn_analytics.api import create_app
from avn_analytics.config import Settings
from avn_analytics.exports import period_bounds
from avn_analytics.models import Filters
from avn_analytics.nutbot_base import ToolError

START, END = period_bounds("custom", date(2026, 10, 1), date(2026, 10, 10))


def at(device, day, name, hour=10, **params):
    return event(
        name=name,
        params=params,
        device_id=device,
        session_id=f"s-{device}-{day}",
        client_ts=f"2026-10-{day:02d}T{hour:02d}:00:00Z",
    )


def paid(device, day, amount):
    return at(
        device,
        day,
        "AD_ANALYSIS",
        hour=11,
        AD_ID=f"{device}-{day}-{amount}",
        FORMAT="Interstitial",
        PLACEMENT="level_interstitial",
        STATE="Revenue",
        NETWORK="AppLovin",
        REVENUE=amount,
    )


def installed(device, day, source, campaign, status="Non-organic"):
    params = {"STATE": "Install", "AF_STATUS": status, "MEDIA_SOURCE": source}
    if campaign:
        params |= {"CAMPAIGN": campaign, "CHANNEL": "unity", "AD": "Playable 1", "SITE_ID": "s1"}
    return at(device, day, "ATTRIBUTION_ANALYSIS", hour=9, **params)


def events_of_the_game():
    """Five players open the game in the range; the last event of the data is on day 10.

    u1 and u2 come from one campaign, u3 is organic, u4 has no attribution record and u5 opened
    only yesterday (its day 1 isn't over). u1 comes back on days 2 and 4, completes level 5, and
    clicks a store button.
    """
    return [
        at("u1", 1, "first_open"),
        installed("u1", 1, "unityads_int", "C1"),
        at("u1", 1, "LEVEL_ANALYSIS", STATE="Completed", LEVEL_NUMBER=5, BANNER_REVENUE=0.005),
        paid("u1", 1, 0.01),
        at("u1", 2, "session_start"),
        paid("u1", 2, 0.02),
        at("u1", 2, "IAP_ANALYSIS", STATE="Clicked", PRODUCT="coins"),
        at("u1", 4, "session_start"),
        at("u2", 1, "first_open"),
        installed("u2", 1, "unityads_int", "C1"),
        at("u2", 1, "LEVEL_ANALYSIS", STATE="Completed", LEVEL_NUMBER=2),
        paid("u2", 1, 0.03),
        at("u3", 1, "first_open"),
        installed("u3", 1, "organic", None, status="Organic"),
        paid("u3", 1, 0.04),
        at("u3", 2, "session_start"),
        at("u4", 1, "first_open"),
        at("u5", 9, "first_open"),
        installed("u5", 9, "unityads_int", "C2"),
        at("dummy", 10, "session_start"),
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


def test_installs_by_source_with_what_they_did_next(game):
    _, game, storage = game
    data = acquisition.acquisition(storage, game["id"], START, END, Filters().model_dump())
    assert data["installs"] == 5 and data["all"]["installs"] == 5
    sources = by(data["groups"])
    assert set(sources) == {"unityads_int", "organic", "Unattributed"}
    unity = sources["unityads_int"]
    assert unity["installs"] == 3 and unity["share_of_installs"] == 0.6
    # u1 and u2 are old enough for days 1, 3 and 7; u5 opened on day 9 and is left out
    assert unity["retention"]["day_1"] == {"eligible_players": 2, "returned": 1, "rate": 0.5}
    assert unity["retention"]["day_3"] == {"eligible_players": 2, "returned": 1, "rate": 0.5}
    assert unity["retention"]["day_7"] == {"eligible_players": 2, "returned": 0, "rate": 0.0}
    assert unity["completed_a_level_share"] == round(2 / 3, 4)
    assert unity["median_highest_level_completed"] == 3.5
    assert unity["clicked_a_store_button_share"] == round(1 / 3, 4)
    assert sources["organic"]["retention"]["day_1"]["rate"] == 1.0
    assert sources["organic"]["retention"]["day_3"]["rate"] == 0.0
    # no attribution record is not the same as organic
    assert sources["Unattributed"]["installs"] == 1
    assert sources["Unattributed"]["retention"]["day_1"]["rate"] == 0.0
    campaigns = by(
        acquisition.acquisition(
            storage, game["id"], START, END, Filters().model_dump(), "campaign"
        )["groups"]
    )
    assert campaigns["C1"]["installs"] == 2 and campaigns["C2"]["installs"] == 1
    assert campaigns["Unattributed"]["installs"] == 2  # organic has no campaign either


def test_cohort_is_the_first_opens_in_the_range(game):
    _, game, storage = game
    early = period_bounds("custom", date(2026, 10, 1), date(2026, 10, 2))
    data = acquisition.acquisition(storage, game["id"], *early, Filters().model_dump())
    assert data["installs"] == 4  # u5 opened on day 9
    nobody = period_bounds("custom", date(2026, 9, 1), date(2026, 9, 5))
    assert (
        "No player opened"
        in acquisition.acquisition(storage, game["id"], *nobody, Filters().model_dump())["note"]
    )
    with pytest.raises(ValueError, match="group_by"):
        acquisition.acquisition(storage, game["id"], START, END, Filters().model_dump(), "x")


def test_value_per_player_by_day_counts_only_players_old_enough(game):
    _, game, storage = game
    data = acquisition.ltv(storage, game["id"], START, END, Filters().model_dump())
    unity = by(data["groups"])["unityads_int"]["ltv"]
    # day 0: u1 earned 0.01 + a 0.005 banner, u2 0.03, u5 nothing yet
    assert unity["day_0"] == {"eligible_players": 3, "revenue_per_player": 0.015}
    assert unity["day_1"] == {"eligible_players": 2, "revenue_per_player": 0.0325}
    assert unity["day_3"]["revenue_per_player"] == 0.0325
    assert unity["day_14"] == {"eligible_players": 0, "revenue_per_player": None}
    assert by(data["groups"])["organic"]["ltv"]["day_0"]["revenue_per_player"] == 0.04
    assert data["all"]["ltv"]["day_0"] == {"eligible_players": 5, "revenue_per_player": 0.017}
    custom = acquisition.ltv(storage, game["id"], START, END, Filters().model_dump(), days=[2, 0])
    assert list(custom["all"]["ltv"]) == ["day_0", "day_2"]
    with pytest.raises(ValueError, match="days"):
        acquisition.ltv(storage, game["id"], START, END, Filters().model_dump(), days=[200])


def test_a_game_without_attribution_gets_a_sentence(tmp_path):
    settings = Settings(data_dir=tmp_path / "data", admin_token=TOKEN)
    with TestClient(create_app(settings, admin=True)) as admin:
        game = register(admin)
        with TestClient(create_app(settings)) as ingest:
            assert send(ingest, game, [event(name="first_open", params={})]).status_code == 200
        storage = admin.app.state.storage
        for read in (acquisition.acquisition, acquisition.ltv):
            data = read(storage, game["id"], START, END, Filters().model_dump())
            assert data["available"] is False and "sends no attribution" in data["note"]


# ---- segments


def test_a_segment_keeps_only_those_players_in_ads_and_acquisition(game):
    _, game, storage = game
    everyone = ads.revenue(storage, game["id"], START, END, Filters().model_dump())
    assert everyone["full_screen"]["revenue"] == 0.1
    unity = {
        **Filters().model_dump(),
        "segments": segments.parse({"media_source": ["unityads_int"]}),
    }
    assert ads.revenue(storage, game["id"], START, END, unity)["full_screen"]["revenue"] == 0.06
    organic = {
        **Filters().model_dump(),
        "segments": segments.parse({"attribution_status": ["Organic"]}),
    }
    assert ads.revenue(storage, game["id"], START, END, organic)["full_screen"]["revenue"] == 0.04
    # a player who clicked a store button (any event, any time)
    clicked = {
        **Filters().model_dump(),
        "segments": segments.parse({"event_param": {"event": "IAP_ANALYSIS"}}),
    }
    assert ads.revenue(storage, game["id"], START, END, clicked)["full_screen"]["revenue"] == 0.03
    # players with no attribution record: none of them earned anything
    nobody = {**Filters().model_dump(), "segments": segments.parse({"unattributed": True})}
    assert ads.revenue(storage, game["id"], START, END, nobody)["available"] is False
    unattributed = acquisition.acquisition(storage, game["id"], START, END, nobody)
    assert unattributed["installs"] == 1  # u4; the dummy never opened the game for the first time
    both = {
        **Filters().model_dump(),
        "segments": segments.parse({"media_source": ["unityads_int"], "campaign": ["C2"]}),
    }
    assert acquisition.acquisition(storage, game["id"], START, END, both)["installs"] == 1


def test_segments_only_accept_plain_names_and_known_keys():
    assert segments.parse(None) == [] and segments.parse({}) == []
    assert segments.parse({"channel": ["unity"]}) == [
        {"event": "ATTRIBUTION_ANALYSIS", "param": "CHANNEL", "values": ["unity"]}
    ]
    for bad in (
        {"bogus": ["x"]},
        {"campaign": []},
        {"campaign": "C1"},
        {"event_param": {"event": "bad name"}},
        {"event_param": {"event": "A", "param": "B; DROP TABLE events", "values": ["x"]}},
        {"event_param": {"event": "A", "param": "B"}},
        "media_source",
    ):
        with pytest.raises(ToolError):
            segments.parse(bad)


def test_agents_can_ask_for_a_segment_through_the_key(game):
    admin, game, _ = game
    made = admin.post(
        "/v1/mcp-keys", headers=AUTH, json={"name": "acq", "game_ids": [game["id"]]}
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
        return reply["isError"], json.loads(reply["content"][0]["text"]) if not reply[
            "isError"
        ] else reply["content"][0]["text"]

    error, data = call("get_acquisition")
    assert not error and data["installs"] == 5
    error, data = call("get_ltv", group_by="campaign", days=[0])
    assert not error and by(data["groups"])["C1"]["ltv"]["day_0"]["eligible_players"] == 2
    error, data = call("get_ad_revenue", segment={"media_source": ["unityads_int"]})
    assert not error and data["full_screen"]["revenue"] == 0.06
    error, text = call("get_acquisition", segment={"bogus": ["x"]})
    assert error and "Unknown segment key" in text
    listed = admin.post(
        "/mcp", headers=headers, json={"jsonrpc": "2.0", "id": 2, "method": "tools/list"}
    ).json()["result"]["tools"]
    with_segment = {t["name"] for t in listed if "segment" in t["inputSchema"]["properties"]}
    # only tools whose every read goes through insights.where may offer a segment
    assert with_segment == {
        "get_acquisition",
        "get_ltv",
        "get_ad_revenue",
        "get_ad_health",
        "get_ad_serving",
        "get_ad_impact",
        "get_stability",
        "get_economy",
        "get_onboarding",
        "get_store",
        "get_level_attempts",
        "get_level_designs",
        "count_events",
    }
