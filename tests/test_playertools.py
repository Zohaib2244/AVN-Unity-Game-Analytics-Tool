"""Level attempts, level designs, player profile, raw events and count_events, checked against a
small game worked out by hand (read both from the raw events and from the analytics facts)."""

import json
from datetime import date

import pytest
from fastapi.testclient import TestClient
from test_backend import AUTH, TOKEN, event, register, send

from avn_analytics import analytics, counting, level_attempts, player_tools
from avn_analytics.api import create_app
from avn_analytics.config import Settings
from avn_analytics.exports import period_bounds
from avn_analytics.models import Filters
from avn_analytics.nutbot_playertools import PLAYER_READ_ONLY, PLAYER_TOOLS

START, END = period_bounds("custom", date(2026, 10, 1), date(2026, 10, 5))
NO_FILTERS = Filters().model_dump()


def at(device, hour, minute, name, second=0, day=4, **params):
    return event(
        name=name,
        params=params,
        device_id=device,
        session_id=f"s-{device}",
        client_ts=f"2026-10-{day:02d}T{hour:02d}:{minute:02d}:{second:02d}Z",
    )


def level(device, hour, minute, state, attempt_id, number, second=0, day=4, **params):
    return at(
        device,
        hour,
        minute,
        "LEVEL_ANALYSIS",
        second,
        day=day,
        STATE=state,
        ATTEMPT_ID=attempt_id,
        LEVEL_NUMBER=number,
        **params,
    )


def started(device, hour, minute, attempt_id, number, design, **params):
    params = {"ATTEMPT": 1, "SOURCE": "Next", "MOVES_START": 20, **params}
    return level(device, hour, minute, "Started", attempt_id, number, LEVEL_ID=design, **params)


