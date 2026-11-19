from avn_analytics import payback


def _observed(curve, players=200, days=(0, 1, 3, 7, 14, 30)):
    return {f"day_{d}": {"players": players, "per_player": curve(d)} for d in days}


def test_recovers_an_exact_curve_and_break_even():
    curve = lambda d: 0.05 * (d + 1) ** 0.6  # noqa: E731
    result = payback.forecast(_observed(curve), cost_per_install=0.43)
    assert result["state"] == "ok"
    assert abs(result["predicted"]["day_90"] - curve(90)) < 0.001
    expected = next(d for d in range(181) if curve(d) >= 0.43)
    assert result["break_even_day"] == expected
    assert "around day" in result["summary"]


def test_not_paying_back_inside_the_horizon():
    result = payback.forecast(_observed(lambda d: 0.01 * (d + 1) ** 0.3), cost_per_install=5.0)
    assert result["break_even_day"] is None
    assert "Not expected to pay back" in result["summary"]


def test_already_paid_back_is_said_so():
    result = payback.forecast(_observed(lambda d: 0.5 * (d + 1) ** 0.5), cost_per_install=0.43)
    assert result["break_even_day"] is not None
    assert result["break_even_day"] <= 30
    assert "Already paid back" in result["summary"]


def test_thin_data_is_flagged():
    result = payback.forecast(_observed(lambda d: 0.05 * (d + 1) ** 0.6, players=8), 0.4)
    assert result["state"] == "thin"
    assert "only 8 players" in result["summary"]


def test_too_few_points_or_no_cost_or_no_revenue():
    two = _observed(lambda d: 0.1 * (d + 1) ** 0.5, days=(0, 1))
    assert payback.forecast(two, 0.4)["state"] == "none"
    assert payback.forecast(_observed(lambda d: 0.1), None)["state"] == "none"
    assert payback.forecast(_observed(lambda d: 0.0), 0.4)["state"] == "none"
    missing = {"day_0": {"players": 0, "per_player": None}}
    assert payback.forecast(missing, 0.4)["state"] == "none"


def test_exponent_is_capped_so_noise_cannot_explode_the_forecast():
    steep = payback.forecast(_observed(lambda d: 0.01 * (d + 1) ** 2.5), 100.0)
    assert steep["predicted"]["day_180"] < 0.01 * 181**2.5 / 100  # far below the uncapped curve
