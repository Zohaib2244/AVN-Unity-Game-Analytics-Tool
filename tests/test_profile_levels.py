"""The diagnostic must not change stored data and must stop during Python work too."""

import sqlite3

from parity import build_fixture, make_storage, ranges

from avn_analytics import journeys
from scripts.profile_levels import profile_levels


def test_profile_refuses_database_writes(tmp_path, monkeypatch, capsys):
    storage = make_storage(tmp_path)
    game = build_fixture(storage, events_target=100)
    with storage.connect(storage.game_path(game)) as connection:
        original = connection.execute("SELECT count(*) FROM events").fetchone()[0]

    def attempts_write(storage, game, *args):
        with storage.connect(storage.game_path(game)) as connection:
            connection.execute("DELETE FROM events")

    monkeypatch.setattr(journeys, "_scan_levels", attempts_write)
    profile_levels(storage, game, *ranges()[0][1:], {}, "all", 5)
    assert "readonly database" in capsys.readouterr().out
    with sqlite3.connect(storage.game_path(game)) as connection:
        assert connection.execute("SELECT count(*) FROM events").fetchone()[0] == original


def test_profile_time_limit_interrupts_python_and_prints_partial_profile(
    tmp_path, monkeypatch, capsys
):
    storage = make_storage(tmp_path)
    game = build_fixture(storage, events_target=100)

    def never_finishes(*args):
        while True:
            pass

    monkeypatch.setattr(journeys, "_scan_levels", never_finishes)
    profile_levels(storage, game, *ranges()[0][1:], {}, "all", 0.05)
    output = capsys.readouterr().out
    assert "TimeoutError" in output and "never_finishes" in output


def test_profile_completes_on_synthetic_game(tmp_path, capsys):
    storage = make_storage(tmp_path)
    game = build_fixture(storage, events_target=100)
    profile_levels(storage, game, *ranges()[0][1:], {}, "all", 5)
    assert "complete levels=" in capsys.readouterr().out