def events_of_the_game():
    """Level 5 (design level_164) is tried five times:

    att1 a fails (one revive) and restarts; att2 a completes in 100 s with two power-ups, two ads
    and a banner; att3 b completes in 200 s (a hard level) and goes home; att4 b leaves, killed;
    att5 c starts and nothing follows. Level 7 also uses level_164 (att6, c completes in 300 s on
    a boss level); level 9 uses level_200 (att7, a fails in 30 s) and so does level 11 (att9, c
    leaves after the range ends). Player a also has an install
    record, device data, a saved state, ad revenue and app launches.
    """
    return [
        started("a", 10, 0, "att1", 5, "level_164"),
        level(
            "a", 10, 2, "Failed", "att1", 5, SECONDS=60, MOVES_LEFT=0, REVIVES=1, POWERUPS_USED=0
        ),
        level("a", 10, 3, "Choice", "att1", 5, ACTION="Restart"),
        started("a", 10, 4, "att2", 5, "level_164", ATTEMPT=2, SOURCE="Restart"),
        at(
            "a",
            10,
            5,
            "AD_ANALYSIS",
            STATE="Show",
            AD_ID="ad1",
            ATTEMPT_ID="att2",
            FORMAT="Rewarded",
        ),
        at(
            "a",
            10,
            5,
            "AD_ANALYSIS",
            30,
            STATE="Show",
            AD_ID="ad2",
            ATTEMPT_ID="att2",
            FORMAT="Rewarded",
        ),
        level(
            "a",
            10,
            6,
            "Completed",
            "att2",
            5,
            SECONDS=100,
            MOVES_LEFT=4,
            REVIVES=0,
            POWERUPS_USED=2,
            BANNER_REVENUE=0.002,
            BANNER_IMPRESSIONS=2,
        ),
        level("a", 10, 7, "Choice", "att2", 5, ACTION="Next"),
        started("b", 11, 0, "att3", 5, "level_164", IS_HARD_LEVEL=1),
        level(
            "b",
            11,
            3,
            "Completed",
            "att3",
            5,
            SECONDS=200,
            MOVES_LEFT=8,
            REVIVES=0,
            POWERUPS_USED=0,
        ),
        level("b", 11, 4, "Choice", "att3", 5, ACTION="Home"),
        started("b", 11, 10, "att4", 5, "level_164", ATTEMPT=2),
        level("b", 11, 11, "Left", "att4", 5, REASON="Killed"),
        started("c", 12, 0, "att5", 5, "level_164"),
        started("c", 12, 10, "att6", 7, "level_164", IS_BOSS_LEVEL="true"),
        level("c", 12, 12, "Completed", "att6", 7, SECONDS=300, MOVES_LEFT=2, REVIVES=0),
        started("a", 13, 0, "att7", 9, "level_200"),
        level("a", 13, 1, "Failed", "att7", 9, SECONDS=30),
        # att9 starts on the last day of the range and is left after midnight
        started("c", 23, 59, "att9", 11, "level_200", day=5),
        level("c", 0, 1, "Left", "att9", 11, REASON="Home", day=6),
        # player a: who they are
        at(
            "a",
            9,
            0,
            "ATTRIBUTION_ANALYSIS",
            day=3,
            STATE="Install",
            AF_STATUS="Non-organic",
            MEDIA_SOURCE="unityads_int",
            CAMPAIGN="C1",
            CHANNEL="unity",
            AD="Playable 1",
            SITE_ID="s1",
        ),
        at("a", 8, 0, "session_start", day=3, device_model="Pixel 7", os_version="Android 13"),
        at("a", 8, 0, "session_start", device_model="Pixel 8", os_version="Android 14"),
        at("a", 8, 1, "DEVICE_ANALYSIS", day=3, STATE="Snapshot", TIER="Low", RAM_MB=2000),
        at(
            "a",
            8,
            1,
            "DEVICE_ANALYSIS",
            STATE="Snapshot",
            TIER="High",
            RAM_MB=6000,
            CPU_CORES=8,
            GPU_MB=2000,
            QUALITY_LEVEL=2,
        ),
        at(
            "a",
            14,
            0,
            "PLAYER_ANALYSIS",
            STATE="Snapshot",
            HIGHEST_LEVEL=9,
            BALANCE_COINS=120,
            POWERUP_FIRE_DISC=3,
            HAS_PURCHASED=0,
            SUB_ACTIVE=0,
            ADS_REMOVED=0,
        ),
        at(
            "a",
            14,
            1,
            "AD_ANALYSIS",
            STATE="Revenue",
            AD_ID="ad1",
            FORMAT="Interstitial",
            REVENUE=0.004,
            NETWORK="AppLovin",
        ),
        at(
            "a",
            14,
            2,
            "AD_ANALYSIS",
            STATE="Revenue",
            AD_ID="ad2",
            FORMAT="Rewarded",
            REVENUE=0.01,
            NETWORK="AppLovin",
        ),
        at(
            "a",
            14,
            3,
            "AD_ANALYSIS",
            STATE="Revenue",
            AD_ID="ad3",
            FORMAT="Interstitial",
            REVENUE=0.002,
            NETWORK="Unity Ads",
        ),
        at("a", 8, 2, "APP_ANALYSIS", STATE="Launch", PREV_EXIT_REASON="Killed"),
        at("a", 9, 2, "APP_ANALYSIS", STATE="Launch", PREV_EXIT_REASON="Killed"),
        at("a", 9, 3, "APP_ANALYSIS", STATE="Launch", PREV_EXIT_REASON="Normal"),
        level("a", 15, 0, "Left", "att8", 3, REASON="Killed"),
        # two events at one instant, sent in the wrong order: seq puts them right
        at("a", 16, 0, "TICK", seq=2, WHICH="second"),
        at("a", 16, 0, "TICK", seq=1, WHICH="first"),
    ]


@pytest.fixture(params=["legacy", "facts"])
def game(tmp_path, request):
    settings = Settings(
        data_dir=tmp_path / "data", admin_token=TOKEN, analytics_read_mode=request.param
    )
    with TestClient(create_app(settings, admin=True)) as admin:
        game = register(admin)
        with TestClient(create_app(settings)) as ingest:
            assert send(ingest, game, events_of_the_game()).status_code == 200
        storage = admin.app.state.storage
        if request.param == "facts":
            analytics.prepare_all(storage, game["id"])
        yield admin, game, storage


