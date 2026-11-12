"""Campaign cost, return by install source and day, install-day cohorts, goals, and the ad reads
behind the Ads page, checked against a small game by hand. The cost endpoint is replaced by a stub.
"""

import json
from datetime import UTC, date, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from test_acquisition import at, installed, paid
from test_backend import AUTH, TOKEN, register, send

from avn_analytics import acquisition_report, ads, costs
from avn_analytics.api import create_app
from avn_analytics.config import Settings
from avn_analytics.exports import period_bounds
from avn_analytics.models import Filters

START, END = period_bounds("custom", date(2026, 10, 1), date(2026, 10, 10))
FIRST, LAST = date(2026, 10, 1), date(2026, 10, 10)
NOW = datetime(2026, 10, 11, 12, tzinfo=UTC)
COST_ROWS = [
    {"date": "2026-10-01", "appId": "com.example.game", "network": "unityads_int",
     "campaign": "C1", "cost": 10.0, "installs": 4},
    {"date": "2026-10-01", "appId": "com.example.game", "network": "Organic",
     "campaign": "None", "cost": 0, "installs": 3},
    {"date": "2026-10-09", "appId": "com.example.game", "network": "unityads_int",
     "campaign": "C2", "cost": 6.0, "installs": 2},
]  # fmt: skip


def events_of_the_game():
    """u1 and u2 install from C1 on day 1 and earn 0.035 and 0.03 by day 1; u3 is organic; u4
    has no install record; u6 clicked an ad weeks before the game's first data, so it is an
    existing player who updated, not an install; u5 installs from C2 on day 9."""
    return [
        at("u1", 1, "first_open"),
        installed("u1", 1, "unityads_int", "C1"),
        at("u1", 1, "LEVEL_ANALYSIS", STATE="Completed", LEVEL_NUMBER=5, BANNER_REVENUE=0.005),
        paid("u1", 1, 0.01),
        at("u1", 2, "session_start"),
        paid("u1", 2, 0.02),
        at("u2", 1, "first_open"),
        installed("u2", 1, "unityads_int", "C1"),
        paid("u2", 1, 0.03),
        at("u3", 1, "first_open"),
        installed("u3", 1, "organic", None, status="Organic"),
        at("u4", 1, "first_open"),
        at("u6", 2, "first_open"),
        at(
            "u6", 2, "ATTRIBUTION_ANALYSIS", hour=9, STATE="Install", AF_STATUS="Non-organic",
            MEDIA_SOURCE="unityads_int", CAMPAIGN="C1", CLICK_TIME="2026-09-01 10:00:00.000",
        ),
        paid("u6", 2, 5.0),
        at("u5", 9, "first_open"),
        installed("u5", 9, "unityads_int", "C2"),
        at("dummy", 10, "session_start"),
    ]  # fmt: skip


@pytest.fixture
def game(tmp_path, monkeypatch):
    calls = []

    def fetch(url, app_id, first_day, last_day):
        calls.append((app_id, first_day, last_day))
        return [row for row in COST_ROWS if first_day <= row["date"] <= last_day]

    monkeypatch.setattr(costs, "fetch", fetch)
    settings = Settings(
        data_dir=tmp_path / "data", admin_token=TOKEN, cost_api_url="https://cost.example/api"
    )
    with TestClient(create_app(settings, admin=True)) as admin:
        created = register(admin)
        with TestClient(create_app(settings)) as ingest:
            assert send(ingest, created, events_of_the_game()).status_code == 200
        storage = admin.app.state.storage
        yield admin, storage.get_game(created["id"]), storage, calls


def by(rows):
    return {row["value"]: row for row in rows}


def test_costs_are_fetched_once_kept_and_only_paid_rows_are_served(game):
    _, game, storage, calls = game
    state = costs.ensure(storage, game, FIRST, LAST, now=NOW)
    assert state["state"] == "ok" and state["app_id"] == game["bundle_id"]
    assert costs.ensure(storage, game, FIRST, LAST, now=NOW + timedelta(hours=1))["state"] == "ok"
    assert len(calls) == 1  # still fresh: not asked again
    costs.ensure(storage, game, FIRST, LAST, now=NOW + timedelta(hours=4))
    assert len(calls) == 2  # older than REFRESH_SECONDS
    kept = costs.rows(storage, game, FIRST, LAST)
    assert {(row["campaign"], row["cost"]) for row in kept} == {("C1", 10.0), ("C2", 6.0)}


