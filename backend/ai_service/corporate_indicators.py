"""Causal indicator adjustment on raw execution prices; no settlement assumptions.

Each action changes only indicator rows on/after its ex-date. Earlier computed
features are never rewritten using a later dividend or share ratio. Coverage and
historical announcement chronology must be verified separately.
"""
from __future__ import annotations

from fractions import Fraction
import math

import numpy as np
import pandas as pd

from corporate_accounting import decode_action

PRICE_COLUMNS = ["open", "high", "low", "close"]


def compute_indicators(raw: pd.DataFrame) -> pd.DataFrame:
    frame = raw.copy()
    close = frame.close
    for span in (20, 50, 200):
        frame[f"ema{span}"] = close.ewm(span=span, adjust=False, min_periods=span).mean()
    for horizon in (20, 60, 126, 252):
        frame[f"mom{horizon}"] = close.pct_change(horizon, fill_method=None)
    frame["turnover20"] = (close * frame.volume).rolling(20).mean()
    tr = pd.concat([frame.high - frame.low, (frame.high - close.shift()).abs(), (frame.low - close.shift()).abs()], axis=1).max(axis=1)
    frame["atr"] = tr.rolling(14).mean()
    delta = close.diff()
    gain = delta.clip(lower=0).ewm(alpha=.5, adjust=False).mean()
    loss = (-delta.clip(upper=0)).ewm(alpha=.5, adjust=False).mean()
    frame["rsi2"] = 100 - 100 / (1 + gain / loss.replace(0, np.nan))
    frame.loc[(loss == 0) & (gain > 0), "rsi2"] = 100
    frame["high20"] = frame.high.shift(1).rolling(20).max()
    frame["volume20"] = frame.volume.shift(1).rolling(20).mean()
    for horizon in (20, 126):
        frame[f"vol{horizon}"] = np.log(close).diff().rolling(horizon).std()
    path = np.log(close).diff().abs().rolling(60).sum()
    frame["efficiency60"] = (np.log(close) - np.log(close.shift(60))).abs() / path.replace(0, np.nan)
    frame["ema50_slope20"] = frame.ema50.pct_change(20, fill_method=None)
    return frame


def adjusted_indicator_history(raw: pd.DataFrame, events: list[dict]) -> tuple[pd.DataFrame, list[dict]]:
    if raw.index.has_duplicates or not raw.index.is_monotonic_increasing:
        raise ValueError("Unique ordered indicator sessions required")
    work = raw.copy()
    work[PRICE_COLUMNS + ["volume"]] = work[PRICE_COLUMNS + ["volume"]].astype(float)
    output = compute_indicators(raw)
    columns = [c for c in output if c not in raw.columns]
    diagnostics = []
    groups = {}
    for event in events:
        day = event["ex_date"]
        if day > raw.index[-1]:
            continue
        groups.setdefault(day, []).append(event)
    for day, actions in sorted(groups.items()):
        terms = [decode_action(e["purpose"]) for e in actions]
        economic = [t for t in terms if t["kind"] != "notice"]
        if not economic:
            continue
        older = work.index < day
        if not work.loc[older, "close"].notna().any():
            continue  # No pre-action prices exist for this instrument.
        reason = None
        if len(economic) != 1:
            reason = "multiple_same_date_economic_terms_require_verified_share_basis"
        elif economic[0]["kind"] == "unsupported":
            reason = "unsupported_corporate_terms"
        elif day not in work.index or not np.isfinite(work.loc[day, PRICE_COLUMNS]).all():
            reason = "ex_date_price_missing"
        if reason:
            output.loc[output.index >= day, columns] = np.nan
            diagnostics.append({"ex_date": day, "status": "blocked", "reason": reason})
            break
        action = economic[0]
        volume_factor = 1.0
        if action["kind"] in ("split", "bonus"):
            volume_factor = float(Fraction(action["share_multiplier"]))
            price_factor = 1 / volume_factor
        else:
            previous = work.loc[older, "close"].iloc[-1]
            price_factor = (previous - action["cash_per_share"]) / previous
        if not math.isfinite(price_factor) or not 0 < price_factor < float("inf"):
            output.loc[output.index >= day, columns] = np.nan
            diagnostics.append({"ex_date": day, "status": "blocked", "reason": "invalid_or_missing_cum_date_price"})
            break
        work.loc[older, PRICE_COLUMNS] *= price_factor
        work.loc[older, "volume"] *= volume_factor
        features = compute_indicators(work)
        # Causal rolling/EMA calculations depend only on preceding/current rows.
        # Retain already computed earlier rows, rather than back-adjusting them.
        output.loc[output.index >= day, columns] = features.loc[features.index >= day, columns]
        diagnostics.append({"ex_date": day, "status": "adjusted", "kind": action["kind"],
                            "price_factor": price_factor, "volume_factor": volume_factor})
    # Execution prices and observed liquidity are always the raw tape.
    output["turnover20"] = (raw.close * raw.volume).rolling(20).mean()
    return output, diagnostics
