"""One session, worked out when a page is read: session_state.py and the pages that use it."""

from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from test_backend import AUTH, TOKEN, event, register

from avn_analytics import session_report, session_state
from avn_analytics.api import create_app
from avn_analytics.config import Settings
from avn_analytics.session_state import SessionState

NOW = datetime(2026, 11, 2, 12, 0, tzinfo=UTC)


def stamp(minute, second=0.0):
    return (NOW + timedelta(minutes=minute, seconds=second)).isoformat()


def session(*events, received=None):
    state = SessionState()
    for name, minute, seq, params in events:
        state.add(name, stamp(minute), received or stamp(minute), seq, params)
    return state


def background(minute, seq, duration, reason="background"):
    params = {"end_reason": reason, "duration_seconds": duration}
    return ("session_end", minute, seq, params)


def app(minute, seq, **params):
    return ("APP_ANALYSIS", minute, seq, params)


START = ("session_start", 0, 1, {"session_timeout_seconds": 1800})
IDLE = NOW + timedelta(minutes=46)


def test_quit_and_recovered_close_at_once():
    for reason in ("quit", "recovered"):
        state = session(START, background(5, 9, 280.0, reason))
        now = NOW + timedelta(minutes=5, seconds=1)
        assert state.outcome(now) == ("closed", "client", reason, False)
        assert state.seconds == 280.0


def test_a_background_end_stays_open_until_the_timeout_and_grace_pass():
    state = session(START, background(5, 9, 280.0))
    assert state.outcome(NOW + timedelta(minutes=10)) == ("open", None, None, True)
    # Past the timeout, not past the grace: it may still come back, but it isn't playing.
    assert state.outcome(NOW + timedelta(minutes=40)) == ("open", None, None, False)
    assert state.outcome(NOW + timedelta(minutes=50, seconds=1)) == (
        "closed",
        "client",
        "background",
        False,
    )


def test_events_after_the_last_end_mean_the_server_had_to_guess():
    state = session(START, background(5, 9, 280.0), ("level", 6, 10, {}))
    assert state.outcome(IDLE + timedelta(minutes=6)) == ("closed", "server", "inferred", False)


def test_no_end_at_all_is_closed_by_the_server():
    state = session(START, ("level", 3, 2, {}))
    assert state.outcome(IDLE + timedelta(minutes=3)) == ("closed", "server", "inferred", False)
    assert state.seconds == 180.0


def test_the_highest_seq_end_wins_whatever_order_they_arrive_in():
    ends = [background(5, 9, 280.0), background(9, 20, 500.0, "quit")]
    for order in (ends, ends[::-1]):
        state = session(START, *order)
        assert state.outcome(NOW + timedelta(hours=1)) == ("closed", "client", "quit", False)
        assert state.seconds == 500.0


def test_idle_is_judged_on_the_servers_clock_not_the_phones():
    state = session(START, ("level", 1, 2, {}), received=stamp(120))
    assert state.outcome(NOW + timedelta(minutes=121))[0] == "open"


def test_a_late_event_reopens_a_closed_answer():
    state = session(START, background(5, 9, 280.0))
    assert state.outcome(NOW + timedelta(hours=2))[1] == "client"
    state.add("level", stamp(6), stamp(130), 10, {})
    assert state.outcome(NOW + timedelta(minutes=131))[0] == "open"


def test_time_away_is_taken_off_only_when_the_session_did_not_end_last():
    no_breaks = session(START, ("level", 2, 2, {}), background(5, 3, 300.0))
    assert no_breaks.seconds == 300.0
    ad = session(
        START,
        app(1, 2, STATE="Background", CAUSE="Ad"),
        app(1.5, 3, STATE="Foreground", CAUSE="Ad", AWAY_SECONDS=30.0),
        ("level", 5, 4, {}),
    )
    assert ad.seconds == 270.0
    assert ad.away_seconds == 30.0
    assert ad.trips == ["Ad"]


