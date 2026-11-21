"""Where it breaks: pure flagging, and a small game with a planted low-end device cluster."""

import pytest
from fastapi.testclient import TestClient
from test_backend import AUTH, TOKEN, event, register
from test_playertools import END, NO_FILTERS, START

from avn_analytics import analytics, segment_performance
from avn_analytics.api import create_app
from avn_analytics.config import Settings


def row(value, exit_total=0, exit_bad=0, ad_total=0, ad_bad=0):
    return {
        "value": value,
        "exit_total": exit_total,
        "exit_bad": exit_bad,
        "ad_total": ad_total,
        "ad_bad": ad_bad,
    }


def flagged(rows, **limits):
    return {r["value"]: r["flags"] for r in segment_performance.flag(rows, **limits)}


def test_a_group_clearly_worse_than_everyone_else_is_flagged_with_words():
    found = flagged([row("low", 100, 30), row("high", 300, 15), row("mid", 200, 10)])
    assert [f["measure"] for f in found["low"]] == ["bad_exits"]
    assert found["low"][0]["words"] == (
        "30 of 100 launches (30.0%) follow a crash or the system killing the game; "
        "everyone else 5.0%"
    )
    assert found["low"][0]["count"] == 30 and found["high"] == [] and found["mid"] == []


def test_small_samples_and_gentle_differences_are_not_flagged():
    tiny = [row("one phone", 10, 8), row("rest", 500, 25)]
    assert flagged(tiny) == {"one phone": [], "rest": []}
    few_bad = [row("a", 100, 4), row("b", 500, 5)]  # 4% vs 1%, but only 4 bad exits
    assert flagged(few_bad)["a"] == []
    gentle = [row("a", 100, 12), row("b", 500, 50)]  # 12% vs 10%
    assert flagged(gentle)["a"] == []
    high_everywhere = [row("a", 100, 62), row("b", 500, 250)]  # 12 points but only 1.24x
    assert flagged(high_everywhere)["a"] == []


def test_ads_are_judged_apart_from_exits():
    found = flagged([row("a", ad_total=100, ad_bad=40), row("b", ad_total=300, ad_bad=15)])
    assert [f["measure"] for f in found["a"]] == ["ad_failures"]
    assert found["a"][0]["words"] == "40 of 100 ads (40.0%) fail to show; everyone else 5.0%"


def at(device, name, minute, country, **params):
    return event(
        name=name,
        params=params,
        device_id=device,
        session_id=f"s-{device}",
        client_ts=f"2026-10-03T10:{minute // 60:02d}:{minute % 60:02d}Z",
    ), country


def _events():
    """30 low-end players on Android 12 in IN: 1 in 3 launches follows a LowMemory kill and half
    of their asked-for ads fail. 40 high-end players on Android 14 in US: rare problems."""
    sent = []
    for index in range(70):
        low = index < 30
        device, country = f"p{index}", "IN" if low else "US"
        sent.append(
            at(
                device,
                "DEVICE_ANALYSIS",
                0,
                country,
                STATE="Snapshot",
                TIER="low" if low else "high",
                RAM_MB=2048 if low else 8192,
            )
        )
        sent.append(
            at(
                device,
                "session_start",
                1,
                country,
                device_model="Redmi 9A" if low else "Pixel 8",
                os_version="Android 12" if low else "Android 14",
            )
        )
        sent.append(at(device, "APP_ANALYSIS", 2, country, STATE="Launch", PREV_EXIT_AD="None"))
        for n in range(3):
            if low:
                reason = "LowMemory" if n == 0 else "UserRequested"
            else:
                reason = "Anr" if index < 34 and n == 0 else "UserRequested"
            sent.append(
                at(
                    device,
                    "APP_ANALYSIS",
                    3 + n,
                    country,
                    STATE="Launch",
                    PREV_EXIT_REASON=reason,
                    PREV_EXIT="Killed",
                    PREV_EXIT_AD="None",
                )
            )
        asks = 2 if low else 3
        for n in range(asks):
            failed = (n == 0) if low else (index < 33 and n == 0)
            state = "Failed" if failed else "Show"
            sent.append(
                at(device, "AD_ANALYSIS", 10 + n, country, STATE=state, AD_ID=f"{device}-{n}")
            )
    return sent


@pytest.fixture(params=["legacy", "facts"])
def game(tmp_path, request):
    settings = Settings(
        data_dir=tmp_path / "data", admin_token=TOKEN, analytics_read_mode=request.param
    )
    with TestClient(create_app(settings, admin=True)) as admin:
        game = register(admin)
        with TestClient(create_app(settings)) as ingest:
            key = {"X-API-Key": game["key"]["api_key"]}
            for country in ("IN", "US"):
                events = [e for e, c in _events() if c == country]
                for first in range(0, len(events), 400):
                    response = ingest.post(
                        "/v1/events",
                        headers={**key, "CF-IPCountry": country},
                        json={"events": events[first : first + 400]},
                    )
                    assert response.status_code == 200, response.text
        storage = admin.app.state.storage
        if request.param == "facts":
            analytics.prepare_all(storage, game["id"])
        yield admin, game, storage