def test_an_app_the_endpoint_refuses_or_a_failure_says_so_and_keeps_old_rows(game, monkeypatch):
    _, game, storage, _ = game
    costs.ensure(storage, game, FIRST, LAST, now=NOW)

    def broken(*_):
        raise TimeoutError("timed out")

    monkeypatch.setattr(costs, "fetch", broken)
    later = NOW + timedelta(days=1)
    failed = costs.ensure(storage, game, FIRST, LAST, now=later)
    assert failed["state"] == "failed" and "timed out" in failed["detail"]
    assert len(costs.rows(storage, game, FIRST, LAST)) == 2  # yesterday's rows are still served

    def refuse(*_):
        raise costs.Refused("app")

    monkeypatch.setattr(costs, "fetch", refuse)
    assert costs.ensure(storage, game, FIRST, LAST, now=later + timedelta(hours=1))["state"] == (
        "not_allowed"
    )


def test_without_an_endpoint_or_an_ios_store_id_cost_is_off(tmp_path):
    settings = Settings(data_dir=tmp_path / "data", admin_token=TOKEN)
    with TestClient(create_app(settings, admin=True)) as admin:
        storage = admin.app.state.storage
        game = storage.get_game(register(admin)["id"])
        assert costs.ensure(storage, game, FIRST, LAST)["state"] == "off"
    ios = {"id": "g", "bundle_id": "com.example.game", "platform": "ios"}
    assert costs.default_app_id(ios) == ""


def test_return_divides_value_per_player_seen_by_the_services_cost_per_install(game):
    _, game, storage, _ = game
    data = acquisition_report.report(
        storage, game["id"], START, END, Filters().model_dump(), FIRST, LAST
    )
    assert data["cost"]["state"] == "ok"
    assert data["updated_players_left_out"] == 1  # u6 updated; its $5 never counts
    rows = by(data["rows"])
    assert set(rows) == {"C1", "C2", "Organic", "No install record"}
    c1 = rows["C1"]
    assert c1["installs"] == 2 and c1["service_installs"] == 4 and c1["seen_share"] == 0.5
    assert c1["cost"] == 10.0 and c1["cost_per_install"] == 2.5
    # by day 1: u1 earned 0.035 (with its banner) and u2 0.03, so 0.0325 each
    assert c1["value_per_install"]["day_1"] == {"players": 2, "per_player": 0.0325}
    assert c1["return"]["day_1"] == round(0.0325 / 2.5, 4)
    assert rows["C2"]["value_per_install"]["day_1"]["players"] == 0  # day 1 isn't over yet
    assert rows["Organic"]["cost"] is None and rows["Organic"]["paid"] is False
    assert data["all_paid"]["cost"] == 16.0 and data["all_paid"]["service_installs"] == 6


def test_cohorts_give_each_install_day_and_revenue_by_calendar_day(game):
    _, game, storage, _ = game
    data = acquisition_report.cohorts(
        storage, game["id"], START, END, Filters().model_dump(), FIRST, LAST, "C1"
    )
    days = {row["day"]: row for row in data["days"]}
    assert list(days) == ["2026-10-01"]
    first = days["2026-10-01"]
    assert first["installs"] == 2 and first["cost_per_install"] == 2.5 and first["final"]
    calendar = {row["day"]: row for row in data["by_calendar_day"]}
    assert calendar["2026-10-01"] == {"day": "2026-10-01", "revenue": 0.045, "cost": 10.0}
    assert calendar["2026-10-02"]["revenue"] == 0.02
    assert set(data["campaigns"]) == {"C1", "C2"}
    newest = acquisition_report.cohorts(
        storage, game["id"], START, END, Filters().model_dump(), FIRST, LAST, "C2"
    )
    assert newest["days"][0]["final"] is False  # the service's newest days may still grow


