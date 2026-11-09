"""Ad impact, stability, economy, onboarding and the store, checked against a small game by hand."""

import json
from datetime import date

import pytest
from fastapi.testclient import TestClient
from test_backend import AUTH, TOKEN, event, register, send

from avn_analytics import ads, stability, systems
from avn_analytics.api import create_app
from avn_analytics.config import Settings
from avn_analytics.exports import period_bounds
from avn_analytics.models import Filters

START, END = period_bounds("custom", date(2026, 10, 1), date(2026, 10, 10))
FILTERS = Filters().model_dump()


def at(device, day, name, hour=10, minute=0, second=0, version="1.0", **params):
    return event(
        name=name,
        params=params,
        device_id=device,
        session_id=f"s-{device}-{day}",
        app_version=version,
        client_ts=f"2026-10-{day:02d}T{hour:02d}:{minute:02d}:{second:02d}Z",
    )


def shows(device, count, day=1):
    """`count` different ads shown to the player on a day."""
    return [
        at(device, day, "AD_ANALYSIS", 11, n, STATE="Show", AD_ID=f"{device}-{day}-{n}")
        for n in range(count)
    ]


def level(device, number, minute, state="Completed", used=None, day=1, **more):
    params = {"STATE": state, "LEVEL_NUMBER": number, **more}
    if used is not None:
        params["POWERUPS_USED"] = used
    return at(device, day, "LEVEL_ANALYSIS", 10, minute, **params)


def app(device, state, minute=0, version="1.0", **params):
    return at(device, 1, "APP_ANALYSIS", 12, minute, version=version, STATE=state, **params)


def launch(device, minute, reason, ad="None", kind=None, version="1.0"):
    params = {"PREV_EXIT_AD": ad}
    if reason:
        params |= {"PREV_EXIT_REASON": reason, "PREV_EXIT": kind or "Killed"}
    return app(device, "Launch", minute, version, **params)


def economy(device, minute, currency, state, source, amount, balance, number, **more):
    return at(
        device,
        1,
        "ECONOMY_ANALYSIS",
        13,
        minute,
        CURRENCY=currency,
        STATE=state,
        SOURCE=source,
        AMOUNT=amount,
        BALANCE=balance,
        LEVEL_NUMBER=number,
        **more,
    )


def powerup(device, minute, state, name, **more):
    return at(device, 1, "POWERUP_ANALYSIS", 14, minute, STATE=state, POWERUP=name, **more)


def tutorial(device, minute, state, name, **more):
    return at(device, 1, "TUTORIAL_ANALYSIS", 15, minute, STATE=state, TUTORIAL=name, **more)


def screen(device, minute, state, name, **more):
    return at(device, 1, "SCREEN_ANALYSIS", 16, minute, STATE=state, SCREEN=name, **more)


def iap(device, minute, state, product, **more):
    return at(device, 1, "IAP_ANALYSIS", 17, minute, STATE=state, PRODUCT=product, **more)


def snapshot(device, minute, tier, ram):
    return at(device, 1, "DEVICE_ANALYSIS", 18, minute, STATE="Snapshot", TIER=tier, RAM_MB=ram)