def test_a_return_past_the_timeout_belongs_to_no_session():
    state = session(
        ("session_start", 0, 1, {"session_timeout_seconds": 600}),
        app(0, 2, STATE="Foreground", CAUSE="Player", AWAY_SECONDS=601.0),
        ("level", 2, 3, {}),
    )
    assert state.away_seconds == 0
    assert state.seconds == 120.0


def test_no_session_is_ever_negative():
    state = session(START, app(1, 2, STATE="Foreground", AWAY_SECONDS=120.0))
    assert state.seconds == 0.0


def test_a_recovered_end_is_final_though_the_last_seconds_outnumber_it():
    """It carries the seq last saved on disk, so the final 30 seconds of play can be above it."""
    state = session(START, ("level", 5, 40, {}), background(4.5, 30, 270.0, "recovered"))
    assert state.outcome(NOW + timedelta(minutes=5))[:3] == ("closed", "client", "recovered")
    assert state.seconds == 300.0  # first to last: the real last event, not the end's stamp


def test_older_sdks_count_as_recovered_and_are_flagged():
    state = session(("session_start", 0, 1, {}), ("session_end", 5, 2, {"duration_seconds": 90}))
    assert state.outcome(NOW)[:3] == ("closed", "client", "recovered")
    assert state.seconds == 90.0
    assert state.summary(NOW)["measured_old_way"] is True
    assert session(START).summary(NOW)["measured_old_way"] is False


def test_events_without_a_seq_are_ordered_by_time():
    state = session(
        ("session_start", 0, None, {}), ("session_end", 5, None, {"end_reason": "quit"})
    )
    assert state.ended_last
    state.add("level", stamp(6), stamp(6), None, {})
    assert not state.ended_last


@pytest.fixture
def game(tmp_path):
    settings = Settings(data_dir=tmp_path, admin_token=TOKEN)
    with TestClient(create_app(settings, admin=True)) as admin:
        with TestClient(create_app(settings)) as ingest:
            admin.headers.update(AUTH)
            yield admin, ingest, register(admin)


def post(ingest, game, body, **headers):
    key = {"X-API-Key": game["key"]["api_key"]}
    return ingest.post("/v1/events", headers={**key, **headers}, json=body)


def send(ingest, game, events, **headers):
    return post(ingest, game, {"events": events}, **headers)


DAY = "2026-10-05"


def at(moment):
    return f"{DAY}T{moment}Z"


def played(session_id, *rows, device="p1", version="2.0", platform="android"):
    return [
        event(
            device_id=device,
            session_id=session_id,
            name=name,
            params=params,
            client_ts=at(moment),
            app_version=version,
            platform=platform,
        )
        for name, moment, params in rows
    ]


def left(moment, seq, duration):
    params = {"seq": seq, "end_reason": "background", "duration_seconds": duration}
    return ("session_end", moment, params)


def sessions_page(admin, game, start=DAY, end=DAY, **query):
    answer = admin.get(
        f"/v1/games/{game['id']}/insights/sessions", params={"start": start, "end": end, **query}
    )
    assert answer.status_code == 200, answer.text
    return answer.json()


@pytest.fixture
def later(monkeypatch):
    moment = session_state.clock() + timedelta(hours=2)
    monkeypatch.setattr(session_state, "clock", lambda: moment)