@pytest.fixture
def plain_game(tmp_path):
    settings = Settings(data_dir=tmp_path / "data", admin_token=TOKEN)
    with TestClient(create_app(settings, admin=True)) as admin:
        game = register(admin)
        with TestClient(create_app(settings)) as ingest:
            assert send(ingest, game, [event()]).status_code == 200
        yield game, admin.app.state.storage


def attempts_of(storage, game, number, **more):
    return level_attempts.attempts(storage, game["id"], START, END, NO_FILTERS, number, **more)


def test_a_levels_attempts_are_joined_by_attempt_id(game):
    _, game, storage = game
    data = attempts_of(storage, game, 5)
    assert data["available"] is True and data["level"] == 5
    assert data["level_ids"] == [{"level_id": "level_164", "attempts": 5}]
    summary = data["summary"]
    assert summary["attempts"] == 5 and summary["players"] == 3
    assert summary["results"] == {
        "Completed": {"attempts": 2, "share": 0.4},
        "Failed": {"attempts": 1, "share": 0.2},
        "Left": {"attempts": 1, "share": 0.2},
        "Open": {"attempts": 1, "share": 0.2},
    }
    assert summary["completion_rate"] == round(2 / 3, 4)
    assert summary["median_seconds_completed"] == 150.0
    assert summary["p90_seconds_completed"] == 200.0
    assert summary["median_moves_left_completed"] == 6
    assert summary["share_with_revives"] == round(1 / 3, 4)
    assert summary["share_with_powerups"] == round(1 / 3, 4)
    assert summary["average_ads_per_attempt"] == 0.4  # two ads on one of five attempts
    assert summary["banner_revenue"] == 0.002
    assert summary["next_action"] == {"Restart": 1, "Next": 1, "Home": 1}
    newest = data["attempts"]
    assert [row["attempt_id"] for row in newest] == ["att5", "att4", "att3", "att2", "att1"]
    assert data["rows_matching"] == 5
    att2 = {row["attempt_id"]: row for row in newest}["att2"]
    assert att2 == {
        "attempt_id": "att2",
        "player": "a",
        "started_at": "2026-10-04T10:04:00.000000+00:00",
        "try": 2,
        "result": "Completed",
        "seconds": 100.0,
        "moves_start": 20,
        "moves_left": 4,
        "revives": 0,
        "powerups": 2,
        "ads": 2,
        "action": "Next",
        "came_from": "Restart",
    }
    att4 = {row["attempt_id"]: row for row in newest}["att4"]
    assert att4["result"] == "Left" and att4["left_reason"] == "Killed"
    assert (
        "seconds" not in att4
        and {row["attempt_id"]: row for row in newest}["att5"]["result"] == "Open"
    )


def test_the_attempt_rows_can_be_limited_and_filtered(game):
    _, game, storage = game
    assert [r["attempt_id"] for r in attempts_of(storage, game, 5, limit=2)["attempts"]] == [
        "att5",
        "att4",
    ]
    done = attempts_of(storage, game, 5, result="completed")
    assert done["rows_filter"] == "Completed" and done["rows_matching"] == 2
    assert [r["attempt_id"] for r in done["attempts"]] == ["att3", "att2"]
    assert done["summary"]["attempts"] == 5  # the summary still covers every attempt
    with pytest.raises(ValueError, match="result is one of"):
        attempts_of(storage, game, 5, result="Won")


def test_an_attempt_that_ends_after_the_range_is_still_whole(game):
    _, game, storage = game
    # att9 started on the 5th and was left on the 6th: the range ends before its result
    data = level_attempts.attempts(storage, game["id"], START, END, NO_FILTERS, 11)
    assert data["summary"]["results"]["Left"]["attempts"] == 1
    assert data["attempts"][0]["left_reason"] == "Home"
    days = period_bounds("custom", date(2026, 10, 1), date(2026, 10, 4))
    assert "No level starts" not in level_attempts.attempts(
        storage, game["id"], *days, NO_FILTERS, 9
    ).get("note", "")
    nothing = period_bounds("custom", date(2026, 10, 7), date(2026, 10, 8))
    assert (
        "No level starts"
        in level_attempts.attempts(storage, game["id"], *nothing, NO_FILTERS, 9)["note"]
    )


