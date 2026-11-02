"""Why players left a level: the tag on each quit, and the players who came back later."""

import pytest
from fastapi.testclient import TestClient
from test_backend import AUTH, TOKEN, event, register, send

from avn_analytics.api import create_app
from avn_analytics.config import Settings

DAY = "2026-10-04"


@pytest.fixture
def game(tmp_path):
    settings = Settings(data_dir=tmp_path, admin_token=TOKEN)
    with TestClient(create_app(settings, admin=True)) as admin:
        with TestClient(create_app(settings)) as ingest:
            admin.headers.update(AUTH)
            yield admin, ingest, register(admin)


class Play:
    """One player's events, a second apart, numbered as the SDK does."""

    def __init__(self, player="p", second=0):
        self.player, self.session, self.seq, self.second = player, "s1", 0, second
        self.events = []

    def add(self, name, **params):
        self.seq += 1
        self.second += 1
        stamp = (
            f"{DAY}T{self.second // 3600:02d}:{self.second // 60 % 60:02d}:{self.second % 60:02d}Z"
        )
        self.events.append(
            event(
                device_id=self.player,
                session_id=self.session,
                name=name,
                params={"seq": self.seq, **params},
                client_ts=stamp,
            )
        )
        return self

    def level(self, state, number=1):
        return self.add("LEVEL_ANALYSIS", STATE=state, LEVEL_NUMBER=number)

    def ad(self, state, ad_id="a", kind="Interstitial", **params):
        return self.add("AD_ANALYSIS", STATE=state, FORMAT=kind, AD_ID=ad_id, **params)

    def background(self, cause="Player"):
        return self.add("APP_ANALYSIS", STATE="Background", CAUSE=cause)

    def wait(self, seconds):
        self.second += seconds
        return self

    def next_session(self, name, wait=600):
        self.session, self.seq = name, 0
        return self.wait(wait)


def tags(game, *plays, level=1, group="total_drop"):
    admin, ingest, record = game
    assert send(ingest, record, [item for play in plays for item in play.events]).is_success
    data = admin.get(
        f"/v1/games/{record['id']}/insights/levels/players",
        params={"start": DAY, "end": "2026-10-05", "level": level, "group": group},
    ).json()
    return {row["player"]: row["last_action"] for row in data["players"]}, data


def ended(*steps):
    """A session that reached its end, so the tag is exact: the player came back to another."""
    play = Play()
    for step in steps:
        step(play)
    play.next_session("s2").add("MM_ANALYSIS", STATUS="OPENED")
    return play


def started(play):
    play.level("Started")


CASES = {
    "an ad open behind a level start is the ad": (
        [lambda p: p.level("Completed", 0), lambda p: p.ad("Show"), started],
        "Left during interstitial ad",
    ),
    "the same ad, closed, is not": (
        [lambda p: p.ad("Show"), lambda p: p.ad("Closed"), lambda p: p.wait(120), started],
        "Left in the level",
    ),
    "an ad closed just before leaving still is": (
        [started, lambda p: p.ad("Show"), lambda p: p.ad("Closed")],
        "Left after interstitial ad",
    ),
    "a rewarded ad open": (
        [started, lambda p: p.ad("Show", kind="Rewarded")],
        "Left during rewarded ad",
    ),
    "a rewarded ad closed without the reward": (
        [started, lambda p: p.ad("Show", kind="Rewarded")]
        + [lambda p: p.ad("Closed", kind="Rewarded", REWARDED=0)],
        "Left after rewarded ad, no reward",
    ),
    "a short format name": (
        [started, lambda p: p.ad("Show", kind="Inter")],
        "Left during interstitial ad",
    ),
    "an ad that failed": (
        [started, lambda p: p.ad("Failed", kind="Rewarded")],
        "Left after rewarded ad failed to show",
    ),
    "the app going away for an ad, with no ad event": (
        [started, lambda p: p.background("Ad")],
        "Left during an ad",
    ),
    "the player leaving by hand clears an ad that never closed": (
        [lambda p: p.ad("Show"), started, lambda p: p.background("Player")],
        "Left in the level",
    ),
    "a store sheet": ([started, lambda p: p.background("Purchase")], "Left during a purchase"),
    "a buy button": (
        [started, lambda p: p.add("IAP_ANALYSIS", STATE="Clicked", PRODUCT="coins")],
        "Left during a purchase",
    ),
    "a screen left open": (
        [started, lambda p: p.add("SCREEN_ANALYSIS", STATE="Opened", SCREEN="settings_menu")],
        "Left on settings menu",
    ),
    "a screen before the level is not the reason": (
        [lambda p: p.add("SCREEN_ANALYSIS", STATE="Opened", SCREEN="home"), started],
        "Left in the level",
    ),
    "a tutorial": (
        [started, lambda p: p.add("TUTORIAL_ANALYSIS", STATE="Shown", TUTORIAL="aim")],
        "Left during the tutorial",
    ),
    "rewards are not why": (
        [started, lambda p: p.add("ECONOMY_ANALYSIS", STATE="Earned", AMOUNT=5)],
        "Left in the level",
    ),
    "choosing Next": (
        [
            started,
            lambda p: p.level("Failed"),
            lambda p: p.add("ECONOMY_ANALYSIS", STATE="Earned", AMOUNT=5),
            lambda p: p.add("LEVEL_ANALYSIS", STATE="Choice", ACTION="Next", LEVEL_NUMBER=1),
        ],
        "Left after choosing next",
    ),
    "a level result": (
        [started, lambda p: p.level("Failed")],
        "Left after failing the level",
    ),
    "the level's own quit button": (
        [started, lambda p: p.add("LEVEL_ANALYSIS", STATE="Left", REASON="Home", LEVEL_NUMBER=1)],
        "Left after quitting the level (home)",
    ),
}


