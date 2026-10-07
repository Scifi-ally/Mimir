"""Execution regressions: chronology, gap risk, cash accounting, public evidence."""
import pandas as pd
import pytest

from portfolio_research import delivery_leg_cost, simulate_portfolio, load_history
from models.system1_base import System1Decision


def market(second_low=99., final_open=100.):
    dates = ["2026-01-05", "2026-01-06", "2026-01-07"]
    base = dict(open=100., high=102., low=99., close=100., volume=1_000_000.,
                ema20=98., ema50=97., ema200=90., atr=2., turnover20=100_000_000.,
                mom60=.2, mom20=.05, vol20=.02, rsi2=50., high20=101., volume20=1_000_000.)
    stock = pd.DataFrame([base.copy() for _ in dates], index=dates)
    stock.loc[dates[1], "low"] = second_low
    stock.loc[dates[2], "open"] = final_open
    stock.loc[dates[2], "low"] = min(final_open - 1, 99.)
    benchmark = stock.copy()
    benchmark["mom60"] = .05
    return {"NIFTY": benchmark, "REAL_EQ": stock}


def test_next_open_execution_and_cash_reconciles_after_fees():
    result = simulate_portfolio(market(), "momentum_60d", "2026-01-05", "2026-01-07", 100_000., 5.)
    trade = result["trades"][0]
    assert trade["signal_date"] == "2026-01-05"
    assert trade["entry_date"] == "2026-01-06"
    assert trade["entry"] == pytest.approx(100.05)
    assert isinstance(trade["quantity"], int)
    assert result["equity"][0]["positions"] == 0
    assert min(r["cash"] for r in result["equity"]) >= 0
    assert result["equity"][-1]["equity"] == pytest.approx(100_000 + sum(t["net_pnl"] for t in result["trades"]))
    assert trade["net_pnl"] < 0  # Flat prices are a net loss, never free profit.


def test_overnight_stop_gap_fills_at_worse_open_not_stop():
    result = simulate_portfolio(market(final_open=90.), "momentum_60d", "2026-01-05", "2026-01-07", 100_000., 5.)
    trade = result["trades"][0]
    assert trade["reason"] == "gap_stop"
    assert trade["exit"] == pytest.approx(90. * .9995)
    assert trade["exit"] < 96.  # Stop order cannot manufacture a fill through a gap.


def test_future_close_and_volume_do_not_change_prior_open_position():
    original = market()
    changed = market()
    changed["REAL_EQ"].loc["2026-01-06", ["close", "volume"]] = [110., 10_000_000.]
    a = simulate_portfolio(original, "momentum_60d", "2026-01-05", "2026-01-07")
    b = simulate_portfolio(changed, "momentum_60d", "2026-01-05", "2026-01-07")
    assert a["trades"][0]["quantity"] == b["trades"][0]["quantity"]
    assert a["trades"][0]["entry"] == b["trades"][0]["entry"]


def test_delivery_fee_model_matches_typescript_cash_ledger():
    assert delivery_leg_cost(100., 1000, "BUY") + delivery_leg_cost(100., 1000, "SELL") == pytest.approx(293.281436)
    with pytest.raises(ValueError):
        delivery_leg_cost(100., .5, "BUY")


def test_no_public_unvalidated_execution_probabilities_or_risk_boost():
    decision = System1Decision("APPROVE", "EXECUTE_IMMEDIATELY", .95, 90., position_size_multiplier=1.25)
    payload = decision.to_dict()
    assert payload["p_execution_success"] is None
    assert payload["p_stop_hunt_risk"] is None
    assert payload["p_adverse_regime_shift"] is None
    assert payload["probability_validation"] == "not_established"
    assert payload["position_size_multiplier"] == 1.


def test_missing_held_price_invalidates_portfolio_evidence():
    data = market()
    data["REAL_EQ"] = data["REAL_EQ"].drop("2026-01-07")
    result = simulate_portfolio(data, "momentum_60d", "2026-01-05", "2026-01-07")
    assert result["missing_held_position_sessions"] == 1
    assert result["valuation_status"] == "invalid_stale_marks"


def test_zero_volume_equity_does_not_become_a_tradable_fill(tmp_path):
    import json
    dates = pd.date_range("2024-01-01", periods=205, freq="B", tz="UTC")
    equity = [[int(d.timestamp() * 1000), 100, 101, 99, 100, 1000] for d in dates]
    index = [[*row[:5], 0] for row in equity]
    equity[-1][-1] = 0
    path = tmp_path / "recorded.json"
    path.write_text(json.dumps({"NIFTY": index, "REAL_EQ": equity}))
    histories, evidence = load_history(path)
    assert len(histories["NIFTY"]) == 205
    assert len(histories["REAL_EQ"]) == 204
    assert evidence["invalid_bars"]["REAL_EQ"] == 1
    assert evidence["point_in_time_universe_verified"] is False
