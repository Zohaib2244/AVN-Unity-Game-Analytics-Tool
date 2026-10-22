"""The production dashboards give exactly the answers of the frozen reference (tests/reference)."""

from parity import PRODUCTION, REFERENCE, build_fixture, compare, make_storage, snapshot


def test_production_answers_match_the_frozen_reference(tmp_path):
    storage = make_storage(tmp_path)
    game_id = build_fixture(storage)
    expected = snapshot(storage, game_id, REFERENCE)
    actual = snapshot(storage, game_id, PRODUCTION)
    assert len(expected) > 500
    assert compare(expected, actual) == []
