import copy

import pandas as pd
import pytest

from market_regime import POLICY, STRATEGY, entry_regime, market_factor_panel, trend_score
from portfolio_research import simulate_portfolio
from test_portfolio_research import market


def broad_market():
    source = market()
    stock = source["REAL_EQ"].copy()
    stock["mom126"], stock["vol126"], stock["vol20"], stock["atr"] = .30, .01, .01, .5
    stock["low"], stock["high"] = 99.8, 100.2
    benchmark = stock.copy()
    benchmark["mom60"] = .05
    return {"NIFTY": benchmark, **{f"EQ_{i:03d}": stock.copy() for i in range(200)}}


def test_breadth_requires_actual_sufficient_observations_and_missing_is_not_neutral():
    incomplete = broad_market()
    incomplete.pop("EQ_000")
    first = market_factor_panel(incomplete)["2026-01-05"]
    assert first["eligible_names"] == 199 and first["breadth50"] is None
    assert not entry_regime(first, incomplete["NIFTY"].iloc[0].to_dict())
    full = broad_market()
    factors = market_factor_panel(full)["2026-01-05"]
    assert factors["breadth50"] == 1
    assert factors["nifty_annualized_volatility20"] == pytest.approx(.01 * 252 ** .5)
    assert entry_regime(factors, full["NIFTY"].iloc[0].to_dict())
    assert not factors["point_in_time_membership_verified"]


def test_future_prices_or_future_liquidity_cannot_change_prior_breadth_or_ranking():
    original = broad_market()
    changed = copy.deepcopy(original)
    for symbol, frame in changed.items():
        frame.loc["2026-01-07", ["close", "ema50", "turnover20"]] = [1, 10000, 1]
    a, b = market_factor_panel(original), market_factor_panel(changed)
    assert a["2026-01-05"] == b["2026-01-05"]
    assert a["2026-01-06"] == b["2026-01-06"]


def test_custom_candidate_rejects_extension_weak_relative_trend_and_high_volatility():
    row = broad_market()["EQ_000"].iloc[0].to_dict()
    assert trend_score(row, .05) is not None
    assert trend_score({**row, "ema20": 90}, .05) is None
    assert trend_score({**row, "atr": 3}, .05) is None
    assert trend_score(row, .19) is None
    assert trend_score({**row, "mom126": float("nan")}, .05) is None


def test_small_account_cost_hurdle_rejects_churn_without_altering_risk_limit():
    frames = broad_market()
    for symbol, frame in frames.items():
        if symbol != "NIFTY":
            frame["mom60"] = .09
    result = simulate_portfolio(frames, STRATEGY, "2026-01-05", "2026-01-07", 10000, 15,
        enforce_economics=True, risk_policy="total_loss_budget", maximum_risk_pct=1)
    assert result["rejected_entries"]["observed_movement_cost_hurdle"] > 0
    assert result["statistics"]["trades"] == 0
    assert result["maximum_risk_pct"] == 1
    assert result["strategy_policy"] == POLICY


def test_market_breakdown_exits_at_following_open_and_future_close_does_not_change_fill():
    frames = broad_market()
    for symbol, frame in frames.items():
        if symbol != "NIFTY":
            frame.loc["2026-01-06", "ema50"] = 110
    result = simulate_portfolio(frames, STRATEGY, "2026-01-05", "2026-01-07", 100000, 15,
        enforce_economics=True, risk_policy="total_loss_budget", maximum_risk_pct=1)
    assert result["trades"][0]["entry_date"] == "2026-01-06"
    assert result["trades"][0]["exit_date"] == "2026-01-07"
    assert result["trades"][0]["reason"] == "prior_close_rule"
    assert result["trades"][0]["quantity"] * result["trades"][0]["entry"] <= 20000