def test_a_level_nobody_started_says_which_levels_were(game):
    _, game, storage = game
    data = attempts_of(storage, game, 99)
    assert data["available"] is False
    assert "Nobody started level 99" in data["note"] and "from 5 to 11" in data["note"]


def test_designs_pool_every_try_at_a_level_design(game):
    _, game, storage = game
    data = level_attempts.designs(storage, game["id"], START, END, NO_FILTERS, min_attempts=1)
    assert data["available"] is True and data["designs_seen"] == 2
    assert "differs" not in data["means"] and "per-level table" in data["means"]
    assert [d["level_id"] for d in data["designs"]] == ["level_200", "level_164"]
    easy = data["designs"][1]
    assert easy == {
        "level_id": "level_164",
        "attempts": 6,
        "players": 3,
        "completion_rate": 0.75,
        "left_share": round(1 / 6, 4),
        "median_seconds_completed": 200.0,
        "level_numbers_using_it": 2,
        "level_numbers": [5, 7],
        "hard_share": round(1 / 6, 4),
        "boss_share": round(1 / 6, 4),
    }
    hard = data["designs"][0]
    assert hard["completion_rate"] == 0.0 and hard["median_seconds_completed"] is None
    assert hard["attempts"] == 2 and hard["players"] == 2 and hard["left_share"] == 0.5
    assert hard["level_numbers"] == [9, 11] and hard["level_numbers_using_it"] == 2
    by_attempts = level_attempts.designs(
        storage, game["id"], START, END, NO_FILTERS, "attempts_desc", 1, 1
    )
    assert [d["level_id"] for d in by_attempts["designs"]] == ["level_164"]
    slowest = level_attempts.designs(storage, game["id"], START, END, NO_FILTERS, "seconds_desc", 1)
    assert [d["level_id"] for d in slowest["designs"]] == ["level_164", "level_200"]
    # the default asks for 30 attempts a design
    few = level_attempts.designs(storage, game["id"], START, END, NO_FILTERS)
    assert few["designs"] == [] and few["designs_with_enough_attempts"] == 0
    with pytest.raises(ValueError, match="sort is one of"):
        level_attempts.designs(storage, game["id"], START, END, NO_FILTERS, "random")


def test_the_player_profile_answers_who_they_are(game):
    _, game, storage = game
    data = player_tools.profile(storage, game["id"], "a", START, END)
    assert data["available"] is True and data["player"] == "a"
    assert data["first_seen"] == "2026-10-03T08:00:00.000000+00:00"
    assert data["attribution"] == {
        "available": True,
        "media_source": "unityads_int",
        "campaign": "C1",
        "channel": "unity",
        "creative": "Playable 1",
        "site": "s1",
        "attribution_status": "Non-organic",
        "recorded_at": "2026-10-03T09:00:00.000000+00:00",
    }
    assert data["device"] == {
        "tier": "High",
        "ram_mb": 6000,
        "cpu_cores": 8,
        "gpu_mb": 2000,
        "quality_level": 2,
        "model": "Pixel 8",
        "os_version": "Android 14",
        "snapshot_at": "2026-10-04T08:01:00.000000+00:00",
    }
    saved = data["latest_snapshot"]
    assert saved["at"] == "2026-10-04T14:00:00.000000+00:00"
    assert saved["values"]["HIGHEST_LEVEL"] == 9 and saved["values"]["BALANCE_COINS"] == 120
    assert saved["values"]["HAS_PURCHASED"] == 0
    assert data["ad_revenue"] == {
        "available": True,
        "currency": "USD (assumed)",
        "full_screen_revenue": 0.016,
        "banner_revenue": 0.002,
        "total": 0.018,
        "impressions_by_format": {"Rewarded": 1, "Interstitial": 2, "Banner": 2},
    }
    assert data["exits"] == {
        "app_launches_by_previous_exit": {"Killed": 2, "Normal": 1},
        "levels_ended_by_kill": 1,
    }
    assert data["summary"]["levels"]["clears"] == 1 and data["summary"]["levels"]["fails"] == 2
    assert "pace" not in data["summary"]["levels"]
    assert "balance_history" not in data["summary"]["economy"]
    assert len(json.dumps(data)) < 10_000


