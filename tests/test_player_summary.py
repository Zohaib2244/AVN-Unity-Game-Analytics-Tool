"""The player summary: counted from the standard's events, over everything the player sent."""

from test_backend import backend as backend
from test_backend import event, register, send

from avn_analytics import player_summary


def level(state, number, ts, **params):
    return event(
        name="LEVEL_ANALYSIS",
        client_ts=ts,
        params={"STATE": state, "LEVEL_NUMBER": number, **params},
        device_id="p1",
    )


def ad(state, ts, **params):
    return event(
        name="AD_ANALYSIS", client_ts=ts, params={"STATE": state, **params}, device_id="p1"
    )


def test_summarize_counts_ads_levels_coins_and_sessions():
    def e(name, ts, **params):
        return {"name": name, "ts": ts, "params": params}

    events = [
        e("LEVEL_ANALYSIS", "2026-10-04T09:00:00+00:00", STATE="Started", LEVEL_NUMBER=1),
        e(
            "LEVEL_ANALYSIS",
            "2026-10-04T09:00:20+00:00",
            STATE="Completed",
            LEVEL_NUMBER=1,
            SECONDS=20.0,
            MOVES=10,
            REVIVES=0,
        ),
        e("LEVEL_ANALYSIS", "2026-10-04T09:01:00+00:00", STATE="Started", LEVEL_NUMBER=2),
        e("LEVEL_ANALYSIS", "2026-10-04T09:01:30+00:00", STATE="Failed", LEVEL_NUMBER=2, REVIVES=1),
        e("LEVEL_ANALYSIS", "2026-10-04T09:02:00+00:00", STATE="Started", LEVEL_NUMBER=2),
        e(
            "LEVEL_ANALYSIS",
            "2026-10-04T09:02:40+00:00",
            STATE="Completed",
            LEVEL_NUMBER=2,
            SECONDS=40.0,
            MOVES=20,
        ),
        e("LEVEL_ANALYSIS", "2026-10-04T09:03:00+00:00", STATE="Choice", ACTION="Restart"),
        e(
            "LEVEL_ANALYSIS",
            "2026-10-04T09:04:00+00:00",
            STATE="Left",
            LEVEL_NUMBER=3,
            REASON="Killed",
        ),
        e(
            "AD_ANALYSIS",
            "2026-10-04T09:05:00+00:00",
            STATE="Show",
            FORMAT="Interstitial",
            PLACEMENT="a",
        ),
        e(
            "AD_ANALYSIS",
            "2026-10-04T09:05:30+00:00",
            STATE="Closed",
            FORMAT="Interstitial",
            SECONDS_ON_SCREEN=30,
        ),
        e(
            "AD_ANALYSIS",
            "2026-10-04T09:06:00+00:00",
            STATE="Show",
            FORMAT="Rewarded",
            PLACEMENT="b",
        ),
        e(
            "AD_ANALYSIS",
            "2026-10-04T09:06:20+00:00",
            STATE="Closed",
            FORMAT="Rewarded",
            REWARDED=1,
        ),
        e(
            "AD_ANALYSIS",
            "2026-10-04T09:07:00+00:00",
            STATE="Failed",
            FORMAT="Rewarded",
            REASON="Timeout",
        ),
        e(
            "ECONOMY_ANALYSIS",
            "2026-10-04T09:08:00+00:00",
            STATE="Earned",
            SOURCE="level_reward",
            AMOUNT=20,
            BALANCE=220,
        ),
        e(
            "ECONOMY_ANALYSIS",
            "2026-10-04T09:09:00+00:00",
            STATE="Spent",
            SOURCE="powerup",
            DETAIL="bomb",
            AMOUNT=50,
            BALANCE=170,
        ),
        e("POWERUP_ANALYSIS", "2026-10-04T09:09:10+00:00", STATE="Used", POWERUP="bomb"),
        e(
            "POWERUP_ANALYSIS",
            "2026-10-04T09:09:20+00:00",
            STATE="Obtained",
            POWERUP="bomb",
            SOURCE="Coins",
        ),
        e(
            "PLAYER_ANALYSIS",
            "2026-10-04T09:10:00+00:00",
            STATE="Snapshot",
            HIGHEST_LEVEL=2,
            BALANCE_COINS=170,
            POWERUP_BOMB=1,
            HAS_PURCHASED=0,
        ),
    ]
    spans = [
        ("2026-10-04T09:00:00+00:00", "2026-10-04T09:10:00+00:00"),
        ("2026-10-05T10:00:00+00:00", "2026-10-05T10:01:00+00:00"),
    ]
    summary = player_summary.summarize(events, spans)

    assert summary["sessions"]["count"] == 2
    assert summary["sessions"]["active_days"] == 2
    levels = summary["levels"]
    assert (levels["cleared"], levels["highest"], levels["clears"], levels["fails"]) == (2, 3, 2, 1)
    assert levels["average_seconds"] == 30.0
    assert levels["fastest_seconds"] == 20.0
    assert levels["average_moves"] == 15.0
    assert levels["first_try_clears"] == 1  # level 2 took a fail and a second start
    assert (levels["restarts"], levels["revives"], levels["left"]) == (1, 1, 1)
    assert levels["pace"] == [[1, 20.0], [2, 40.0]]
    assert levels["hardest"][0] == {"level": 2, "bad_attempts": 2, "cleared": True}
    ads = summary["ads"]
    assert (ads["shown"], ads["failed"]) == (2, 1)
    assert ads["formats"]["Rewarded"]["rewarded"] == 1
    assert ads["formats"]["Rewarded"]["reasons"] == {"Timeout": 1}
    assert ads["average_seconds_on_screen"] == 30.0
    economy = summary["economy"]
    assert economy["balances"] == {"coins": 170}
    assert economy["inventory"] == {"bomb": 1}
    assert economy["earned"] == {"level_reward": 20}
    assert economy["spent"] == {"bomb": 50}
    assert economy["flags"] == {"has_purchased": 0}
    assert economy["save_level"] == 2
    assert summary["powerups"]["used"] == {"bomb": 1}
    assert summary["powerups"]["obtained"] == [{"powerup": "bomb", "source": "Coins", "count": 1}]
    assert summary["levels_ended_by_kill"] == 1


