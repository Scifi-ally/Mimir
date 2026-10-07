"""Metrics for recorded trade outcomes; no annualized Sharpe from trade rows.

Trades overlap and are cross-sectionally correlated. Confidence intervals use
entry-date clusters, not the misleading sqrt(number_of_trades) shortcut.
Portfolio Sharpe/drawdown require marked-to-market daily equity and are left
unavailable when that data is absent.
"""
from __future__ import annotations

from collections import defaultdict
from typing import Any
import numpy as np


def trade_metrics(rows: list[dict[str, Any]], returns: np.ndarray) -> dict[str, Any]:
    values = np.asarray(returns, dtype=float)
    if len(rows) != len(values) or not np.isfinite(values).all():
        raise ValueError("Aligned finite outcomes are required")
    wins, losses = values[values > 0], values[values < 0]
    groups: dict[str, list[float]] = defaultdict(list)
    for row, value in zip(rows, values):
        groups[row["ts"][:10]].append(float(value))
    mean = float(values.mean()) if len(values) else None
    # Cluster-robust standard error of the trade-weighted mean.
    clusters = len(groups)
    se = None
    if clusters > 1 and mean is not None:
        residuals = np.array([sum(v - mean for v in groups[date]) for date in sorted(groups)])
        variance = float(np.dot(residuals, residuals))
        # Five-session outcomes overlap across entry dates as well as stocks.
        # Bartlett/Newey-West lag five; never report a smaller SE than the
        # independent-date estimate. Sparse dates remain a stated limitation.
        hac = variance
        for lag in range(1, min(5, clusters - 1) + 1):
            hac += 2 * (1 - lag / 6) * float(np.dot(residuals[lag:], residuals[:-lag]))
        se = float(np.sqrt(clusters / (clusters - 1) * max(variance, hac)) / len(values))
    return {
        "trades": len(values), "entry_date_clusters": clusters,
        "expectancy_pct": mean,
        "expectancy_cluster_95_ci": [mean - 1.96*se, mean + 1.96*se] if se is not None else None,
        "uncertainty_method": "entry-date clusters with conservative Bartlett HAC lag five",
        "win_rate": float(len(wins) / len(values)) if len(values) else None,
        "average_win_pct": float(wins.mean()) if len(wins) else None,
        "average_loss_pct": float(losses.mean()) if len(losses) else None,
        "profit_factor": float(wins.sum() / -losses.sum()) if len(losses) else None,
        "turnover_round_trips": len(values),
        "portfolio_sharpe": None, "portfolio_sortino": None, "portfolio_max_drawdown": None,
        "portfolio_metrics_reason": "Requires daily marked-to-market equity, capital allocation and overlapping position constraints",
    }


def select_threshold(probabilities: np.ndarray, returns: np.ndarray, min_trades: int) -> tuple[float, np.ndarray]:
    """Freeze a calibration-only threshold; abstain if no viable sample exists."""
    p, ret = np.asarray(probabilities), np.asarray(returns)
    grid = sorted(set(float(v) for v in np.quantile(p, [0, .5, .7, .8, .9, .95]))) if len(p) else []
    best_threshold, best_mean = 1.01, 0.0
    for threshold in grid:
        selected = p >= threshold
        if selected.sum() >= min_trades and float(ret[selected].mean()) > best_mean:
            best_mean = float(ret[selected].mean())
            best_threshold = threshold
    return best_threshold, p >= best_threshold


def calibration_bins(probabilities: np.ndarray, labels: np.ndarray) -> list[dict[str, Any]]:
    p, y = np.asarray(probabilities), np.asarray(labels)
    out = []
    for low in np.arange(0, 1, .1):
        mask = (p >= low) & ((p <= 1) if low > .89 else (p < low + .1))
        if mask.any():
            out.append({"lower": round(float(low), 1), "n": int(mask.sum()),
                        "predicted": float(p[mask].mean()), "observed": float(y[mask].mean())})
    return out
