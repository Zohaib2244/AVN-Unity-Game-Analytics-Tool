"""Campaign cost, return by install source and day, install-day cohorts, goals, and the ad reads
behind the Ads page, checked against a small game by hand. The cost endpoint is replaced by a stub.
"""

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