@pytest.mark.parametrize("name", CASES)
def test_a_session_ending_reads_as_what_happened(game, name):
    steps, expected = CASES[name]
    found, _ = tags(game, ended(*steps))
    assert found["p"] == expected


def test_a_tie_on_the_clock_is_settled_by_seq(game):
    """Stored order breaks a tie by event_id, which is random; seq is what really happened."""
    play = Play().level("Started").level("Failed")
    play.add("LEVEL_ANALYSIS", STATE="Choice", ACTION="Next", LEVEL_NUMBER=1)
    result, choice = play.events[-2:]
    choice["client_ts"] = result["client_ts"]
    result["event_id"] = "ffffffff-ffff-4fff-bfff-ffffffffffff"
    choice["event_id"] = "00000000-0000-4000-8000-000000000000"
    found, _ = tags(game, play.next_session("s2").add("MM_ANALYSIS", STATUS="OPENED"))
    assert found["p"] == "Left after choosing next"


def test_without_an_ending_it_says_last_seen_and_counts_them(game):
    lost = Play("lost").level("Started").level("Failed")
    known = Play("known").level("Started").background()
    found, data = tags(game, lost, known)
    assert found == {"lost": "Last seen after failing the level", "known": "Left in the level"}
    assert data["no_ending"] == 1
    rows = {row["player"]: row for row in data["players"]}
    assert rows["lost"]["ending_known"] is False
    assert rows["known"]["ending_known"] is True


def test_the_new_sdks_end_counts_as_arrived_but_not_one_followed_by_more_play(game):
    left = Play("left").level("Started")
    left.add("session_end", end_reason="background", duration_seconds=5)
    resumed = Play("resumed").level("Started")
    resumed.add("session_end", end_reason="background", duration_seconds=5)
    resumed.level("Failed")
    found, _ = tags(game, left, resumed)
    assert found == {"left": "Left in the level", "resumed": "Last seen after failing the level"}


def test_the_next_launch_says_how_the_app_stopped(game):
    play = Play().level("Started").ad("Show").next_session("s2")
    play.add(
        "APP_ANALYSIS",
        STATE="Launch",
        PREV_EXIT="Background",
        PREV_EXIT_REASON="UserRequested",
        PREV_EXIT_AD="Interstitial",
    )
    _, data = tags(game, play)
    row = data["players"][0]
    assert (row["prev_exit_reason"], row["prev_exit_ad"]) == ("UserRequested", "Interstitial")


def came_back_rows(game, *plays, level=1):
    return tags(game, *plays, level=level, group="came_back_later")[1]


@pytest.mark.parametrize("scope,unfiltered_drop", [("all", 3), ("first_session", 4)])
def test_excluding_returners_changes_only_stop_counts(game, scope, unfiltered_drop):
    straight = Play("straight").level("Started").ad("Show").ad("Closed")
    straight.level("Completed").level("Started", 2)
    progressed = Play("progressed").level("Started").ad("Show").next_session("s2")
    progressed.level("Started", 2)
    retry = Play("retry").level("Started").level("Failed").ad("Show").next_session("s2")
    retry.level("Started").level("Failed")
    menu = Play("menu").level("Started").level("Completed").ad("Show").next_session("s2")
    menu.add("MM_ANALYSIS", STATUS="OPENED")
    gone = Play("gone").level("Started").level("Failed").ad("Show")
    admin, ingest, record = game
    assert send(
        ingest, record, [e for p in (straight, progressed, retry, menu, gone) for e in p.events]
    ).is_success
    root = f"/v1/games/{record['id']}/insights/levels"
    params = {"start": DAY, "end": "2026-10-05", "scope": scope}
    original = admin.get(root, params=params).json()
    selected = {**params, "exclude_returners": True}
    row = admin.get(root, params=selected).json()["levels"][0]
    assert original["levels"][0]["transition"]["total_drop"] == unfiltered_drop
    assert row["started"] == 5
    for key in ("completed", "attempts", "fails", "tries_per_player"):
        assert row[key] == original["levels"][0][key]
    assert row["transition"]["total_drop"] == 1
    assert row["transition"]["drop_percent"] == 20
    assert row["transition"]["failed"] == 2
    assert row["transition"]["failed_left"] == 1
    assert row["transition"]["fail_drop_percent"] == 50
    assert row["transition"]["came_back_later"] == 3

    drill = admin.get(root + "/players", params={**selected, "level": 1}).json()
    assert [p["player"] for p in drill["players"]] == ["gone"]
    assert drill["total"] == drill["counts"]["total_drop"] == 1
    assert sum(p["players"] for p in drill["last_actions"]) == 1
    returned = admin.get(
        root + "/players", params={**selected, "level": 1, "group": "came_back_later"}
    ).json()
    assert {p["player"] for p in returned["players"]} == {"progressed", "retry", "menu"}

    features = admin.get(root + "/features", params=selected).json()["levels"][0]
    original_features = admin.get(root + "/features", params=params).json()["levels"][0]
    assert features["started"] == original_features["started"] == 5
    ad = features["things"]["ads"]["Interstitial"]
    assert ad["players"] == ad["times"] == 5
    assert ad["dropped"] == features["dropped"] == 1
    assert ad["left_session"] == features["left_session"] == 1
    assert ad["right_after"] == 1
    # The cached/prepared scan must not be mutated when switching this option.
    assert admin.get(root, params=params).json() == original