def test_goals_keep_one_list_per_campaign_that_replaces_the_games(game):
    admin, game, storage, _ = game
    goals = {
        "game": [{"day": 7, "percent": 75}, {"day": 3, "percent": 40}],
        "campaigns": {"C1": [{"day": 7, "percent": 90}]},
    }
    answer = admin.put(f"/v1/games/{game['id']}/cost-settings", headers=AUTH, json={"goals": goals})
    assert answer.status_code == 200, answer.text
    saved = answer.json()["goals"]
    assert saved["game"] == [{"day": 3, "percent": 40.0}, {"day": 7, "percent": 75.0}]
    assert costs.goals_for(saved, "C1") == [{"day": 7, "percent": 90.0}]
    assert costs.goals_for(saved, "C2") == saved["game"]
    bad = admin.put(
        f"/v1/games/{game['id']}/cost-settings",
        headers=AUTH,
        json={"goals": {"game": [{"day": 400, "percent": 75}]}},
    )
    assert bad.status_code == 400
    ios_id = admin.put(
        f"/v1/games/{game['id']}/cost-settings", headers=AUTH, json={"app_id": "id123"}
    ).json()
    assert ios_id["app_id"] == "id123" and ios_id["goals"] == saved


def test_the_install_source_filter_narrows_the_ad_pages(game):
    admin, game, _, _ = game
    url = f"/v1/games/{game['id']}/insights/ads/revenue"
    days = {"start": "2026-10-01", "end": "2026-10-10"}
    everyone = admin.get(url, headers=AUTH, params=days).json()
    c1 = admin.get(url, headers=AUTH, params={**days, "campaign": "C1"}).json()
    none = admin.get(url, headers=AUTH, params={**days, "no_install_record": "true"}).json()
    assert everyone["full_screen"]["revenue"] == 5.06
    assert c1["full_screen"]["revenue"] == 5.06  # u6 is a C1 player too, whatever its click
    assert none["available"] is False  # u4 saw no ad
    bad = admin.get(url, headers=AUTH, params={**days, "group_by": "colour"})
    assert bad.status_code == 400


def test_revenue_splits_each_group_once_more(game):
    _, game, storage, _ = game
    data = ads.revenue(
        storage, game["id"], START, END, Filters().model_dump(), "network", then_by="format"
    )
    applovin = by(data["groups"])["AppLovin"]
    assert data["then_values"] == ["Interstitial"]
    assert applovin["split"]["Interstitial"]["impressions"] == 4


def test_creatives_players_leave_on_are_judged_against_the_usual_share(tmp_path):
    settings = Settings(data_dir=tmp_path / "data", admin_token=TOKEN)
    sent = []
    for index in range(40):  # creative "bad": nobody plays on; "fine": everybody does
        for creative, plays_on in (("bad", False), ("fine", True)):
            device = f"{creative}{index}"
            ad = {"AD_ID": f"{device}-ad", "FORMAT": "Interstitial", "NETWORK": "Unity Ads"}
            sent += [
                at(device, 1, "LEVEL_ANALYSIS", hour=10, STATE="Completed", LEVEL_NUMBER=1),
                at(device, 1, "AD_ANALYSIS", hour=11, STATE="Show", **ad),
                at(device, 1, "AD_ANALYSIS", hour=12, STATE="Revenue", CREATIVE_ID=creative, **ad),
            ]
            if plays_on:
                sent.append(at(device, 1, "LEVEL_ANALYSIS", hour=13, STATE="Started"))
    with TestClient(create_app(settings, admin=True)) as admin:
        game = register(admin)
        with TestClient(create_app(settings)) as ingest:
            for chunk in range(0, len(sent), 200):
                assert send(ingest, game, sent[chunk : chunk + 200]).status_code == 200
        data = ads.creatives(
            admin.app.state.storage, game["id"], START, END, Filters().model_dump()
        )
    assert data["usual_share"] == 0.5 and data["creatives_judged"] == 2
    rows = {row["creative"]: row for row in data["rows"]}
    assert rows["bad"]["left_share"] == 1.0 and rows["fine"]["left_share"] == 0.0
    assert data["rows"][0]["creative"] == "bad"