def events_of_the_game():
    """Six players open the game in the range (day 1, p6 on day 9); the data ends on day 10.

    Everything the players do is on their first day, apart from the days they come back: p1 on
    days 2 and 8, p3 and p5 on day 2.
    """
    events = [at(f"p{n}", 1, "first_open") for n in range(1, 6)] + [at("p6", 9, "first_open")]
    events.append(at("dummy", 10, "session_start"))
    events += [
        at("p1", 2, "session_start"),
        at("p1", 8, "session_start"),
        at("p3", 2, "session_start"),
        at("p5", 2, "session_start"),
    ]
    # ads shown on the first day: p1 two (one shown twice), p3 four, p4 nine, p5 one, others none
    events += shows("p1", 2) + [at("p1", 1, "AD_ANALYSIS", 11, 0, STATE="Show", AD_ID="p1-1-0")]
    events += shows("p1", 5, day=2) + shows("p3", 4) + shows("p4", 9) + shows("p5", 1)
    # leaving the app: 7 backgrounds (2 ad, 4 player, 1 purchase) and 4 returns from an ad
    events += [app("p1", "Background", n, CAUSE="Ad") for n in (1, 2)]
    events += [app("p1", "Background", 3, CAUSE="Player")]
    events += [app("p3", "Background", n, CAUSE="Player") for n in (4, 5, 6)]
    events += [app("p3", "Background", 7, CAUSE="Purchase")]
    events += [
        app("p1", "Foreground", 8 + n, CAUSE="Ad", AWAY_SECONDS=s)
        for n, s in enumerate((10, 20, 30, 100))
    ]
    events += [app("p1", "Foreground", 20, CAUSE="Player", AWAY_SECONDS=500)]
    # eight launches: how the run before each one ended
    events += [
        launch("p1", 30, "UserRequested", kind="Quit"),
        launch("p1", 31, "Anr", ad="Interstitial"),
        launch("p2", 32, "Other", ad="Rewarded", kind="Background"),
        launch("p3", 33, "LowMemory", version="1.1"),
        launch("p3", 34, "CrashNative", version="1.1"),
        launch("p4", 35, "Anr", ad="Interstitial", version="1.1"),
        launch("p5", 36, None),
        launch("p5", 37, "Signaled", ad="AppOpen"),
    ]
    events += [
        level("p3", 9, 40, "Left", REASON="Killed", RECOVERED=1),
        level("p3", 9, 41, "Left", REASON="Killed", RECOVERED=0),
        level("p3", 9, 42, "Left", REASON="Home"),
    ]
    # devices: p1's first snapshot is replaced by its later one; p4 never sent one
    events += [
        snapshot("p1", 0, "low", 2000),
        snapshot("p1", 1, "high", 6000),
        snapshot("p2", 0, "low", 2048),
        snapshot("p3", 0, "medium", 4096),
        snapshot("p5", 0, "high", 8192),
    ]
    for device, model in (("p1", "Pixel 7"), ("p2", "Galaxy A14"), ("p3", "Pixel 7")):
        events.append(at(device, 1, "session_start", 9, device_model=model))
    events.append(at("p5", 1, "session_start", 9, device_model="Galaxy A14"))
    # levels completed in the first session (the first open is at 10:00:00)
    events += [level("p1", n, 3 * n, used=u) for n, u in ((1, 0), (2, 1), (3, 0))]
    events += [level("p1", 7, 5, day=2, used=0)]
    events += [level("p3", n, 2 * n, used=u) for n, u in ((1, 0), (2, 1), (3, 1), (4, 0), (5, 0))]
    events += [level("p4", 1, 5, used=0), level("p4", 10, 9, used=2)]
    events += [level("p4", 11, 10, "Failed", used=3)]
    events += [level("p5", 1, 1, used=0), level("p5", 2, 2, "Failed", used=0)]
    # economy
    events += [
        economy("p1", 0, "coins", "Earned", "level_reward", 100, 150, 3),
        economy("p1", 1, "coins", "Earned", "rewarded_ad", 50, 200, 3),
        economy("p1", 2, "coins", "Spent", "powerup", 30, 170, 3, DETAIL="fire_disc"),
        economy("p3", 0, "coins", "Earned", "level_reward", 200, 400, 30),
        economy("p3", 1, "coins", "Spent", "revive", 100, 300, 30, DETAIL="revive"),
        economy("p3", 2, "coins", "Spent", "powerup", 50, 250, 40, DETAIL="fire_disc"),
        economy("p5", 0, "coins", "Earned", "gift", 25, 25, 1),
        economy("p5", 1, "gems", "Earned", "gift", 5, 5, 1),
    ]
    # power-ups
    events += [
        powerup("p1", 0, "Obtained", "fire_disc", SOURCE="Coins", AMOUNT=1),
        powerup("p1", 1, "Used", "fire_disc", TRIGGER="Player", AMOUNT=1),
        powerup("p3", 0, "Obtained", "fire_disc", SOURCE="Gift", AMOUNT=2),
        powerup("p3", 1, "Obtained", "fire_disc", SOURCE="RewardedAd", AMOUNT=1),
        powerup("p3", 2, "Used", "fire_disc", TRIGGER="Tutorial", AMOUNT=1),
        powerup("p3", 3, "Used", "fire_disc", TRIGGER="Player", AMOUNT=1),
        powerup("p3", 4, "Obtained", "freeze", SOURCE="Coins", AMOUNT=1),
    ]
    # tutorials
    events += [tutorial(d, 0, "Shown", "first_level") for d in ("p1", "p2", "p3", "p4")]
    events += [tutorial("p3", 1, "Shown", "first_level")]
    events += [
        tutorial("p1", 2, "Completed", "first_level", SECONDS=20),
        tutorial("p3", 2, "Completed", "first_level", SECONDS=40),
        tutorial("p4", 2, "Completed", "first_level", SECONDS=60),
        tutorial("p2", 2, "Interrupted", "first_level", SECONDS=1),
        tutorial("p1", 3, "Shown", "powerup_fire_disc"),
        tutorial("p3", 3, "Shown", "powerup_fire_disc"),
        tutorial("p3", 4, "Completed", "powerup_fire_disc", SECONDS=10),
    ]
    # screens: p1 opens the store once, p3 twice; p2 opens settings
    events += [
        screen("p1", 0, "Opened", "store"),
        screen("p3", 0, "Opened", "store"),
        screen("p3", 1, "Opened", "store"),
        screen("p1", 1, "Interaction", "store", ACTION="tab_switch"),
        screen("p3", 2, "Interaction", "store", ACTION="buy_coins"),
        screen("p3", 3, "Interaction", "store", ACTION="buy_coins"),
        screen("p1", 2, "Closed", "store", SECONDS_OPEN=10, CLOSED_BY="Dismissed"),
        screen("p3", 4, "Closed", "store", SECONDS_OPEN=30, CLOSED_BY="Purchased"),
        screen("p3", 5, "Closed", "store", SECONDS_OPEN=20, CLOSED_BY="Dismissed"),
        screen("p2", 0, "Opened", "settings"),
    ]
    # purchases
    events += [
        iap("p1", 0, "Clicked", "coins_100", SCREEN="store"),
        iap("p1", 1, "Clicked", "coins_100", SCREEN="store"),
        iap("p1", 2, "Purchased", "coins_100", PRICE=0.99, PRICE_CURRENCY="USD"),
        iap("p3", 0, "Clicked", "coins_100", SCREEN="store"),
        iap("p3", 1, "Purchased", "coins_100", PRICE=0.99, PRICE_CURRENCY="USD"),
        iap("p3", 2, "Clicked", "no_ads", SCREEN="store"),
        iap("p3", 3, "Failed", "no_ads", REASON="UserCancelled"),
        iap("p3", 4, "Purchased", "no_ads", PRICE=3.49, PRICE_CURRENCY="EUR"),
        iap("p5", 0, "SubActivated", "weekly_vip"),
    ]
    return events


