"""get_level_progress has to fit a long game whole: a cut tool result reads as missing levels."""

import json

from avn_analytics.nutbot import MAX_TOOL_RESULT
from avn_analytics.nutbot_tools import compact_levels


def row(number):
    """A row of the shape journeys.render_levels returns, with the long words real games have."""
    words = [{"text": f"Tutorial · first_level Completed on level {number}", "count": 7}] * 3
    return {
        "level": number,
        "started": 12345,
        "completed": 11234,
        "observed_completed": 11230,
        "completion": 91.2,
        "attempts": 14000,
        "tries_per_player": 1.13,
        "fails": 1200,
        "restarts": 300,
        "median_seconds": 42.5,
        "p90_seconds": 120.5,
        "quit": 900,
        "quit_percent": 7.3,
        "powerups": 20,
        "top_powerups": words,
        "other_events": 5000,
        "top_other": words,
        "low_sample": False,
        "transition": {
            "total_drop": 929,
            "drop_percent": 31.1,
            "left": 500,
            "finished_stopped": 400,
            "kept_going": 29,
            "matched_completed": 11000,
            "next_level": number + 1,
        },
    }


def table(count):
    return {"levels": [row(n) for n in range(1, count + 1)], "context": {"minimum_players": 30}}


def test_a_long_game_fits_with_the_pages_drop_numbers():
    out = compact_levels(table(100))
    assert len(out["rows"]) == 100 and out["more_levels_from"] is None
    assert len(json.dumps(out)) < MAX_TOOL_RESULT
    assert out["rows"][0][out["columns"].index("drop_percent")] == 31.1


def test_a_game_too_long_for_one_result_says_where_to_continue():
    first = compact_levels(table(600))
    assert len(json.dumps(first)) < MAX_TOOL_RESULT
    assert first["more_levels_from"] == len(first["rows"]) + 1
    second = compact_levels(table(600), from_level=first["more_levels_from"])
    assert second["rows"][0][0] == first["more_levels_from"]


def test_to_level_stops_early_and_says_more_exist():
    out = compact_levels(table(30), from_level=11, to_level=20)
    assert [values[0] for values in out["rows"]] == list(range(11, 21))
    assert out["more_levels_from"] == 21