def test_delivery_reports_load_times_only_where_the_plugin_sends_them(tmp_path):
    settings = Settings(data_dir=tmp_path / "data", admin_token=TOKEN)
    loads = [
        at("p1", 1, "AD_ANALYSIS", hour=10, STATE="Loaded", FORMAT="Interstitial",
           AD_ID=f"a{ms}", LOAD_MS=ms)
        for ms in (100, 200, 300, 400, 1000)
    ] + [
        at("p1", 1, "AD_ANALYSIS", hour=11, STATE="LoadFailed", FORMAT="Banner", AD_ID="b1",
           ERROR="NoFill"),
        at("p1", 1, "AD_ANALYSIS", hour=12, STATE="Show", FORMAT="Interstitial", AD_ID="a100"),
    ]  # fmt: skip
    with TestClient(create_app(settings, admin=True)) as admin:
        game = register(admin)
        with TestClient(create_app(settings)) as ingest:
            assert send(ingest, game, loads).status_code == 200
        data = ads.delivery(admin.app.state.storage, game["id"], START, END, Filters().model_dump())
    assert data["load_times_sent"] is True
    assert data["load_times"]["Interstitial"]["median_ms"] == 300
    assert data["load_failures"][0]["error"] == "NoFill"
    # loads are not ads the game asked to show
    wanted = {row["value"]: row["wanted"] for row in data["serving"]["groups"]}
    assert wanted == {"Interstitial": 1}


def test_a_players_summary_says_what_they_cost_and_how_much_they_paid_back(game):
    admin, game, _, _ = game

    def summary(player):
        answer = admin.get(
            f"/v1/games/{game['id']}/insights/player-summary",
            headers=AUTH,
            params={"player": player},
        )
        assert answer.status_code == 200, answer.text
        return answer.json()

    u1 = summary("u1")
    assert u1["install"]["campaign"] == "C1" and u1["install"]["first_open"] == "2026-10-01"
    assert u1["money"]["per_day"] == [["2026-10-01", 0.015], ["2026-10-02", 0.02]]
    assert u1["cost"] == {
        "state": "ok",
        "campaign": "C1",
        "install_day": "2026-10-01",
        "cost": 2.5,
        "earned": 0.035,
        "paid_back_share": 0.014,
        "paid_back_day": None,
    }
    assert summary("u3")["cost"] == {"state": "organic"}
    assert summary("u4")["cost"] == {"state": "no_record"}
    assert summary("u6")["cost"]["state"] == "updated"


def test_a_players_ad_failures_are_listed_newest_first_with_level_and_reason(tmp_path):
    settings = Settings(data_dir=tmp_path / "data", admin_token=TOKEN)
    sent = [
        at("p", 1, "AD_ANALYSIS", hour=10, STATE="Failed", FORMAT="Interstitial",
           PLACEMENT="level_interstitial", REASON="NotReady", LEVEL_NUMBER=7, AD_ID="a1"),
        at("p", 1, "AD_ANALYSIS", hour=11, STATE="LoadFailed", FORMAT="AppOpen",
           ERROR="No fill", AD_ID="a2"),
        at("p", 1, "AD_ANALYSIS", hour=12, STATE="Show", FORMAT="Rewarded", AD_ID="a3"),
        at("p", 1, "AD_ANALYSIS", hour=12, STATE="Revenue", FORMAT="Rewarded", AD_ID="a3",
           NETWORK="AppLovin", REVENUE=0.04),
    ]  # fmt: skip
    with TestClient(create_app(settings, admin=True)) as admin:
        created = register(admin)
        with TestClient(create_app(settings)) as ingest:
            assert send(ingest, created, sent).status_code == 200
        ads_part = admin.get(
            f"/v1/games/{created['id']}/insights/player-summary",
            headers=AUTH,
            params={"player": "p"},
        ).json()["ads"]
    assert [item["reason"] for item in ads_part["failures"]] == ["No fill", "NotReady"]
    assert ads_part["failures"][1] | {"at": None} == {
        "at": None, "format": "Interstitial", "kind": "show",
        "placement": "level_interstitial", "reason": "NotReady", "level": 7,
    }  # fmt: skip
    assert ads_part["load_failed"] == 1 and ads_part["failed"] == 1
    assert ads_part["networks"] == {"AppLovin": {"shown": 1, "revenue": 0.04}}
    assert ads_part["formats"]["Rewarded"]["revenue"] == 0.04