@pytest.fixture
def settings(tmp_path):
    return Settings(data_dir=tmp_path / "data", admin_token=TOKEN)


@pytest.fixture
def game(settings):
    with TestClient(create_app(settings, admin=True)) as admin:
        game = register(admin)
        with TestClient(create_app(settings)) as ingest:
            assert send(ingest, game, events_of_the_game()).status_code == 200
        yield admin, game, admin.app.state.storage


def by(rows, key="value"):
    return {row[key]: row for row in rows}


def test_ads_in_the_way_of_players_leaving_and_coming_back(game):
    _, game, storage = game
    data = ads.impact(storage, game["id"], START, END, FILTERS)
    assert data["available"] is True
    leaving = data["leaving_on_ads"]
    assert leaving["leaving_the_app"] == {
        "backgrounds": 7,
        "by_cause": {
            "Player": {"events": 4, "share": round(4 / 7, 4)},
            "Ad": {"events": 2, "share": round(2 / 7, 4)},
            "Purchase": {"events": 1, "share": round(1 / 7, 4)},
        },
    }
    # only Foreground events caused by an ad: 10, 20, 30 and 100 seconds
    assert leaving["coming_back_from_an_ad"] == {
        "events": 4,
        "median_away_seconds": 25.0,
        "p90_away_seconds": 100.0,
    }
    after = leaving["launches_after_an_ad_on_screen"]
    assert (
        after["launches"] == 8 and after["after_an_ad"] == 4 and after["share_of_launches"] == 0.5
    )
    assert after["by_format"] == {
        "Interstitial": {
            "launches": 2,
            "previous_exit_reasons": {"Anr": 2},
            "share_of_launches": 0.25,
        },
        "AppOpen": {
            "launches": 1,
            "previous_exit_reasons": {"Signaled": 1},
            "share_of_launches": 0.125,
        },
        "Rewarded": {
            "launches": 1,
            "previous_exit_reasons": {"Other": 1},
            "share_of_launches": 0.125,
        },
    }