def test_page_reads_length_endings_and_why_players_left(game, later):
    admin, ingest, game_id = game
    events = [
        *played(
            "new",
            ("session_start", "10:00:00", {"seq": 1, "session_timeout_seconds": 1800}),
            ("APP_ANALYSIS", "10:01:00", {"seq": 2, "STATE": "Background", "CAUSE": "Ad"}),
            (
                "session_end",
                "10:01:01",
                {"seq": 3, "end_reason": "background", "duration_seconds": 60},
            ),
            (
                "APP_ANALYSIS",
                "10:01:31",
                {"seq": 4, "STATE": "Foreground", "CAUSE": "Ad", "AWAY_SECONDS": 30},
            ),
            ("APP_ANALYSIS", "10:03:01", {"seq": 5, "STATE": "Background", "CAUSE": "Player"}),
            (
                "session_end",
                "10:03:02",
                {"seq": 6, "end_reason": "background", "duration_seconds": 150},
            ),
        ),
        *played(
            "killed",
            ("session_start", "11:00:00", {"seq": 1, "session_timeout_seconds": 1800}),
            ("level", "11:02:00", {"seq": 2}),
            device="p2",
        ),
        *played(
            "launch",
            ("session_start", "12:00:00", {"seq": 1, "session_timeout_seconds": 1800}),
            (
                "APP_ANALYSIS",
                "12:00:01",
                {
                    "seq": 2,
                    "STATE": "Launch",
                    "PREV_EXIT": "Background",
                    "PREV_EXIT_REASON": "UserRequested",
                    "PREV_EXIT_IMPORTANCE": "Cached",
                    "PREV_EXIT_AD": "Interstitial",
                },
            ),
            ("APP_ANALYSIS", "12:00:02", {"seq": 3, "STATE": "Launch", "PREV_EXIT": "Background"}),
            ("APP_ANALYSIS", "12:00:03", {"seq": 4, "STATE": "Launch", "PREV_EXIT": "Quit"}),
            ("session_end", "12:10:00", {"seq": 5, "end_reason": "quit", "duration_seconds": 600}),
            device="p3",
        ),
    ]
    assert send(ingest, game_id, events).status_code == 200
    page = sessions_page(admin, game_id)
    assert page["sessions"] == 3
    assert page["closed"] == 3
    assert page["ends"] == {"background": 1, "inferred": 1, "quit": 1}
    assert page["median_seconds"] == 150.0  # 120, 150, 600
    assert page["average_seconds"] == 290.0
    assert page["away_seconds"] == 30.0
    assert page["ad_away_seconds"] == 30.0
    assert {row["cause"]: row["trips"] for row in page["leaves"]} == {"Ad": 1, "Player": 1}
    assert [row["sessions"] for row in page["trips"]][:3] == [2, 0, 1]
    runs = page["previous_runs"]
    assert runs["total"] == 2  # the clean quit isn't one
    rows = {row["reason"]: row for row in runs["rows"]}
    assert rows["UserRequested"]["ads"] == {"Interstitial": 1}
    assert rows["UserRequested"]["importance"] == "Cached"
    assert rows["Unknown"]["ads"] == {"unknown": 1}  # absent: an older app, not "no ad"


def test_a_session_belongs_to_the_day_it_started_and_is_whole(game, later):
    admin, ingest, game_id = game
    events = [
        event(
            device_id="p",
            session_id="midnight",
            name=name,
            params=params,
            client_ts=moment,
        )
        for name, moment, params in (
            ("session_start", "2026-10-04T23:50:00Z", {"seq": 1}),
            ("session_end", "2026-10-05T00:10:00Z", {"seq": 2, "duration_seconds": 1200}),
        )
    ]
    assert send(ingest, game_id, events).status_code == 200
    assert sessions_page(admin, game_id, "2026-10-05", "2026-10-05")["sessions"] == 0
    page = sessions_page(admin, game_id, "2026-10-04", "2026-10-04")
    assert page["sessions"] == 1
    assert page["median_seconds"] == 1200.0
    both = sessions_page(admin, game_id, "2026-10-04", "2026-10-05")
    assert [(day["day"], day["sessions"]) for day in both["days"]] == [("2026-10-04", 1)]
    overview = admin.get(
        f"/v1/games/{game_id['id']}/insights/summary",
        params={"start": "2026-10-04", "end": "2026-10-05"},
    ).json()
    assert overview["sessions"] == 1
    assert [(day["day"], day["sessions"]) for day in overview["days"]] == [
        ("2026-10-04", 1),
        ("2026-10-05", 0),
    ]