def test_return_filter_respects_end_date_and_follows_version_updates(game):
    returned = Play("returned").level("Started").level("Failed").next_session("s2")
    returned.add("MM_ANALYSIS", STATUS="OPENED")
    returned.events[-1]["client_ts"] = returned.events[-1]["client_ts"].replace(DAY, "2026-10-05")
    returned.events[-1]["app_version"] = "2.0"
    straight = Play("straight").level("Started").level("Started", 2)
    admin, ingest, record = game
    assert send(ingest, record, returned.events + straight.events).is_success
    root = f"/v1/games/{record['id']}/insights/levels"
    params = {"start": DAY, "end": DAY, "exclude_returners": True}
    assert admin.get(root, params=params).json()["levels"][0]["transition"]["total_drop"] == 1
    params["end"] = "2026-10-05"
    assert admin.get(root, params=params).json()["levels"][0]["transition"]["total_drop"] == 0


def test_players_who_left_and_returned_get_their_own_tab(game):
    straight = Play("straight").level("Started").level("Completed").level("Started", 2)
    returned = Play("returned").level("Started").ad("Show").next_session("s2", wait=600)
    returned.add("MM_ANALYSIS", STATUS="OPENED").level("Started").level("Completed")
    returned.level("Started", 2)
    stuck = Play("stuck").level("Started").level("Failed").next_session("s2", wait=120)
    stuck.level("Started").level("Failed")
    gone = Play("gone").level("Started").level("Failed")
    data = came_back_rows(game, straight, returned, stuck, gone)
    rows = {row["player"]: row for row in data["players"]}
    assert set(rows) == {"returned", "stuck"}
    assert rows["returned"]["last_action"] == "Left during interstitial ad"
    assert rows["returned"]["reached_next"] is True
    assert rows["returned"]["passed"] is True
    assert rows["returned"]["away_seconds"] == 601.0
    assert rows["stuck"]["last_action"] == "Left after failing the level"
    assert rows["stuck"]["reached_next"] is False
    assert rows["stuck"]["passed"] is False
    counts = data["counts"]
    assert counts["kept_going"] == 2  # the Drop still counts everyone who got there
    assert counts["straight_on"] == 1
    assert counts["came_back_later"] == 2
    assert counts["total_drop"] == 2


def test_the_quit_tabs_keep_their_size_with_a_returner_in_them(game):
    play = Play().level("Started").level("Completed").next_session("s2")
    play.add("MM_ANALYSIS", STATUS="OPENED")
    found, data = tags(game, play, group="finished_stopped")
    assert found["p"] == "Left after finishing the level"
    assert data["counts"]["finished_stopped"] == 1
    assert data["counts"]["came_back_later"] == 1


def test_a_tag_keeps_only_its_players_in_the_came_back_tab(game):
    first = Play("first").level("Started").ad("Show").next_session("s2")
    first.add("MM_ANALYSIS", STATUS="OPENED")
    second = Play("second").level("Started").level("Failed").next_session("s2")
    second.add("MM_ANALYSIS", STATUS="OPENED")
    admin, _, record = game
    tags(game, first, second, group="came_back_later")
    data = admin.get(
        f"/v1/games/{record['id']}/insights/levels/players",
        params={
            "start": DAY,
            "end": "2026-10-05",
            "level": 1,
            "group": "came_back_later",
            "last_action": "Left during interstitial ad",
        },
    ).json()
    assert [row["player"] for row in data["players"]] == ["first"]
    assert {item["text"] for item in data["last_actions"]} == {
        "Left during interstitial ad",
        "Left after failing the level",
    }