def listed(admin, game, chips, **extra):
    answer = admin.get(
        f"/v1/games/{game['id']}/insights/players",
        headers=AUTH,
        params={
            "start": "2026-10-01",
            "end": "2026-10-10",
            "player_group": json.dumps(chips),
            **extra,
        },
    )
    assert answer.status_code == 200, answer.text
    return answer.json()


def test_a_chip_group_keeps_players_who_meet_every_condition(game):
    admin, game, _, _ = game
    names = lambda data: {row["player"] for row in data["players"]}  # noqa: E731
    assert names(listed(admin, game, [{"kind": "campaign", "values": ["C1"]}])) == {
        "u1",
        "u2",
        "u6",
    }
    assert names(listed(admin, game, [{"kind": "earned", "min": 0.03}])) == {"u1", "u2", "u6"}
    both = [{"kind": "campaign", "values": ["C1"]}, {"kind": "earned", "max": 0.032}]
    assert names(listed(admin, game, both)) == {"u2"}
    # "at most" keeps players who never earned anything
    assert "u4" in names(listed(admin, game, [{"kind": "earned", "max": 0.01}]))
    assert names(listed(admin, game, [{"kind": "install_type", "value": "none"}])) == {
        "u4",
        "dummy",
    }
    # paid back: u1 earned 0.035 of 2.5 (1.4%), u2 0.03 (1.2%); u6 updated, so has no cost
    assert names(listed(admin, game, [{"kind": "paid_back", "min": 1.3}])) == {"u1"}
    bad = admin.get(
        f"/v1/games/{game['id']}/insights/players",
        headers=AUTH,
        params={"start": "2026-10-01", "end": "2026-10-10", "player_group": '[{"kind": "earned"}]'},
    )
    assert bad.status_code == 400 and "lowest or a highest" in bad.json()["detail"]


def test_listed_players_carry_their_campaign_revenue_and_cost(game):
    admin, game, _, _ = game
    rows = {row["player"]: row for row in listed(admin, game, [])["players"]}
    assert rows["u1"]["value"] == {
        "campaign": "C1",
        "install_day": "2026-10-01",
        "earned": 0.035,
        "cost": 2.5,
        "paid_back": 0.014,
    }
    assert rows["u3"]["value"]["campaign"] == "organic" and rows["u3"]["value"]["cost"] is None


def test_chip_groups_are_saved_apart_from_levels_comparisons(game):
    admin, game, _, _ = game
    path = f"/v1/games/{game['id']}/insights/group-library"
    saved = admin.post(
        path,
        headers=AUTH,
        json={"name": "C1 earners", "kind": "players",
              "definition": {"chips": [{"kind": "campaign", "values": ["C1"]}]}},
    )  # fmt: skip
    assert saved.status_code == 201, saved.text
    assert [
        item["name"] for item in admin.get(path, headers=AUTH, params={"kind": "players"}).json()
    ] == ["C1 earners"]
    assert admin.get(path, headers=AUTH).json() == []  # Levels and NutBot don't see it
    broken = admin.post(
        path, headers=AUTH,
        json={"name": "Bad", "kind": "players", "definition": {"chips": [{"kind": "colour"}]}},
    )  # fmt: skip
    assert broken.status_code == 400
    options = admin.get(f"/v1/games/{game['id']}/insights/player-chip-options", headers=AUTH).json()
    assert {item["value"] for item in options["campaign"]} == {"C1", "C2"}
