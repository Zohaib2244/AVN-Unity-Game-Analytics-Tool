"""The production dashboards give exactly the answers of the frozen reference (tests/reference),
whichever way they read the events (AVN_ANALYTICS_READ_MODE)."""

import pytest
from parity import PRODUCTION, REFERENCE, build_fixture, compare, make_storage, snapshot

from avn_analytics import analytics, insights


@pytest.fixture(scope="module")
def fixture(tmp_path_factory):
    path = tmp_path_factory.mktemp("parity")
    storage = make_storage(path)
    game_id = build_fixture(storage)
    return path, game_id, snapshot(storage, game_id, REFERENCE)


def _source(storage, game_id):
    with storage.connect(storage.game_path(game_id)) as connection:
        return insights.read_source(storage, connection)


@pytest.mark.parametrize("mode", ["legacy", "facts"])
def test_production_answers_match_the_frozen_reference(fixture, mode):
    path, game_id, expected = fixture
    storage = make_storage(path, analytics_read_mode=mode)
    assert _source(storage, game_id) is (insights.FACTS if mode == "facts" else insights.LEGACY)
    actual = snapshot(storage, game_id, PRODUCTION)
    assert len(expected) > 500
    assert compare(expected, actual) == []


def test_facts_are_read_only_once_every_event_has_them(tmp_path):
    storage = make_storage(tmp_path, analytics_read_mode="facts", read_cache_seconds=0)
    game_id = build_fixture(storage, events_target=900, seed=21)
    expected = snapshot(storage, game_id, REFERENCE, full=False)
    with storage.connect(storage.game_path(game_id)) as connection:
        for kind, name in analytics.DERIVED:  # as if written before facts existed
            connection.execute(f"DROP {kind} IF EXISTS {name}")
        analytics.install(connection)
    assert _source(storage, game_id) is insights.LEGACY
    assert compare(expected, snapshot(storage, game_id, PRODUCTION, full=False)) == []
    with storage.connect(storage.game_path(game_id)) as connection:
        analytics.step(connection, backfill_rows=300)  # some facts, not all
    assert _source(storage, game_id) is insights.LEGACY
    assert compare(expected, snapshot(storage, game_id, PRODUCTION, full=False)) == []
    analytics.prepare_all(storage, game_id)
    assert _source(storage, game_id) is insights.FACTS
    assert compare(expected, snapshot(storage, game_id, PRODUCTION, full=False)) == []


def _answer(function, *args, **kwargs):
    try:
        return function(*args, **kwargs)
    except Exception as error:
        return {"error": type(error).__name__, "detail": getattr(error, "detail", str(error))}


@pytest.mark.parametrize("mode", ["legacy", "facts"])
def test_levels_refuse_too_much_data_as_before(fixture, monkeypatch, mode):
    from parity import HIDE_TEST, ranges
    from reference import legacy_journeys

    from avn_analytics import journeys

    path, game_id, _ = fixture
    storage = make_storage(path, analytics_read_mode=mode, read_cache_seconds=0)
    _, start, end = ranges()[2]  # a week: its history is far larger than its own events
    # Below the range's own events, around the first session's, below its whole history, above.
    for limit in (40, 300, 400, 900):
        monkeypatch.setattr(journeys, "MAX_FUNNEL_EVENTS", limit)
        monkeypatch.setattr(legacy_journeys, "MAX_FUNNEL_EVENTS", limit)
        for scope in ("all", "first_session"):
            for name, arguments in (
                ("level_progress", (HIDE_TEST, scope)),
                ("level_players", (HIDE_TEST, 1)),
            ):
                extra = {"scope": scope} if name == "level_players" else {}
                expected = _answer(
                    getattr(legacy_journeys, name),
                    storage,
                    game_id,
                    start,
                    end,
                    *arguments,
                    **extra,
                )
                actual = _answer(
                    getattr(journeys, name), storage, game_id, start, end, *arguments, **extra
                )
                assert actual == expected, (limit, scope, name)