def test_first_day_ads_against_coming_back(game):
    _, game, storage = game
    retention = ads.impact(storage, game["id"], START, END, FILTERS)["first_day_retention"]
    assert retention["cohort_players"] == 6
    assert "association, not cause" in retention["means"]
    buckets = by(retention["buckets"], "ads_seen_on_first_day")
    assert list(buckets) == ["0", "1-3", "4-8", "9+"]
    # p2 and p6 saw none; p6's day 1 isn't over yet (the data ends on day 10) so it is left out
    zero = buckets["0"]
    assert zero["players"] == 2
    assert zero["day_1"] == {"eligible_players": 1, "returned": 0, "rate": 0.0}
    assert zero["day_7"] == {"eligible_players": 1, "returned": 0, "rate": 0.0}
    # p1 (two different ads; ads on day 2 don't count) and p5 (one)
    few = buckets["1-3"]
    assert few["players"] == 2
    assert few["day_1"] == {"eligible_players": 2, "returned": 2, "rate": 1.0}
    assert few["day_7"] == {"eligible_players": 2, "returned": 1, "rate": 0.5}
    assert buckets["4-8"]["day_1"] == {"eligible_players": 1, "returned": 1, "rate": 1.0}
    assert buckets["4-8"]["day_7"]["returned"] == 0
    assert buckets["9+"]["players"] == 1 and buckets["9+"]["day_1"]["returned"] == 0


def test_stability_counts_how_the_previous_run_ended(game):
    _, game, storage = game
    data = stability.stability(storage, game["id"], START, END, FILTERS)
    assert data["available"] is True
    assert data["problem_reasons"] == sorted(stability.PROBLEM_REASONS)
    everything = data["all"]
    assert everything["launches"] == 8
    assert everything["launches_with_known_previous_exit"] == 7
    # Anr x2, LowMemory and CrashNative are problems; Signaled and Other are not
    assert everything["problem_exits"] == 4
    assert everything["problem_exit_rate"] == round(4 / 7, 4)
    assert everything["problem_exits_with_ad_on_screen"] == 2
    reasons = everything["previous_exit_reasons"]
    assert reasons["Anr"] == {"launches": 2, "share": round(2 / 7, 4)}
    assert list(reasons)[0] == "Anr" and len(reasons) == 6
    assert data["previous_exit_kinds"] == {"Killed": 5, "Background": 1, "Quit": 1}
    assert data["killed_in_a_level"] == {
        "available": True,
        "left_level_events": 3,
        "killed": 2,
        "killed_share_of_left": round(2 / 3, 4),
        "killed_and_recovered": 1,
        "recovered_share_of_killed": 0.5,
        "means": data["killed_in_a_level"]["means"],
    }
    assert data["groups"] == [] and data["group_by"] == "none"


