import pytest

from portfolio_research import planned_stop_loss, simulate_portfolio
from test_portfolio_research import market


def test_small_account_costs_consume_risk_budget_without_being_ignored():
    result = simulate_portfolio(market(), "momentum_60d", "2026-01-05", "2026-01-06", 10000, 15,
                                enforce_economics=True, finalize=False, risk_policy="total_loss_budget")
    position = result["open_positions"]["REAL_EQ"]
    assert 0 < position["planned_stop_loss_inr"] <= 100
    assert position["entry_fee"] > 20
    assert position["quantity"] < 20
    assert result["cash"] >= 0
    assert result["risk_per_trade_pct"] == 1


def test_slipped_stop_loss_and_fee_ledger_reconcile_with_sized_budget():
    result = simulate_portfolio(market(second_low=95), "momentum_60d", "2026-01-05", "2026-01-06", 10000, 15,
                                enforce_economics=True, risk_policy="total_loss_budget")
    trade = result["trades"][0]
    assert -100 <= trade["net_pnl"] < -70
    assert result["cash"] == pytest.approx(10000 + trade["net_pnl"])


def test_one_share_that_exceeds_budget_is_rejected_and_gaps_can_exceed_it():
    too_small = simulate_portfolio(market(), "momentum_60d", "2026-01-05", "2026-01-07", 5000, 15,
                                  enforce_economics=True, risk_policy="total_loss_budget")
    assert not too_small["trades"]
    gap = simulate_portfolio(market(final_open=80), "momentum_60d", "2026-01-05", "2026-01-07", 10000, 15,
                            enforce_economics=True, risk_policy="total_loss_budget")
    assert gap["trades"][0]["net_pnl"] < -100
    assert gap["trades"][0]["reason"] == "gap_stop"


def test_invalid_risk_policy_or_excessive_limit_cannot_arm_simulation():
    for options in ({"risk_policy": "unknown"}, {"maximum_risk_pct": 2}, {"maximum_risk_pct": float("nan")}, {"maximum_risk_pct": True}):
        with pytest.raises(ValueError, match="risk policy"):
            simulate_portfolio(market(), "momentum_60d", "2026-01-05", "2026-01-07", **options)