def test_the_planted_low_end_cluster_is_found_in_every_dimension(game):
    admin, game, storage = game
    data = segment_performance.report(storage, game["id"], START, END, NO_FILTERS)
    assert data["available"] is True
    assert data["everyone"]["exit_total"] == 210
    assert data["everyone"]["exit_bad"] == 30 + 4
    by_dimension = {
        name: {r["value"]: r for r in block["rows"]} for name, block in data["dimensions"].items()
    }
    assert set(by_dimension["country"]) == {"IN", "US"}
    assert [r["value"] for r in data["dimensions"]["device_tier"]["rows"]] == ["low", "high"]
    assert [r["value"] for r in data["dimensions"]["ram_band"]["rows"]] == ["under 3 GB", "8 GB+"]
    assert set(by_dimension["device_tier"]) == {"low", "high"}
    assert set(by_dimension["ram_band"]) == {"under 3 GB", "8 GB+"}
    assert set(by_dimension["os_version"]) == {"Android 12", "Android 14"}
    assert set(by_dimension["device_model"]) == {"Redmi 9A", "Pixel 8"}
    low = by_dimension["device_tier"]["low"]
    assert low["players"] == 30 and low["launches"] == 120
    assert low["exit_total"] == 90 and low["exit_bad"] == 30
    assert low["bad_exit_rate"] == round(30 / 90, 4)
    assert low["ad_total"] == 60 and low["ad_bad"] == 30
    assert [f["measure"] for f in low["flags"]] == ["bad_exits", "ad_failures"]
    assert by_dimension["device_tier"]["high"]["flags"] == []
    for name, value in (
        ("country", "IN"),
        ("ram_band", "under 3 GB"),
        ("os_version", "Android 12"),
        ("device_model", "Redmi 9A"),
    ):
        assert by_dimension[name][value]["flags"], (name, value)
    assert data["findings"][0]["value"] in {"IN", "low", "under 3 GB", "Android 12", "Redmi 9A"}
    assert data["summary"].startswith("Device model Redmi 9A: ")
    assert "30 of 60 ads (50.0%) fail to show; everyone else 2.5%" in data["summary"]
    # every dimension describes the same 30 players, so each measure is said once, by the most
    # specific group, with the others named as the same players
    assert [(f["measure"], f["dimension"], f["value"]) for f in data["findings"]] == [
        ("ad_failures", "device_model", "Redmi 9A"),
        ("bad_exits", "device_model", "Redmi 9A"),
    ]
    assert set(data["findings"][0]["same_as"]) == {
        "OS version Android 12",
        "Device tier low",
        "RAM under 3 GB",
        "Country IN",
    }
    response = admin.get(
        f"/v1/games/{game['id']}/insights/performance",
        headers=AUTH,
        params={"start": "2026-10-01", "end": "2026-10-05"},
    )
    assert response.status_code == 200, response.text
    assert response.json()["findings"] == data["findings"]


def test_players_without_a_device_snapshot_are_unknown_not_dropped(tmp_path):
    settings = Settings(data_dir=tmp_path / "data", admin_token=TOKEN)
    with TestClient(create_app(settings, admin=True)) as admin:
        game = register(admin)
        with TestClient(create_app(settings)) as ingest:
            events = [
                at("a", "APP_ANALYSIS", n, "IN", STATE="Launch", PREV_EXIT_REASON="Anr")[0]
                for n in range(3)
            ]
            key = {"X-API-Key": game["key"]["api_key"], "CF-IPCountry": "IN"}
            assert (
                ingest.post("/v1/events", headers=key, json={"events": events}).status_code == 200
            )
        data = segment_performance.report(
            admin.app.state.storage, game["id"], START, END, NO_FILTERS
        )
        tier = data["dimensions"]["device_tier"]
        assert tier["available"] is False and tier["unknown_players"] == 1
        assert tier["rows"][0]["value"] == "unknown" and tier["rows"][0]["exit_bad"] == 3
        assert data["dimensions"]["country"]["available"] is True
        assert data["findings"] == [] and data["summary"].startswith("No country or device")


def test_a_game_without_launches_or_ads_gets_a_sentence(tmp_path):
    settings = Settings(data_dir=tmp_path / "data", admin_token=TOKEN)
    with TestClient(create_app(settings, admin=True)) as admin:
        game = register(admin)
        data = segment_performance.report(
            admin.app.state.storage, game["id"], START, END, NO_FILTERS
        )
        assert data["available"] is False and "may not send" in data["note"]