def test_stability_by_app_version_and_device(game):
    _, game, storage = game

    def groups(group_by, **more):
        data = stability.stability(storage, game["id"], START, END, FILTERS, group_by, **more)
        return by(data["groups"]), data

    versions, _ = groups("app_version")
    assert versions["1.0"]["launches"] == 5 and versions["1.0"]["problem_exits"] == 1
    assert versions["1.0"]["problem_exit_rate"] == 0.25
    assert list(versions["1.0"]["previous_exit_reasons"]) == ["Anr", "Other", "Signaled"]
    assert versions["1.1"]["problem_exit_rate"] == 1.0
    assert list(versions["1.1"]["previous_exit_reasons"]) == ["Anr", "CrashNative", "LowMemory"]
    assert versions["1.1"]["problem_exits_with_ad_on_screen"] == 1

    tiers, data = groups("device_tier")
    assert "latest device snapshot" in data["groups_note"]
    assert [(k, v["launches"]) for k, v in tiers.items()] == [
        ("high", 4),
        ("medium", 2),
        ("low", 1),
        ("unknown", 1),
    ]
    assert tiers["high"]["problem_exit_rate"] == round(1 / 3, 4)  # p1 was low before it was high
    assert tiers["medium"]["problem_exit_rate"] == 1.0 and tiers["low"]["problem_exit_rate"] == 0.0
    assert tiers["unknown"]["problem_exits"] == 1

    bands, _ = groups("ram_band")
    assert {k: v["launches"] for k, v in bands.items()} == {
        "5-8 GB": 2,
        "8 GB+": 2,
        "3-5 GB": 2,
        "under 3 GB": 1,
        "unknown": 1,
    }
    models, _ = groups("device_model")
    assert {k: v["launches"] for k, v in models.items()} == {
        "Pixel 7": 4,
        "Galaxy A14": 3,
        "unknown": 1,
    }
    only, _ = groups("app_version", limit=1)
    assert list(only) == ["1.0"]
    platforms, _ = groups("platform")
    assert platforms["android"]["launches"] == 8
    with pytest.raises(ValueError, match="group_by is one of"):
        groups("colour")


def test_economy_per_currency(game):
    _, game, storage = game
    data = systems.economy(storage, game["id"], START, END, FILTERS)
    assert data["available"] is True and data["view"] == "currency" and data["band"] == 25
    currencies = by(data["currencies"], "currency")
    assert list(currencies) == ["coins", "gems"]
    coins = currencies["coins"]
    earned, spent = coins["earned"], coins["spent"]
    assert (earned["amount"], earned["events"], earned["players"]) == (375, 4, 3)
    assert [(r["source"], r["amount"], r["share"]) for r in earned["by_source"]] == [
        ("level_reward", 300, 0.8),
        ("rewarded_ad", 50, round(50 / 375, 4)),
        ("gift", 25, round(25 / 375, 4)),
    ]
    assert earned["top_details"] == []
    assert (spent["amount"], spent["events"], spent["players"]) == (180, 3, 2)
    assert [(r["source"], r["amount"]) for r in spent["by_source"]] == [
        ("revive", 100),
        ("powerup", 80),
    ]
    assert spent["top_details"] == [
        {"detail": "revive", "amount": 100, "events": 1},
        {"detail": "fire_disc", "amount": 80, "events": 2},
    ]
    assert coins["net"] == 195
    assert coins["share_of_earned_from_rewarded_ads"] == round(50 / 375, 4)
    assert coins["median_balance_by_level_band"] == [
        {"levels": "1-25", "first_level": 1, "balance_readings": 4, "median_balance": 160.0},
        {"levels": "26-50", "first_level": 26, "balance_readings": 3, "median_balance": 300.0},
    ]
    assert currencies["gems"]["share_of_earned_from_rewarded_ads"] == 0.0
    wide = systems.economy(storage, game["id"], START, END, FILTERS, band=50)
    assert [
        b["levels"]
        for b in by(wide["currencies"], "currency")["coins"]["median_balance_by_level_band"]
    ] == ["1-50"]
    for bad in (0, 1001, "many"):
        with pytest.raises(ValueError, match="band is a whole number"):
            systems.economy(storage, game["id"], START, END, FILTERS, band=bad)


def test_economy_powerups_and_completion_with_them(game):
    _, game, storage = game
    data = systems.economy(storage, game["id"], START, END, FILTERS, view="powerups")
    assert data["view"] == "powerups"
    powerups = by(data["powerups"], "powerup")
    assert list(powerups) == ["fire_disc", "freeze"]
    fire = powerups["fire_disc"]
    assert fire["players"] == 2
    assert fire["obtained"] == {
        "amount": 4,
        "events": 3,
        "players": 2,
        "by_source": {"Gift": 2, "Coins": 1, "RewardedAd": 1},
    }
    assert fire["used"] == {
        "amount": 3,
        "events": 3,
        "players": 2,
        "by_trigger": {"Player": 2, "Tutorial": 1},
    }
    assert (
        powerups["freeze"]["obtained"]["amount"] == 1 and powerups["freeze"]["used"]["events"] == 0
    )
    # level results that report POWERUPS_USED (p1's day-2 level counts; a Left event does not)
    both = data["completion_with_and_without_powerups"]
    assert both["with_powerups"] == {"level_results": 5, "completed": 4, "completed_share": 0.8}
    assert both["without_powerups"] == {
        "level_results": 9,
        "completed": 8,
        "completed_share": round(8 / 9, 4),
    }
    assert "association, not cause" in both["means"]
    with pytest.raises(ValueError, match="view is one of"):
        systems.economy(storage, game["id"], START, END, FILTERS, view="prices")


