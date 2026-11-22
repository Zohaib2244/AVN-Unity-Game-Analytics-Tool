"""What separates players who stay or pay: the pure comparison, and a game with planted facts."""

from datetime import date

import pytest
from fastapi.testclient import TestClient
from test_backend import AUTH, TOKEN, event, register
from test_playertools import NO_FILTERS

from avn_analytics import analytics, separators
from avn_analytics.api import create_app
from avn_analytics.config import Settings
from avn_analytics.exports import period_bounds

START, END = period_bounds("custom", date(2026, 10, 1), date(2026, 10, 10))


def ids(prefix, count, start=0):
    return {f"{prefix}{n}" for n in range(start, start + count)}


def test_a_fact_with_a_clear_gap_is_reported_with_both_sides():
    eligible = ids("p", 400)
    liked = ids("p", 200)
    stayed = ids("p", 120) | ids("p", 20, 200)  # 60% with the fact, 10% without
    features = [{"label": "did x", "kind": "event", "players": liked}]
    (found,) = separators.compare(features, stayed, eligible)
    assert found["with"] == {"reached": 120, "players": 200, "rate": 0.6}
    assert found["without"] == {"reached": 20, "players": 200, "rate": 0.1}
    assert found["points"] == 50.0 and "players" not in found


def test_small_groups_small_gaps_and_unclear_gaps_are_not_reported():
    eligible = ids("p", 400)
    stayed = ids("p", 100) | ids("p", 100, 200)
    even = {"label": "even", "kind": "event", "players": ids("p", 200)}
    tiny = {"label": "tiny", "kind": "event", "players": ids("p", 20)}
    nearly_all = {"label": "all", "kind": "event", "players": ids("p", 380)}
    gentle = {"label": "gentle", "kind": "event", "players": ids("p", 200, 100)}
    assert separators.compare([even, tiny, nearly_all], stayed, eligible) == []
    # 45% vs 50%: under five points
    nearly = stayed - ids("p", 10, 200)
    assert separators.compare([even], nearly, eligible, min_points=11) == []
    # a gap that is real at 95% but not under the wide margin used for many facts
    eligible = ids("p", 100)
    stayed = ids("p", 30) | ids("p", 18, 50)
    half = {"label": "half", "kind": "event", "players": ids("p", 50)}
    assert separators.compare([half], stayed, eligible, z=1.96) != []
    assert separators.compare([half], stayed, eligible) == []
    assert gentle["players"]


def test_opposite_facts_are_reported_once_on_the_more_likely_side():
    eligible = ids("p", 400)
    stayed = ids("p", 120) | ids("p", 20, 200)
    failed = {"label": "failed", "kind": "event", "players": ids("p", 200, 200)}
    completed = {"label": "completed", "kind": "event", "players": ids("p", 200)}
    found = separators.compare([failed, completed], stayed, eligible)
    assert [(item["label"], item["points"]) for item in found] == [("completed", 50.0)]


def test_two_facts_about_the_same_players_are_reported_once():
    eligible = ids("p", 400)
    stayed = ids("p", 150)
    first = {"label": "first", "kind": "event", "players": ids("p", 200)}
    same = {"label": "same", "kind": "event", "players": ids("p", 200)}
    found = separators.compare([first, same], stayed, eligible)
    assert [item["label"] for item in found] == ["first"]


COUNTRIES = ("IN", "US", "DE")


def at(pid, day, name, minute=5, session=None, **params):
    return event(
        name=name,
        params=params,
        device_id=pid,
        session_id=session or f"s-{pid}-{day}",
        client_ts=f"2026-10-{day:02d}T09:{minute:02d}:00Z",
    )


