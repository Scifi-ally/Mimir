import pandas as pd
import pytest

from portfolio_research import delivery_leg_cost, planned_stop_loss, simulate_portfolio, load_history
from corporate_indicators import compute_indicators
from trend_carry import carry_score
from test_portfolio_research import market
from test_strategy_lab import history_file
from strategy_lab import atomic_json
from strategy_forward import record_session


def test_tariff_controls_both_execution_legs_and_stop_budget_without_switching_default():
    assert delivery_leg_cost(100, 20, "BUY") == delivery_leg_cost(100, 20, "BUY", "upstox_delivery")
    assert planned_stop_loss(100, 98, 20, 15, "dhan_delivery") < planned_stop_loss(100, 98, 20, 15)
    result = simulate_portfolio(market(), "momentum_60d", "2026-01-05", "2026-01-07", 10000, 15,
        enforce_economics=True, risk_policy="total_loss_budget", fee_profile="dhan_delivery")
    assert result["fee_profile"] == "dhan_delivery"
    assert result["fee_model"] == "dhan-cash-delivery-2026-10"
    assert result["cash"] == pytest.approx(10000 + sum(t["net_pnl"] for t in result["trades"]))
    assert result["trades"][0]["fees"] < 30
    with pytest.raises(ValueError):
        simulate_portfolio(market(), "momentum_60d", "2026-01-05", "2026-01-07", fee_profile="invented")


def test_prefix_history_is_identical_to_full_history_before_its_cutoff(tmp_path):
    path, _, _ = history_file(tmp_path)
    full, _ = load_history(path, quarantine=True)
    day = full["NIFTY"].index[260]
    prefix, _ = load_history(path, quarantine=True, through=day)
    for name in full:
        pd.testing.assert_frame_equal(prefix[name], full[name].loc[:day])


def test_price_efficiency_distinguishes_chop_without_fabricating_flat_history_quality():
    dates = pd.bdate_range("2025-01-01", periods=260).strftime("%Y-%m-%d")
    trend = pd.DataFrame({"close": [100 + i for i in range(260)], "volume": 1000000}, index=dates)
    for key in ("open", "high", "low"):
        trend[key] = trend.close
    metrics = compute_indicators(trend)
    assert metrics.iloc[-1].efficiency60 == pytest.approx(1)
    flat = trend.copy()
    flat[["close", "open", "high", "low"]] = 100
    assert pd.isna(compute_indicators(flat).iloc[-1].efficiency60)


def test_carry_rule_requires_measured_efficiency_and_skips_recent_surge():
    row = dict(close=100, ema20=98, ema50=95, ema200=90, atr=2, mom20=.05,
        mom60=.2, mom126=.4, vol126=.015, efficiency60=.5, ema50_slope20=.04)
    assert carry_score(row, .05) is not None
    assert carry_score({**row, "efficiency60": .1}, .05) is None
    assert carry_score({**row, "mom20": .4}, .05) is None
    assert carry_score({**row, "efficiency60": float("nan")}, .05) is None


def test_conditional_broker_fee_scenario_cannot_silently_seed_actual_broker_forward(tmp_path):
    path, _, _ = history_file(tmp_path)
    atomic_json(tmp_path / "latest.json", {"experiment_id": "conditional", "selected_strategy": "momentum_60d",
        "specification": {"fee_profile": "dhan_delivery"}})
    with pytest.raises(ValueError, match="configured broker"):
        record_session(path, tmp_path, "2026-10-01T16:10:00+05:30")
    assert not (tmp_path / "forward-journal.json").exists()