def test_onboarding_tutorials_and_the_first_session(game):
    _, game, storage = game
    data = systems.onboarding(storage, game["id"], START, END, FILTERS)
    tutorials = by(data["tutorials"]["tutorials"], "tutorial")
    assert list(tutorials) == ["first_level", "powerup_fire_disc"]
    assert tutorials["first_level"] == {
        "tutorial": "first_level",
        "players_shown": 4,
        "players_completed": 3,
        "players_interrupted": 1,
        "completion_rate": 0.75,
        "median_seconds_to_complete": 40.0,
    }
    fire = tutorials["powerup_fire_disc"]
    assert fire["players_shown"] == 2 and fire["completion_rate"] == 0.5
    assert fire["median_seconds_to_complete"] == 10.0
    first = data["first_session"]
    # p1 reached 3, p3 5, p4 10, p5 1; p2 and p6 completed nothing; p1's day-2 level 7 is ignored
    assert first["cohort_players"] == 6
    assert first["completed_a_level_share"] == round(4 / 6, 4)
    assert {k: v["players"] for k, v in first["reached_level_share"].items()} == {
        "level_1": 4,
        "level_3": 3,
        "level_5": 2,
        "level_10": 1,
    }
    assert first["reached_level_share"]["level_3"]["share"] == 0.5
    assert first["reached_level_share"]["level_10"]["share"] == round(1 / 6, 4)
    # first completed level after 3 min (p1), 2 min (p3), 5 min (p4) and 1 min (p5)
    assert first["median_seconds_to_first_completed_level"] == 150.0


def test_store_screens_and_purchases(game):
    _, game, storage = game
    data = systems.store(storage, game["id"], START, END, FILTERS)
    assert data["active_players"] == 7
    screens = by(data["screens"]["screens"], "screen")
    assert list(screens) == ["store", "settings"]
    store = screens["store"]
    assert (store["opens"], store["players"]) == (3, 2)
    assert store["share_of_active_players"] == round(2 / 7, 4)
    assert store["median_seconds_open"] == 20.0
    assert store["closed_by"] == {
        "Dismissed": {"closes": 2, "share": round(2 / 3, 4)},
        "Purchased": {"closes": 1, "share": round(1 / 3, 4)},
    }
    assert store["top_actions"] == [
        {"action": "buy_coins", "events": 2, "players": 1},
        {"action": "tab_switch", "events": 1, "players": 1},
    ]
    settings_screen = screens["settings"]
    assert settings_screen["median_seconds_open"] is None and settings_screen["closed_by"] == {}
    purchases = data["purchases"]
    products = by(purchases["products"], "product")
    assert list(products) == ["coins_100", "no_ads", "weekly_vip"]
    coins = products["coins_100"]
    assert (coins["clicks"], coins["players_clicking"], coins["purchases"]) == (3, 2, 2)
    assert coins["players_purchasing"] == 2 and coins["purchases_per_click"] == round(2 / 3, 4)
    assert coins["revenue_by_currency"] == {"USD": 1.98}
    no_ads = products["no_ads"]
    assert (no_ads["clicks"], no_ads["failures"], no_ads["purchases"]) == (1, 1, 1)
    assert no_ads["top_failure_reasons"] == {"UserCancelled": 1}
    assert no_ads["revenue_by_currency"] == {"EUR": 3.49}
    vip = products["weekly_vip"]
    assert vip["subscriptions_activated"] == 1 and vip["clicks"] == 0
    assert vip["purchases_per_click"] is None and vip["revenue_by_currency"] == {}
    assert purchases["revenue_by_currency"] == {"EUR": 3.49, "USD": 1.98}
    assert "note" not in purchases
    assert (
        len(systems.store(storage, game["id"], START, END, FILTERS, limit=1)["screens"]["screens"])
        == 1
    )


