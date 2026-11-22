"""Churn risk: the pure habit comparison, and a small game with every kind of player."""

from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient
from test_backend import AUTH, TOKEN, event, register, send

from avn_analytics import analytics, churn_risk, player_chips, separators
from avn_analytics.api import create_app
from avn_analytics.config import Settings


def days(*numbers):
    return [date(2026, 8, 1).toordinal() + n for n in numbers]


def test_a_player_away_much_longer_than_their_own_gap_is_slipping_then_gone():
    daily = days(0, 1, 2, 3, 4, 5)
    assert churn_risk.classify(daily, days(7)[0])["state"] == "steady"  # 2 days away
    slipping = churn_risk.classify(daily, days(8)[0])  # 3 days away at a 1 day habit
    assert slipping["state"] == "slipping" and slipping["usual_gap"] == 1.0
    assert slipping["days_away"] == 3 and slipping["ratio"] == 3.0
    assert churn_risk.classify(daily, days(12)[0])["state"] == "gone"  # 7 days
    assert churn_risk.classify(daily, days(80)[0])["state"] == "long_gone"


def test_a_weekly_player_is_not_at_risk_after_a_week():
    weekly = days(0, 7, 14, 21)
    assert churn_risk.classify(weekly, days(28)[0])["state"] == "steady"  # a week, as usual
    assert churn_risk.classify(weekly, days(35)[0])["state"] == "slipping"  # 2x
    assert churn_risk.classify(weekly, days(56)[0])["state"] == "gone"  # 5x and 7+ days


def test_one_long_break_does_not_change_the_usual_gap():
    uneven = days(0, 1, 2, 3, 4, 30)  # the median gap stays 1
    assert churn_risk.classify(uneven, days(30)[0])["usual_gap"] == 1.0


def test_players_with_too_few_days_have_no_rhythm_yet():
    assert churn_risk.classify(days(0, 1), days(40)[0]) is None
    assert churn_risk.classify(days(0, 0, 0, 0), days(40)[0]) is None  # one day, four events


def test_a_sentence_says_the_habit_and_the_gap():
    item = churn_risk.classify(days(0, 2, 4, 6, 8), days(15)[0])
    assert churn_risk.sentence(item) == (
        "Usually plays every 2 days (5 days played). "
        "Last played 7 days ago, 3.5× longer than usual."
    )
    daily = churn_risk.classify(days(0, 1, 2), days(5)[0])
    assert churn_risk.sentence(daily).startswith("Usually plays every day (3 days played)")


def when(offset, minute=0):
    base = date(2026, 8, 1) + timedelta(days=offset)
    return f"{base.isoformat()}T10:{minute:02d}:00Z"


def sessions(pid, offsets, platform="android", first=None):
    out = []
    for offset in offsets:
        out.append(
            event(
                name="session_start",
                params={},
                device_id=pid,
                session_id=f"s-{pid}-{offset}",
                platform=platform,
                client_ts=when(offset),
            )
        )
    if first:
        out.append(
            event(
                name="TUTORIAL_ANALYSIS",
                params={"STATE": "Completed"},
                device_id=pid,
                session_id=f"s-{pid}-{offsets[0]}",
                platform=platform,
                client_ts=when(offsets[0], 5),
            )
        )
    return out


def _events():
    """The data runs to day 100. Daily players who left on day 85 (gone), a player every 2 days
    who left on day 92 (slipping), one still playing, a newcomer, a player long gone, and a
    slipping editor build that must not count."""
    events = []
    events += sessions("gone", range(75, 86), first=True)
    events += sessions("slipping_a", range(80, 94, 2))
    events += sessions("slipping_b", range(90, 97), first=True)
    events += sessions("steady", range(94, 101))
    events += sessions("newcomer", [99, 100])
    events += sessions("old", range(0, 5))
    events += sessions("editor", range(90, 97), platform="editor")
    return events


@pytest.fixture(params=["legacy", "facts"])
def game(tmp_path, request):
    settings = Settings(
        data_dir=tmp_path / "data", admin_token=TOKEN, analytics_read_mode=request.param
    )
    with TestClient(create_app(settings, admin=True)) as admin:
        game = register(admin)
        with TestClient(create_app(settings)) as ingest:
            assert send(ingest, game, _events()).status_code == 200
        storage = admin.app.state.storage
        if request.param == "facts":
            analytics.prepare_all(storage, game["id"])
        yield admin, game, storage