def _events():
    """400 players open the game on Oct 1-3. Half complete a level on day one: 55% of them come
    back on day 7 and 60 buy; of the rest 12% come back and 5 buy. An ad shown to every other
    player changes nothing. Ten more open on Oct 19, whose day 7 is not over."""
    sent = []
    for index in range(400):
        pid, day = f"p{index:03d}", 1 + index % 3
        completes = (index // 2) % 2 == 0
        country = COUNTRIES[index % 3]
        sent.append((country, at(pid, day, "first_open", 0)))
        sent.append((country, at(pid, day, "LEVEL_ANALYSIS", 6, STATE="Started")))
        sent.append(
            (
                country,
                at(pid, day, "LEVEL_ANALYSIS", 7, STATE="Completed" if completes else "Failed"),
            )
        )
        if index % 2 == 0:
            sent.append((country, at(pid, day, "AD_ANALYSIS", 8, STATE="Show", AD_ID=pid)))
        rate = 55 if completes else 12
        if (index * 37) % 100 < rate:
            sent.append((country, at(pid, day + 7, "session_start", 0)))
        buys = 60 if completes else 5
        if (index * 53) % 100 < buys * 100 // 200:
            sent.append(
                (country, at(pid, day + 2, "IAP_ANALYSIS", 0, STATE="Purchased", PRICE=1.99))
            )
    for index in range(10):
        sent.append(("US", at(f"late{index}", 19, "first_open", 0)))
    sent.append(("US", at("someone", 20, "session_start", 0)))
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
            everything = _events()
            for country in COUNTRIES:
                events = [e for c, e in everything if c == country]
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


def labels(items):
    return [item["label"] for item in items]


def test_the_planted_first_day_fact_is_found_and_the_noise_is_not(game):
    admin, game, storage = game
    data = separators.analyse(storage, game["id"], START, END, NO_FILTERS, "day_7")
    assert data["available"] is True
    assert data["players"] == 400  # the ten who opened on Oct 19 have no day 7 yet
    assert "had “Level · Completed” on their first day" in labels(data["more_likely"])
    assert data["less_likely"] == []  # "failed" is the mirror image of "completed"
    assert not any(
        "AD_ANALYSIS" in label for label in labels(data["more_likely"] + data["less_likely"])
    )
    top = data["more_likely"][0]
    assert top["with"]["players"] == 200 and top["without"]["players"] == 200
    assert 0.45 < top["with"]["rate"] < 0.65 and top["without"]["rate"] < 0.2
    assert top["words"].startswith("5") or top["words"].startswith("6")
    assert "came back on day 7, against" in top["words"]
    assert top["chip"] == {
        "kind": "event",
        "event": "LEVEL_ANALYSIS",
        "param": "STATE",
        "values": ["Completed"],
    }
    assert data["summary"].startswith(f"{data['rate'] * 100:.1f}% of 400 new players came back")
    assert "association, not cause" in data["means"]
    response = admin.get(
        f"/v1/games/{game['id']}/insights/separators",
        headers=AUTH,
        params={"start": "2026-10-01", "end": "2026-10-10", "outcome": "day_7"},
    )
    assert response.status_code == 200, response.text
    assert labels(response.json()["more_likely"]) == labels(data["more_likely"])


def test_paying_leaves_out_the_purchases_and_still_finds_the_fact(game):
    _, game, storage = game
    data = separators.analyse(storage, game["id"], START, END, NO_FILTERS, "pays")
    assert data["available"] is True and data["outcome_label"] == "paid in their first 7 days"
    everything = labels(data["more_likely"] + data["less_likely"])
    assert not any("IAP" in label for label in everything)
    assert "had “Level · Completed” on their first day" in labels(data["more_likely"])


def test_asking_for_what_cannot_be_answered_says_so(game):
    admin, game, storage = game
    with pytest.raises(ValueError, match="outcome is one of"):
        separators.analyse(storage, game["id"], START, END, NO_FILTERS, "day_9")
    with pytest.raises(ValueError, match="window_days is a whole number"):
        separators.analyse(storage, game["id"], START, END, NO_FILTERS, "day_7", 9)
    with pytest.raises(ValueError, match="day 3 or later"):
        separators.analyse(storage, game["id"], START, END, NO_FILTERS, "day_1", 3)
    nobody = period_bounds("custom", date(2026, 9, 1), date(2026, 9, 5))
    data = separators.analyse(storage, game["id"], *nobody, NO_FILTERS)
    assert data["available"] is False and "first time" in data["note"]
    # the Oct 19 players alone are too few and their day 7 is not over
    late = period_bounds("custom", date(2026, 10, 19), date(2026, 10, 20))
    data = separators.analyse(storage, game["id"], *late, NO_FILTERS)
    assert data["available"] is False and "Too few players" in data["note"]


def test_a_game_that_sends_no_purchases_gets_a_sentence(tmp_path):
    settings = Settings(data_dir=tmp_path / "data", admin_token=TOKEN)
    with TestClient(create_app(settings, admin=True)) as admin:
        game = register(admin)
        data = separators.analyse(
            admin.app.state.storage, game["id"], START, END, NO_FILTERS, "pays"
        )
        assert data["available"] is False and "IAP_ANALYSIS Purchased" in data["note"]