def test_the_profile_counts_money_and_exits_only_in_the_range(game):
    _, game, storage = game
    elsewhere = period_bounds("custom", date(2026, 10, 5), date(2026, 10, 6))
    data = player_tools.profile(storage, game["id"], "a", *elsewhere)
    assert data["ad_revenue"]["available"] is False
    assert data["exits"] == {"app_launches_by_previous_exit": {}, "levels_ended_by_kill": 0}
    assert data["attribution"]["media_source"] == "unityads_int"  # all the player's events
    assert data["device"]["model"] == "Pixel 8"
    # b sent nothing about itself: sentences, not blanks
    nobody = player_tools.profile(storage, game["id"], "b", START, END)
    assert (
        nobody["attribution"]["available"] is False
        and "not the same as organic" in (nobody["attribution"]["note"])
    )
    assert nobody["device"]["available"] is False
    assert nobody["latest_snapshot"]["available"] is False
    assert player_tools.profile(storage, game["id"], "ghost", START, END)["available"] is False


def raw(storage, game, player="a", **more):
    return player_tools.raw_events(storage, game["id"], player, START, END, **more)


def test_raw_events_come_in_order_with_seq_breaking_ties(game):
    _, game, storage = game
    ticks = raw(storage, game, event="TICK")
    assert ticks["total_matching"] == 2 and ticks["next_offset"] is None
    assert [e["params"] for e in ticks["events"]] == [{"WHICH": "first"}, {"WHICH": "second"}]
    assert ticks["events"][0] == {
        "time": "2026-10-04T16:00:00.000000+00:00",
        "name": "TICK",
        "params": {"WHICH": "first"},
    }
    everything = raw(storage, game)
    times = [e["time"] for e in everything["events"]]
    assert times == sorted(times) and everything["total_matching"] == 25


def test_raw_events_follow_one_attempt_or_one_ad_and_page(game):
    _, game, storage = game
    one = raw(storage, game, attempt_id="att2")
    assert [e["name"] for e in one["events"]] == [
        "LEVEL_ANALYSIS",
        "AD_ANALYSIS",
        "AD_ANALYSIS",
        "LEVEL_ANALYSIS",
        "LEVEL_ANALYSIS",
    ]
    assert one["total_matching"] == 5 and one["returned"] == 5 and one["next_offset"] is None
    assert one["events"][0]["params"]["STATE"] == "Started"
    first = raw(storage, game, attempt_id="att2", limit=2)
    assert first["returned"] == 2 and first["next_offset"] == 2
    second = raw(storage, game, attempt_id="att2", limit=2, offset=first["next_offset"])
    assert second["offset"] == 2 and second["next_offset"] == 4
    last = raw(storage, game, attempt_id="att2", limit=2, offset=4)
    assert last["returned"] == 1 and last["next_offset"] is None
    ad = raw(storage, game, ad_id="ad1")
    assert [e["params"]["STATE"] for e in ad["events"]] == ["Show", "Revenue"]
    both = raw(storage, game, ad_id="ad1", event="AD_ANALYSIS", attempt_id="att2")
    assert both["total_matching"] == 1
    none = raw(storage, game, player="ghost")
    assert none["available"] is False and none["events"] == [] and "No events" in none["note"]
    assert "seq" not in everything_params(storage, game)


def everything_params(storage, game):
    return {key for e in raw(storage, game, event="TICK")["events"] for key in e["params"]}


def test_a_long_page_stops_before_it_is_cut(game):
    _, game, storage = game
    big = player_tools.RESULT_CHARACTERS
    assert big < 10_000
    page = raw(storage, game, limit=100)
    assert page["returned"] <= 100 and len(json.dumps(page)) < 14_000


