"""Fixed longer-hold hypothesis; price efficiency is not fundamental quality."""
from __future__ import annotations

import math
from market_regime import POLICY as BASE_POLICY

STRATEGY = "breadth_efficient_trend_carry"
POLICY = {**BASE_POLICY, "holding_sessions": 126, "stop_atr_multiple": 3.,
    "maximum_atr_fraction": .04, "minimum_momentum60": .04, "minimum_momentum126": .10,
    "maximum_ema20_extension": .08, "minimum_efficiency60": .35,
    "minimum_skipped_month_momentum126": .08, "exit_average": "ema200"}


def carry_score(row: dict, benchmark_return: float) -> float | None:
    required = ("close", "ema20", "ema50", "ema200", "atr", "mom20", "mom60", "mom126", "vol126", "efficiency60", "ema50_slope20")
    if not math.isfinite(benchmark_return) or any(not math.isfinite(row.get(k, float("nan"))) for k in required):
        return None
    if not row["close"] > row["ema50"] > row["ema200"] > 0 or row["ema20"] <= 0 or row["atr"] <= 0 or row["mom20"] <= -1:
        return None
    skipped = (1 + row["mom126"]) / (1 + row["mom20"]) - 1
    if (row["mom60"] < POLICY["minimum_momentum60"] or row["mom126"] < POLICY["minimum_momentum126"]
        or skipped < POLICY["minimum_skipped_month_momentum126"]
        or row["mom60"] - benchmark_return <= 0 or row["ema50_slope20"] <= 0
        or row["efficiency60"] < POLICY["minimum_efficiency60"]
        or row["atr"] / row["close"] > POLICY["maximum_atr_fraction"]
        or row["close"] / row["ema20"] - 1 > POLICY["maximum_ema20_extension"]):
        return None
    return skipped * row["efficiency60"] / max(row["vol126"], .005)