def test_a_game_without_the_standard_events_gets_empty_sections():
    summary = player_summary.summarize(
        [], [("2026-10-04T09:00:00+00:00", "2026-10-04T09:01:00+00:00")]
    )
    assert summary["ads"]["shown"] == 0
    assert summary["levels"]["cleared"] == 0 and summary["levels"]["highest"] is None
    assert summary["economy"]["balances"] == {}


def test_player_summary_endpoint_reads_the_whole_history(backend):
    admin, ingest, _ = backend
    game = register(admin)
    assert (
        send(
            ingest,
            game,
            [
                level("Started", 1, "2026-09-01T09:00:00Z"),
                level("Completed", 1, "2026-09-01T09:00:30Z", SECONDS=30.0, MOVES=5),
                ad("Show", "2026-10-04T09:00:00Z", FORMAT="Interstitial", PLACEMENT="p"),
                event(
                    name="session_start", device_id="someone-else", client_ts="2026-10-04T09:00:00Z"
                ),
            ],
        ).status_code
        == 200
    )
    data = admin.get(
        f"/v1/games/{game['id']}/insights/player-summary", params={"player": "p1"}
    ).json()
    assert data["levels"]["cleared"] == 1
    assert data["levels"]["average_seconds"] == 30.0
    assert data["ads"]["shown"] == 1
    assert data["first_seen"].startswith("2026-09-01") and data["last_seen"].startswith(
        "2026-10-04"
    )
    assert data["partial"] is False
    unknown = admin.get(
        f"/v1/games/{game['id']}/insights/player-summary", params={"player": "nobody"}
    ).json()
    assert unknown["sessions"]["count"] == 0 and unknown["first_seen"] is None