def count(storage, game, event_name, **more):
    return counting.count_events(storage, game["id"], START, END, NO_FILTERS, event_name, **more)


def test_count_events_counts_players_and_sessions(game):
    _, game, storage = game
    done = [{"param": "STATE", "op": "eq", "value": "Completed"}]
    data = count(storage, game, "LEVEL_ANALYSIS", where=done)
    assert data["available"] is True and data["metric"] == "count"
    assert data["total"] == {"value": 3, "events": 3, "players": 3}
    assert data["rows"] == [{"group": {}, "value": 3, "events": 3, "players": 3}]
    assert (
        count(storage, game, "LEVEL_ANALYSIS", where=done, metric="players")["total"]["value"] == 3
    )
    fails = [{"param": "STATE", "op": "eq", "value": "Failed"}]
    assert count(storage, game, "LEVEL_ANALYSIS", where=fails, metric="players")["total"] == {
        "value": 1,
        "events": 2,
        "players": 1,
    }
    assert count(storage, game, "LEVEL_ANALYSIS", metric="sessions")["total"]["value"] == 3
    assert "number of events" in data["means"] and "Only events that pass" in data["means"]


def test_count_events_measures_a_numeric_parameter(game):
    _, game, storage = game
    done = [{"param": "STATE", "op": "eq", "value": "Completed"}]
    expected = {"sum": 600, "avg": 200, "min": 100, "max": 300, "median": 200, "p90": 300}
    for metric, value in expected.items():
        data = count(storage, game, "LEVEL_ANALYSIS", where=done, metric=metric, param="SECONDS")
        assert data["total"]["value"] == value, metric
        assert data["total"]["ignored"] == 0
    slow = count(
        storage,
        game,
        "LEVEL_ANALYSIS",
        where=[*done, {"param": "SECONDS", "op": "gt", "value": 150}],
    )
    assert slow["total"]["events"] == 2
    revenue = count(
        storage,
        game,
        "AD_ANALYSIS",
        where=[{"param": "STATE", "op": "eq", "value": "Revenue"}],
        metric="sum",
        param="REVENUE",
    )
    assert revenue["total"]["value"] == 0.016
    # a failed attempt without MOVES_LEFT is ignored, not counted as zero
    moves = count(
        storage,
        game,
        "LEVEL_ANALYSIS",
        where=[{"param": "STATE", "op": "eq", "value": "Failed"}],
        metric="avg",
        param="MOVES_LEFT",
    )
    assert moves["total"] == {"value": 0, "events": 2, "players": 1, "ignored": 1}
    with pytest.raises(ValueError, match="needs param"):
        count(storage, game, "LEVEL_ANALYSIS", metric="sum")


def test_count_events_groups_orders_and_limits(game):
    _, game, storage = game
    done = [{"param": "STATE", "op": "eq", "value": "Completed"}]
    by_level = count(storage, game, "LEVEL_ANALYSIS", where=done, group_by=["param:LEVEL_NUMBER"])
    assert by_level["rows"] == [
        {"group": {"param:LEVEL_NUMBER": 5}, "value": 2, "events": 2, "players": 2},
        {"group": {"param:LEVEL_NUMBER": 7}, "value": 1, "events": 1, "players": 1},
    ]
    assert by_level["groups"] == 2
    low = count(
        storage,
        game,
        "LEVEL_ANALYSIS",
        where=done,
        group_by=["param:LEVEL_NUMBER"],
        order="value_asc",
        limit=1,
    )
    assert [r["group"]["param:LEVEL_NUMBER"] for r in low["rows"]] == [7]
    assert "2 groups matched; showing 1" in low["note"]
    medians = count(
        storage,
        game,
        "LEVEL_ANALYSIS",
        where=done,
        group_by=["param:LEVEL_NUMBER"],
        metric="median",
        param="SECONDS",
    )
    assert [(r["group"]["param:LEVEL_NUMBER"], r["value"]) for r in medians["rows"]] == [
        (7, 300),
        (5, 150.0),
    ]
    by_group = count(
        storage,
        game,
        "LEVEL_ANALYSIS",
        where=done,
        group_by=["param:LEVEL_NUMBER"],
        metric="median",
        param="SECONDS",
        order="group",
    )
    assert [r["group"]["param:LEVEL_NUMBER"] for r in by_group["rows"]] == [5, 7]
    two = count(
        storage,
        game,
        "LEVEL_ANALYSIS",
        where=done,
        group_by=["day", "platform"],
    )
    assert two["rows"] == [
        {
            "group": {"day": "2026-10-04", "platform": "android"},
            "value": 3,
            "events": 3,
            "players": 3,
        }
    ]
    levels = count(storage, game, "LEVEL_ANALYSIS", group_by=["param:LEVEL_ID", "param:STATE"])
    assert levels["groups"] == 6
    assert levels["rows"][0] == {
        "group": {"param:LEVEL_ID": "level_164", "param:STATE": "Started"},
        "value": 6,
        "events": 6,
        "players": 3,
    }


