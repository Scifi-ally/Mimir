"""Published delivery-fee scenarios, not trading returns or broker migration.

These October 4, 2026 tariffs are a sensitivity study. The configured Upstox
execution path is unchanged. Free official EOD data is independent of broker
market-data subscriptions. Personal tax and unverified market impact excluded.
"""
from __future__ import annotations

import json
import math

PROFILES = {
    "upstox_delivery": {"brokerage_inr_per_order": 20., "sell_dp_inr": 20., "nse_transaction_rate": .0000307,
        "source": "https://upstox.com/brokerage-charges/"},
    "dhan_delivery": {"brokerage_inr_per_order": 0., "sell_dp_inr": 12.5, "nse_transaction_rate": .000030699,
        "source": "https://dhan.co/pricing/"},
}


def scenario_leg_cost(price: float, quantity: int, side: str, profile: str) -> float:
    if profile not in PROFILES or side not in ("BUY", "SELL") or isinstance(quantity, bool) or not isinstance(quantity, int) or quantity <= 0 or not math.isfinite(price) or price <= 0:
        raise ValueError("Known tariff and positive integer fill required")
    tariff = PROFILES[profile]
    turnover = price * quantity
    brokerage = tariff["brokerage_inr_per_order"]
    dp = tariff["sell_dp_inr"] if side == "SELL" else 0.
    exchange, sebi, ipft = turnover * tariff["nse_transaction_rate"], turnover * .000001, turnover * .000000001
    gst = .18 * (brokerage + dp + exchange + sebi + ipft)
    return brokerage + dp + exchange + sebi + ipft + gst + turnover * .001 + (turnover * .00015 if side == "BUY" else 0.)


def cost_scenario(reference: float, quantity: int, profile: str, capital=10000., risk_pct=1., slippage_bps=15.) -> dict:
    if not all(math.isfinite(v) for v in (capital, risk_pct, slippage_bps)) or capital <= 0 or not 0 < risk_pct <= 1 or not 0 <= slippage_bps < 10000:
        raise ValueError("Valid bounded cost scenario required")
    slip = slippage_bps / 10000
    buy = reference * (1 + slip)
    buy_fee = scenario_leg_cost(buy, quantity, "BUY", profile)
    def pnl(move):
        sell = reference * (1 + move) * (1 - slip)
        return (sell - buy) * quantity - buy_fee - scenario_leg_cost(sell, quantity, "SELL", profile)
    lower, upper = 0., 1.
    while pnl(upper) < 0:
        upper *= 2
    for _ in range(80):
        middle = (lower + upper) / 2
        if pnl(middle) < 0:
            lower = middle
        else:
            upper = middle
    friction = -pnl(0)
    return {"profile": profile, "tariff": dict(PROFILES[profile]), "tariff_checked_on": "2026-10-04",
        "reference_price_inr": reference, "quantity": quantity, "position_notional_inr": reference * quantity,
        "capital_inr": capital, "risk_budget_inr": capital * risk_pct / 100,
        "slippage_bps_per_leg": slippage_bps, "flat_price_round_trip_loss_inr": friction,
        "friction_fraction_of_risk_budget": friction / (capital * risk_pct / 100),
        "break_even_price_move_pct": 100 * upper, "forecast_return_pct": None,
        "scope": "fee_and_slippage_sensitivity_not_a_strategy_backtest", "broker_changed": False}


if __name__ == "__main__":
    print(json.dumps({"scenarios": [cost_scenario(100., 20, profile) for profile in PROFILES],
        "data_plan": "retained free NSE EOD archives; no paid broker market-data subscription",
        "profitability_established": False}, indent=2, allow_nan=False))
