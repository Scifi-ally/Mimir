"""Unit tests for low-turnover ETF dual-momentum rotation research module."""
import json
import math
from pathlib import Path
import numpy as np
import pandas as pd
import pytest

from etf_rotation_research import (
    leg_cost,
    momentum,
    target_schedule,
    simulate,
    signal,
    UNIVERSE,
    VARIANTS,
    FROZEN_SIGNAL_VARIANT,
)


def test_leg_cost_buy_vs_sell():
    # Buy ₹10,000 of equity ETF: brokerage ₹20, GST 18%, stamp duty 0.015%, exchange fee
    buy_fee = leg_cost(100.0, 100, "BUY", "equity")
    assert math.isfinite(buy_fee)
    assert buy_fee > 20.0  # brokerage + GST + stamp
    assert buy_fee < 35.0  # reasonable range for ₹10,000

    # Sell ₹10,000 of equity ETF: brokerage ₹20 + DP ₹20 + GST + STT (0.001%)
    sell_fee = leg_cost(100.0, 100, "SELL", "equity")
    assert sell_fee > buy_fee  # Sell has DP charges of ₹20
    assert 45.0 < sell_fee < 60.0

    # Non-equity ETF (Gold/Silver/International) has no STT on sell
    sell_non_eq = leg_cost(100.0, 100, "SELL", "non_equity")
    assert sell_non_eq <= sell_fee


def test_momentum_and_target_schedule():
    dates = pd.date_range("2024-01-01", periods=100, freq="B").strftime("%Y-%m-%d")
    # Asset A steadily rising, Asset B falling
    df = pd.DataFrame(
        {
            "NIFTYBEES": [100.0 + i * 0.5 for i in range(100)],
            "GOLDBEES": [100.0 - i * 0.2 for i in range(100)],
            "JUNIORBEES": [100.0 for _ in range(100)],
            "MON100": [100.0 for _ in range(100)],
        },
        index=dates,
    )
    sched = target_schedule(df, ("dual", ["NIFTYBEES", "GOLDBEES", "JUNIORBEES", "MON100"], 21))
    assert not sched.empty
    # Asset A has positive momentum, should be chosen
    valid_targets = [v for v in sched.values if v not in ("WARMUP", "CASH")]
    assert len(valid_targets) > 0
    assert valid_targets[-1] == "NIFTYBEES"


def test_absolute_momentum_switches_to_cash_when_all_negative():
    dates = pd.date_range("2024-01-01", periods=80, freq="B").strftime("%Y-%m-%d")
    # All assets falling
    df = pd.DataFrame(
        {
            "NIFTYBEES": [200.0 - i * 1.0 for i in range(80)],
            "GOLDBEES": [200.0 - i * 0.5 for i in range(80)],
            "JUNIORBEES": [200.0 - i * 1.0 for i in range(80)],
            "MON100": [200.0 - i * 1.0 for i in range(80)],
        },
        index=dates,
    )
    sched = target_schedule(df, ("dual", ["NIFTYBEES", "GOLDBEES", "JUNIORBEES", "MON100"], 21))
    # Once lookback matures, all momentum is negative -> CASH
    mature = [v for v in sched.values if v != "WARMUP"]
    assert len(mature) > 0
    assert mature[-1] == "CASH"


def test_simulation_accounting_and_cash_preservation():
    dates = pd.date_range("2024-01-01", periods=60, freq="B").strftime("%Y-%m-%d")
    opens = pd.DataFrame({"GOLDBEES": [100.0] * 60}, index=dates)
    close = pd.DataFrame({"GOLDBEES": [100.0] * 60}, index=dates)
    # Schedule to buy GOLDBEES on date 0
    sched = pd.Series({dates[0]: "GOLDBEES"})
    res = simulate(opens, close, sched, dates[0], dates[-1], capital=10000.0, slip_bps=15.0)
    assert res["sessions"] == 60
    assert res["rebalances"] == 1
    assert res["orders"] == 1
    # Capital after purchase and fee should be close to 10000 minus small fee
    assert 9900.0 < res["final_equity"] <= 10000.0
    assert res["fees_inr"] > 20.0


def test_live_signal_contract():
    sig = signal(10000.0)
    assert sig["strategy"] == FROZEN_SIGNAL_VARIANT
    assert sig["target"] in list(UNIVERSE.keys()) + ["CASH"]
    assert sig["capital_inr"] == 10000.0
    assert "lookback_returns_pct" in sig
    assert isinstance(sig["lookback_returns_pct"], dict)
    assert sig["indicative_units_for_capital"] >= 0