def test_count_events_only_takes_plain_names_and_known_operators(game):
    _, game, storage = game
    bad_names = ["SECONDS) FROM events--", "A'B", 'A"B', "1A", "A B", "x" * 90]
    for name in bad_names:
        with pytest.raises(ValueError, match="plain name"):
            count(storage, game, "LEVEL_ANALYSIS", metric="sum", param=name)
        with pytest.raises(ValueError, match="plain name"):
            count(storage, game, "LEVEL_ANALYSIS", where=[{"param": name, "op": "exists"}])
        with pytest.raises(ValueError):
            count(storage, game, "LEVEL_ANALYSIS", group_by=[f"param:{name}"])
    with pytest.raises(ValueError, match="group_by items"):
        count(storage, game, "LEVEL_ANALYSIS", group_by=["country; DROP TABLE events"])
    with pytest.raises(ValueError, match="at most 2"):
        count(storage, game, "LEVEL_ANALYSIS", group_by=["day", "country", "build"])
    with pytest.raises(ValueError, match="op is one of"):
        count(
            storage, game, "LEVEL_ANALYSIS", where=[{"param": "STATE", "op": "like", "value": "x"}]
        )
    with pytest.raises(ValueError, match="at most 6"):
        count(storage, game, "LEVEL_ANALYSIS", where=[{"param": "STATE", "op": "exists"}] * 7)
    with pytest.raises(ValueError, match="metric is one of"):
        count(storage, game, "LEVEL_ANALYSIS", metric="mode")
    with pytest.raises(ValueError, match="order is one of"):
        count(storage, game, "LEVEL_ANALYSIS", order="random")
    with pytest.raises(ValueError, match="Compare with a number"):
        count(
            storage, game, "LEVEL_ANALYSIS", where=[{"param": "SECONDS", "op": "gt", "value": "x"}]
        )
    # a hostile value is only ever a bound argument, and nothing was changed
    hostile = count(
        storage,
        game,
        "LEVEL_ANALYSIS",
        where=[{"param": "STATE", "op": "eq", "value": "x' OR 1=1--"}],
    )
    assert hostile["available"] is False
    assert count(storage, game, "LEVEL_ANALYSIS")["total"]["events"] == 18


def test_a_game_without_the_events_gets_a_sentence_not_zeros(plain_game):
    game, storage = plain_game
    for data in (
        level_attempts.attempts(storage, game["id"], START, END, NO_FILTERS, 1),
        level_attempts.designs(storage, game["id"], START, END, NO_FILTERS),
    ):
        assert data["available"] is False and "may not send LEVEL_ANALYSIS" in data["note"]
    assert player_tools.profile(storage, game["id"], "nobody", START, END)["available"] is False
    assert raw_none(storage, game)["available"] is False
    missing = counting.count_events(storage, game["id"], START, END, NO_FILTERS, "NOPE")
    assert missing["available"] is False and "No NOPE events" in missing["note"]


def raw_none(storage, game):
    return player_tools.raw_events(storage, game["id"], "nobody", START, END)