def test_a_game_that_does_not_send_the_events_says_so(settings):
    with TestClient(create_app(settings, admin=True)) as admin:
        game = register(admin)
        with TestClient(create_app(settings)) as ingest:
            assert send(ingest, game, [at("a", 2, "session_start")]).status_code == 200
        storage = admin.app.state.storage
        args = (storage, game["id"], START, END, FILTERS)
        for data in (
            ads.impact(*args),
            stability.stability(*args),
            systems.economy(*args),
            systems.economy(*args, view="powerups"),
            systems.onboarding(*args),
            systems.store(*args),
        ):
            assert data["available"] is False
            assert data["note"].startswith("No ")
        # first opens alone give the retention read but no ad events
        with TestClient(create_app(settings)) as ingest:
            send(ingest, game, [at("a", 2, "first_open"), at("b", 9, "session_start")])
        part = ads.impact(*args)
        assert part["available"] is True
        assert part["leaving_on_ads"]["available"] is False
        assert part["first_day_retention"]["buckets"][0]["players"] == 1
        assert systems.onboarding(*args)["tutorials"]["available"] is False
        assert systems.onboarding(*args)["first_session"]["completed_a_level_share"] == 0.0


def test_clicks_without_purchases_are_called_out(settings):
    with TestClient(create_app(settings, admin=True)) as admin:
        game = register(admin)
        with TestClient(create_app(settings)) as ingest:
            send(ingest, game, [iap("a", 0, "Clicked", "coins_100"), iap("b", 1, "Clicked", "x")])
        data = systems.store(admin.app.state.storage, game["id"], START, END, FILTERS)
    assert data["screens"]["available"] is False
    assert "only send clicks" in data["purchases"]["note"]
    assert data["purchases"]["revenue_by_currency"] == {}


def test_agents_can_read_the_systems_through_a_key(game):
    admin, game, _ = game
    made = admin.post(
        "/v1/mcp-keys", headers=AUTH, json={"name": "systems", "game_ids": [game["id"]]}
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

    listed = admin.post(
        "/mcp", headers=headers, json={"jsonrpc": "2.0", "id": 2, "method": "tools/list"}
    ).json()["result"]["tools"]
    names = {t["name"] for t in listed}
    mine = {"get_ad_impact", "get_stability", "get_economy", "get_onboarding", "get_store"}
    assert mine <= names
    for tool in listed:
        if tool["name"] in mine:
            assert "segment" in tool["inputSchema"]["properties"]

    error, data = call("get_ad_impact")
    assert not error and data["first_day_retention"]["cohort_players"] == 6
    error, data = call("get_stability", group_by="app_version")
    assert not error and by(data["groups"])["1.1"]["launches"] == 3
    error, data = call("get_economy")
    assert not error and data["currencies"][0]["currency"] == "coins"
    error, data = call("get_economy", view="powerups", segment={"unattributed": True})
    assert not error and data["view"] == "powerups"
    error, data = call("get_onboarding")
    assert not error and data["first_session"]["cohort_players"] == 6
    error, data = call("get_store")
    assert not error and data["purchases"]["revenue_by_currency"]["USD"] == 1.98

    error, text = call("get_stability", group_by="colour")
    assert error and "group_by is one of" in text
    error, text = call("get_economy", view="prices")
    assert error and "view is one of" in text

    # a segment keeps only players who ever sent that event: p1 and p3 saw the second tutorial
    segment = {
        "event_param": {
            "event": "TUTORIAL_ANALYSIS",
            "param": "TUTORIAL",
            "values": ["powerup_fire_disc"],
        }
    }
    error, data = call("get_store", segment=segment)
    assert not error and data["active_players"] == 2
    assert by(data["screens"]["screens"], "screen")["store"]["share_of_active_players"] == 1.0
    error, data = call("get_economy", segment=segment)
    assert not error and data["currencies"][0]["earned"]["amount"] == 350
    error, data = call("get_stability", segment=segment)
    assert not error and data["all"]["launches"] == 4
    error, data = call("get_onboarding", segment=segment)
    assert not error and data["first_session"]["cohort_players"] == 2
