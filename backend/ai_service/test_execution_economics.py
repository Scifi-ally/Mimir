import pytest

from execution_economics import cost_scenario, scenario_leg_cost
from portfolio_research import delivery_leg_cost


def test_actual_upstox_tariff_matches_the_existing_execution_cost_oracle():
    for side in ("BUY", "SELL"):
        assert scenario_leg_cost(100, 20, side, "upstox_delivery") == pytest.approx(delivery_leg_cost(100, 20, side))


def test_lower_brokerage_is_a_cost_scenario_not_a_profit_estimate_or_broker_switch():
    current = cost_scenario(100, 20, "upstox_delivery")
    lower = cost_scenario(100, 20, "dhan_delivery")
    assert current["flat_price_round_trip_loss_inr"] > lower["flat_price_round_trip_loss_inr"] > 0
    assert current["break_even_price_move_pct"] > lower["break_even_price_move_pct"] > 0
    assert current["friction_fraction_of_risk_budget"] > .8
    assert lower["forecast_return_pct"] is None and not lower["broker_changed"]
    assert current["risk_budget_inr"] == lower["risk_budget_inr"] == 100


def test_unknown_tariffs_and_fractional_equity_cannot_make_fictional_fee_savings():
    with pytest.raises(ValueError):
        scenario_leg_cost(100, .5, "BUY", "upstox_delivery")
    with pytest.raises(ValueError):
        scenario_leg_cost(100, 20, "BUY", "invented_free_broker")