def test_starts_without_attempt_ids_cannot_be_joined(tmp_path):
    settings = Settings(data_dir=tmp_path / "data", admin_token=TOKEN)
    with TestClient(create_app(settings, admin=True)) as admin:
        game = register(admin)
        with TestClient(create_app(settings)) as ingest:
            old = at("a", 10, 0, "LEVEL_ANALYSIS", STATE="Started", LEVEL_NUMBER=1)
            assert send(ingest, game, [old]).status_code == 200
        storage = admin.app.state.storage
        data = level_attempts.attempts(storage, game["id"], START, END, NO_FILTERS, 1)
        assert data["available"] is False and "ATTEMPT_ID" in data["note"]


def test_segments_narrow_the_attempts(game):
    _, game, storage = game
    from avn_analytics import segments

    only_a = {**NO_FILTERS, "segments": segments.parse({"media_source": ["unityads_int"]})}
    data = level_attempts.attempts(storage, game["id"], START, END, only_a, 5)
    assert data["summary"]["attempts"] == 2 and data["summary"]["players"] == 1
    counted = counting.count_events(storage, game["id"], START, END, only_a, "LEVEL_ANALYSIS")
    assert counted["total"]["players"] == 1


def test_the_tools_are_served_to_agents_with_a_key(game):
    admin, game, _ = game
    names = {tool["name"] for tool in PLAYER_TOOLS}
    assert names == set(PLAYER_READ_ONLY) and len(names) == 5
    assert not any(
        n.startswith(("save", "set", "propose", "show", "delete", "update", "create", "restore"))
        for n in names
    )
    made = admin.post(
        "/v1/mcp-keys", headers=AUTH, json={"name": "players", "game_ids": [game["id"]]}
    ).json()
    headers = {"Authorization": f"Bearer {made['secret']}"}
    listed = admin.post(
        "/mcp", headers=headers, json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"}
    ).json()["result"]["tools"]
    assert names <= {t["name"] for t in listed}
    segmented = {t["name"] for t in listed if "segment" in t["inputSchema"]["properties"]}
    assert {"get_level_attempts", "get_level_designs", "count_events"} <= segmented
    assert not {"get_player_profile", "get_player_raw_events"} & segmented

    def call(name, **arguments):
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
                        **arguments,
                    },
                },
            },
        ).json()["result"]
        text = reply["content"][0]["text"]
        return reply["isError"], text if reply["isError"] else json.loads(text)

    error, data = call("get_level_attempts", level=5)
    assert not error and data["summary"]["attempts"] == 5
    error, data = call("get_level_designs", min_attempts=1)
    assert not error and data["designs"][0]["level_id"] == "level_200"
    error, data = call("get_player_profile", player="a")
    assert not error and data["attribution"]["media_source"] == "unityads_int"
    error, data = call("get_player_raw_events", player="a", attempt_id="att2", limit=3)
    assert not error and data["returned"] == 3 and data["next_offset"] == 3
    error, data = call(
        "count_events",
        event="LEVEL_ANALYSIS",
        where=[{"param": "STATE", "op": "eq", "value": "Completed"}],
        metric="sum",
        param="SECONDS",
        group_by=["param:LEVEL_NUMBER"],
        segment={"media_source": ["unityads_int"]},
    )
    assert not error and data["total"]["value"] == 100

    for name, arguments in (
        ("get_level_attempts", {}),
        ("get_level_attempts", {"level": 5, "result": "Won"}),
        ("get_level_designs", {"sort": "random"}),
        ("get_player_profile", {}),
        ("get_player_raw_events", {}),
        ("count_events", {}),
        ("count_events", {"event": "LEVEL_ANALYSIS", "group_by": ["param:A;B"]}),
        ("count_events", {"event": "LEVEL_ANALYSIS", "metric": "sum"}),
        ("count_events", {"event": "LEVEL_ANALYSIS", "segment": {"bogus": ["x"]}}),
    ):
        error, text = call(name, **arguments)
        assert error, (name, arguments)
        assert isinstance(text, str) and text