def test_everyone_is_sorted_into_their_state_and_ranked(game):
    _, game, storage = game
    data = churn_risk.at_risk(storage, game["id"])
    assert data["available"] is True and data["as_of"] == "2026-11-09"
    assert data["counts"] == {
        "measured": 5,  # not the newcomer; not the editor build
        "steady": 1,
        "slipping": 2,
        "gone": 1,
        "long_gone": 1,
        "too_new": 1,
    }
    order = [(row["player"], row["state"]) for row in data["players"]]
    # slipping first (the more engaged first), then gone; long gone and steady are not listed
    assert order == [
        ("slipping_a", "slipping"),
        ("slipping_b", "slipping"),
        ("gone", "gone"),
    ]
    first = data["players"][0]
    assert first["days_played"] == 7 and first["usual_gap"] == 2.0 and first["days_away"] == 8
    assert first["words"].startswith("Usually plays every 2 days (7 days played)")
    only_gone = churn_risk.at_risk(storage, game["id"], "gone")
    assert [row["player"] for row in only_gone["players"]] == ["gone"]
    assert churn_risk.at_risk(storage, game["id"], "any", 1)["listed"] == 1


def test_the_chip_holds_exactly_those_players(game):
    _, game, storage = game
    assert churn_risk.members(storage, game["id"], "slipping") == ["slipping_a", "slipping_b"]
    found = player_chips.resolved(storage, game["id"], [{"kind": "churn_risk", "value": "any"}])
    assert found == [{"players": ["gone", "slipping_a", "slipping_b"]}]
    assert player_chips.resolved(storage, game["id"], [{"kind": "churn_risk"}]) == found
    with pytest.raises(ValueError, match="slipping, gone or either"):
        player_chips.conditions([{"kind": "churn_risk", "value": "dead"}])


def test_players_lacking_the_early_behaviour_get_a_note(game, monkeypatch):
    _, game, storage = game
    fake = {
        "available": True,
        "more_likely": [
            {
                "kind": "event",
                "key": "TUTORIAL_ANALYSIS Completed",
                "human": "Tutorial · Completed",
                "with": {"rate": 0.46},
                "without": {"rate": 0.13},
            },
            {"kind": "country", "label": "from IN"},
        ],
    }
    monkeypatch.setattr(separators, "analyse", lambda *a, **k: fake)
    data = churn_risk.at_risk(storage, game["id"])
    notes = {row["player"]: row.get("note") for row in data["players"]}
    missing = {row["player"]: row.get("missing") for row in data["players"]}
    assert missing["slipping_a"] == "Tutorial · Completed" and missing["gone"] is None
    assert data["early_facts"] == [
        {"human": "Tutorial · Completed", "with_rate": 0.46, "without_rate": 0.13}
    ]
    assert notes["gone"] is None and notes["slipping_b"] is None  # both completed the tutorial
    assert notes["slipping_a"] == (
        "Did not have “Tutorial · Completed” on their first day; players who did came back on "
        "day 7 46% of the time, the others 13%."
    )


def test_the_csv_is_text_and_never_a_formula(game):
    admin, game, storage = game
    data = churn_risk.at_risk(storage, game["id"])
    data["players"][0]["player"] = "=HYPERLINK(1)"
    text = churn_risk.csv_text(data)
    assert text.splitlines()[0].startswith("player_id,state,last_played,days_away")
    assert "'=HYPERLINK(1)" in text
    response = admin.get(
        f"/v1/games/{game['id']}/insights/churn-risk/export", headers=AUTH, params={"state": "gone"}
    )
    assert response.status_code == 200 and response.headers["content-type"].startswith("text/csv")
    assert len(response.text.splitlines()) == 2 and "gone" in response.text
    listed = admin.get(f"/v1/games/{game['id']}/insights/churn-risk", headers=AUTH)
    assert listed.status_code == 200 and listed.json()["counts"]["slipping"] == 2


def test_a_game_with_no_rhythms_yet_gets_a_sentence(tmp_path):
    settings = Settings(data_dir=tmp_path / "data", admin_token=TOKEN)
    with TestClient(create_app(settings, admin=True)) as admin:
        game = register(admin)
        storage = admin.app.state.storage
        assert "No sessions yet" in churn_risk.at_risk(storage, game["id"])["note"]
        with TestClient(create_app(settings)) as ingest:
            assert send(ingest, game, sessions("a", [0, 1])).status_code == 200
        storage.scans.clear() if hasattr(storage.scans, "clear") else None
        data = churn_risk.at_risk(storage, game["id"])
        assert data["available"] is False and "3 different days" in data["note"]
