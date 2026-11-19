"""Level difficulty finder: pure flagging, and a small game with one planted hard level."""

import pytest
from fastapi.testclient import TestClient
from test_backend import TOKEN, register, send
from test_playertools import END, NO_FILTERS, START, level, started

from avn_analytics import analytics, level_difficulty
from avn_analytics.api import create_app
from avn_analytics.config import Settings


def row(number, fail=None, stop=None):
    return {"level": number, "fail_rate": fail, "stop_share": stop}


def test_a_level_far_above_its_neighbours_is_flagged_with_words():
    levels = [row(n, 0.1) for n in range(1, 10)]
    levels[4] = row(5, 0.45)
    found = level_difficulty.flag(levels)
    assert [item["level"] for item in found] == [5]
    reason = found[0]["reasons"][0]
    assert reason["metric"] == "fail_rate" and reason["expected"] == 0.1
    assert reason["words"] == "45% of finished tries fail; levels around it about 10%"


def test_small_or_relative_only_differences_are_not_flagged():
    gentle = [row(n, 0.1) for n in range(1, 10)]
    gentle[4] = row(5, 0.18)  # 1.8x but only 8 points
    assert level_difficulty.flag(gentle) == []
    hard_area = [row(n, 0.6) for n in range(1, 10)]
    hard_area[4] = row(5, 0.75)  # 15 points but only 1.25x
    assert level_difficulty.flag(hard_area) == []


def test_levels_without_enough_data_or_neighbours_are_skipped():
    assert level_difficulty.flag([row(1, 0.9), row(2, 0.1)]) == []
    sparse = [row(1, 0.1), row(2, None), row(3, 0.9), row(4, None), row(5, 0.1)]
    assert [item["level"] for item in level_difficulty.flag(sparse)] == [3]


def test_both_reasons_and_the_bigger_surprise_first():
    levels = [row(n, 0.1, 0.05) for n in range(1, 12)]
    levels[2] = row(3, 0.3, 0.05)  # +20 points fail
    levels[8] = row(9, 0.1, 0.5)  # +45 points stop
    found = level_difficulty.flag(levels)
    assert [item["level"] for item in found] == [9, 3]
    assert found[0]["reasons"][0]["metric"] == "stop_share"


def _events():
    """40 players play levels 1 to 8; level 5 fails 3 of every 4 tries, the rest 1 in 10."""
    events = []
    for player in range(40):
        device = f"p{player}"
        minute = 0
        for number in range(1, 9):
            tries = 4 if number == 5 else 1
            for attempt in range(tries):
                attempt_id = f"{device}-{number}-{attempt}"
                fails = (number == 5 and attempt < 3) or (number != 5 and player % 10 == 0)
                hour, mins = divmod(minute, 60)
                events.append(started(device, 1 + hour, mins, attempt_id, number, f"d{number}"))
                state = "Failed" if fails else "Completed"
                events.append(level(device, 1 + hour, mins, state, attempt_id, number, second=30))
                minute += 1
                if fails and number != 5:
                    break  # one failed try elsewhere, then on
    return events


@pytest.fixture(params=["legacy", "facts"])
def hard_game(tmp_path, request):
    settings = Settings(
        data_dir=tmp_path / "data", admin_token=TOKEN, analytics_read_mode=request.param
    )
    with TestClient(create_app(settings, admin=True)) as admin:
        game = register(admin)
        with TestClient(create_app(settings)) as ingest:
            events = _events()
            for first in range(0, len(events), 400):
                assert send(ingest, game, events[first : first + 400]).status_code == 200
        storage = admin.app.state.storage
        if request.param == "facts":
            analytics.prepare_all(storage, game["id"])
        yield admin, game, storage


def test_the_planted_hard_level_is_found(hard_game):
    admin, game, storage = hard_game
    data = level_difficulty.find(storage, game["id"], START, END, NO_FILTERS, min_attempts=20)
    assert data["available"] is True
    assert [item["level"] for item in data["levels"]] == [5]
    assert data["levels"][0]["fail_rate"] == 0.75
    assert data["summary"].startswith("Level 5 stands out: 75% of finished tries fail")
    from test_backend import AUTH

    response = admin.get(
        f"/v1/games/{game['id']}/insights/levels/difficulty",
        headers=AUTH,
        params={"start": "2026-10-01", "end": "2026-10-05", "min_attempts": 20},
    )
    assert response.status_code == 200, response.text
    assert [item["level"] for item in response.json()["levels"]] == [5]


def test_a_game_without_level_events_gets_a_sentence(tmp_path):
    settings = Settings(data_dir=tmp_path / "data", admin_token=TOKEN)
    with TestClient(create_app(settings, admin=True)) as admin:
        game = register(admin)
        data = level_difficulty.find(admin.app.state.storage, game["id"], START, END, NO_FILTERS)
    assert data["available"] is False and data["note"]