def test_averages_leave_out_sessions_still_open(game):
    admin, ingest, game_id = game
    events = played(
        "open",
        ("session_start", "10:00:00", {"seq": 1, "session_timeout_seconds": 1800}),
        (
            "session_end",
            "10:05:00",
            {"seq": 2, "end_reason": "background", "duration_seconds": 300},
        ),
    )
    assert send(ingest, game_id, events).status_code == 200
    page = sessions_page(admin, game_id)  # just received, so the player may be back
    assert (page["sessions"], page["closed"], page["in_progress"]) == (1, 0, 1)
    assert page["average_seconds"] is None
    assert page["play_seconds"] == 300.0
    players = admin.get(
        f"/v1/games/{game_id['id']}/insights/players", params={"start": DAY, "end": DAY}
    ).json()["players"]
    assert players[0]["avg_session_seconds"] is None
    assert players[0]["total_play_seconds"] == 300.0


def test_the_first_version_measured_the_new_way_is_marked(game, later):
    admin, ingest, game_id = game
    events = [
        *played(
            "old",
            ("session_start", "09:00:00", {"seq": 1}),
            ("session_end", "09:01:00", {"seq": 2, "duration_seconds": 60}),
            version="1.9",
        ),
        *played(
            "new",
            ("session_start", "10:00:00", {"seq": 1, "session_timeout_seconds": 1800}),
            ("session_end", "10:01:00", {"seq": 2, "end_reason": "quit", "duration_seconds": 60}),
            version="2.0",
        ),
    ]
    assert send(ingest, game_id, events).status_code == 200
    page = sessions_page(admin, game_id)
    assert page["measure_change"]["version"] == "2.0"
    assert page["measure_change"]["day"] == DAY
    assert page["old_way"] == 1


def test_data_quality_counts_duplicates_refusals_and_delivery(game, later):
    admin, ingest, game_id = game
    events = played(
        "s",
        ("session_start", "10:00:00", {"seq": 1, "session_timeout_seconds": 1800}),
        ("session_end", "10:01:00", {"seq": 2, "end_reason": "quit", "duration_seconds": 60}),
    )
    assert send(ingest, game_id, events, **{"X-AVN-Delivery": "worker"}).status_code == 200
    assert send(ingest, game_id, events, **{"X-AVN-Delivery": "nonsense"}).is_success
    today = session_state.clock().date().isoformat()
    refused = {"context": {"app_version": "2.0", "platform": "android"}, "events": [{"name": ""}]}
    assert post(ingest, game_id, refused).status_code == 400
    page = sessions_page(admin, game_id, DAY, today)
    row = next(item for item in page["quality"] if item["app_version"] == "2.0")
    assert row["client_percent"] == 100.0
    assert row["inferred_percent"] == 0.0
    assert row["duplicate_percent"] == 50.0
    assert row["rejected"] == 1
    assert row["median_end_delay"] > 0
    assert [item["delivery"] for item in page["delivery"]] == ["worker"]
    assert page["delivery"][0]["events"] == 2


def test_a_refusal_is_still_a_400_when_nothing_can_be_read_from_it(game):
    _, ingest, game_id = game
    assert post(ingest, game_id, ["not", "a", "batch"]).status_code == 400


def test_the_player_timeline_gets_each_sessions_state(game, later):
    admin, ingest, game_id = game
    events = played(
        "s",
        ("session_start", "10:00:00", {"seq": 1, "session_timeout_seconds": 1800}),
        ("level", "10:02:00", {"seq": 2}),
        (
            "session_end",
            "10:03:00",
            {"seq": 3, "end_reason": "background", "duration_seconds": 170},
        ),
    )
    assert send(ingest, game_id, events).status_code == 200
    answer = admin.get(
        f"/v1/games/{game_id['id']}/insights/journey",
        params={"player": "p1", "start": DAY, "end": DAY},
    ).json()
    state = answer["sessions"]["s"]
    assert (state["status"], state["closed_by"], state["end_reason"]) == (
        "closed",
        "client",
        "background",
    )
    assert state["seconds"] == 170.0


def test_session_report_is_generic_about_missing_buckets():
    assert [row["sessions"] for row in session_report._bars([5, 11], session_report.AWAYS)] == [
        1,
        1,
        0,
        0,
        0,
        0,
    ]
