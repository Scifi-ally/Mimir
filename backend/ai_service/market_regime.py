"""Timestamp-local market breadth from retained free exchange price observations.

This is the observed liquid research universe, not historical Nifty membership.
Metrics describe market conditions; none is a calibrated return probability.
"""
from __future__ import annotations

import math
import numpy as np

STRATEGY = "breadth_quality_trend"
POLICY = {
    "version": 1, "maximum_liquid_universe": 500, "minimum_breadth_names": 200,
    "minimum_turnover_inr": 50_000_000, "breadth50_entry_minimum": .60,
    "breadth200_entry_minimum": .60, "breadth50_exit_below": .40,
    "maximum_nifty_annualized_volatility": .25, "minimum_momentum60": .08,
    "minimum_momentum126": .12, "minimum_relative_momentum60": .03,
    "maximum_atr_fraction": .015, "maximum_ema20_extension": .06,
    "maximum_cost_fraction_of_observed_momentum": 1 / 3,
    "holding_sessions": 63, "stop_atr_multiple": 1.5, "entry_schedule": "weekly",
}


def market_factor_panel(histories: dict) -> dict:
    panel = {}
    benchmark = histories["NIFTY"]
    fields = ("close", "ema50", "ema200", "turnover20", "mom20")
    records = {symbol: frame.to_dict(orient="index") for symbol, frame in histories.items() if symbol != "NIFTY"}
    for day, b in benchmark.iterrows():
        eligible = []
        for symbol, rows in records.items():
            row = rows.get(day)
            if row is None or any(not math.isfinite(row.get(k, float("nan"))) for k in fields):
                continue
            if row["close"] <= 0 or row["turnover20"] < POLICY["minimum_turnover_inr"]:
                continue
            if not all(math.isfinite(row.get(k, float("nan"))) for k in ("open", "high", "low", "volume")) or row["volume"] <= 0:
                continue
            eligible.append((symbol, row))
        eligible.sort(key=lambda pair: (-pair[1]["turnover20"], pair[0]))
        liquid = eligible[:POLICY["maximum_liquid_universe"]]
        count = len(liquid)
        enough = count >= POLICY["minimum_breadth_names"]
        vol = b.get("vol20", float("nan"))
        annual_vol = float(vol * np.sqrt(252)) if math.isfinite(vol) else None
        panel[day] = {
            "as_of": day, "available_at": day + "T15:30:00+05:30",
            "source": "retained_completed_daily_prices", "universe": "observed_liquid_research_universe",
            "point_in_time_membership_verified": False, "eligible_names": count,
            "breadth50": sum(r["close"] > r["ema50"] for _, r in liquid) / count if enough else None,
            "breadth200": sum(r["close"] > r["ema200"] for _, r in liquid) / count if enough else None,
            "median_momentum20": float(np.median([r["mom20"] for _, r in liquid])) if enough else None,
            "nifty_annualized_volatility20": annual_vol, "liquid_symbols": [s for s, _ in liquid],
            "predictive_validation": "not_established",
        }
    return panel


def entry_regime(factors: dict, benchmark: dict) -> bool:
    keys = ("breadth50", "breadth200", "median_momentum20", "nifty_annualized_volatility20")
    if any(factors.get(k) is None or not math.isfinite(factors[k]) for k in keys):
        return False
    if any(not math.isfinite(benchmark.get(k, float("nan"))) for k in ("close", "ema50", "ema200")):
        return False
    return (factors["breadth50"] >= POLICY["breadth50_entry_minimum"]
        and factors["breadth200"] >= POLICY["breadth200_entry_minimum"]
        and factors["median_momentum20"] > 0
        and factors["nifty_annualized_volatility20"] <= POLICY["maximum_nifty_annualized_volatility"]
        and benchmark["close"] > benchmark["ema50"] > benchmark["ema200"])


def trend_score(row: dict, benchmark_return: float) -> float | None:
    keys = ("close", "ema20", "ema50", "ema200", "atr", "mom20", "mom60", "mom126", "vol126")
    if not math.isfinite(benchmark_return) or any(not math.isfinite(row.get(k, float("nan"))) for k in keys):
        return None
    if not row["close"] > row["ema20"] > row["ema50"] > row["ema200"] > 0 or row["atr"] <= 0:
        return None
    if (row["mom60"] < POLICY["minimum_momentum60"] or row["mom126"] < POLICY["minimum_momentum126"]
        or row["mom20"] <= 0 or row["mom60"] - benchmark_return < POLICY["minimum_relative_momentum60"]
        or row["atr"] / row["close"] > POLICY["maximum_atr_fraction"]
        or row["close"] / row["ema20"] - 1 > POLICY["maximum_ema20_extension"]):
        return None
    return (.5 * row["mom60"] + .5 * row["mom126"]) / max(row["vol126"], .005)
