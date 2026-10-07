from __future__ import annotations

import argparse
import datetime
import json
import math
import os
import sys
from typing import Any, Dict, List, Tuple
from collections import defaultdict

import numpy as np

# Use the same feature keys as train_ranker.py
from train_ranker import FEATURE_KEYS, load_rows, to_matrix, fit_isotonic, apply_isotonic, auc, brier, expectancy_at_threshold

try:
    import lightgbm as lgb
except ImportError:
    lgb = None

try:
    import shap
except ImportError:
    shap = None

VALIDATED_STRATEGY_SCOPE = {
    "version": "cash-long-5bar-20d-turnover-v1",
    "horizon_bars": 5,
    "direction": "BUY",
    "notional_inr": 100_000,
    "minimum_average_turnover_20d_inr": 50_000_000,
    "maximum_notional_to_average_turnover_20d": 0.001,
    "fee_model": "upstox-cash-delivery-2026-10",
    "minimum_slippage_bps_per_side": 5,
}

def parse_iso(ts_str: str) -> float:
    if not ts_str:
        return 0.0
    s = ts_str.replace("Z", "+00:00")
    return datetime.datetime.fromisoformat(s).timestamp()

def generate_folds(
    rows: List[Dict[str, Any]],
    max_label_horizon_days: int = 5,
    embargo_window_days: int = 1,
    test_window_days: int = 30,
    min_train_days: int = 180,
    rolling_fixed_window: bool = False,
) -> List[Tuple[List[int], List[int]]]:
    """
    Generate purged, embargoed walk-forward folds.
    Returns a list of (train_indices, test_indices).
    """
    if not rows:
        return []

    from train_ranker import _timestamp_ms
    timestamps = []
    resolution_timestamps = []
    for r in rows:
        ts = _timestamp_ms(r.get("ts"), "ts") / 1000
        res_ts = _timestamp_ms(r.get("resolutionTs"), "resolutionTs") / 1000
        if res_ts <= ts:
            raise ValueError("Label must resolve strictly after signal availability")
        timestamps.append(ts)
        resolution_timestamps.append(res_ts)

    start_ts = timestamps[0]
    end_ts = timestamps[-1]
    
    STRUCTURAL_BREAKS = [
        parse_iso("2024-11-20T00:00:00Z"),
        parse_iso("2025-09-01T00:00:00Z"),
    ]
    STRUCTURAL_BREAKS.sort()
    
    epochs = []
    current_epoch_start = start_ts
    for b in STRUCTURAL_BREAKS:
        if current_epoch_start < b:
            epochs.append((current_epoch_start, min(b, end_ts)))
        current_epoch_start = max(current_epoch_start, b)
    if current_epoch_start < end_ts:
        epochs.append((current_epoch_start, end_ts))
        
    DAY = 86400
    folds = []
    
    for epoch_start, epoch_end in epochs:
        current_train_end = epoch_start + (min_train_days * DAY)
        
        while current_train_end < epoch_end:
            if rolling_fixed_window:
                train_start = current_train_end - (min_train_days * DAY)
            else:
                train_start = epoch_start

            purge_start = current_train_end
            purge_end = purge_start + (max_label_horizon_days * DAY)
            embargo_end = purge_end + (embargo_window_days * DAY)
            test_start = embargo_end
            test_end = test_start + (test_window_days * DAY)
            
            if test_start >= epoch_end:
                break
                
            actual_test_end = min(test_end, epoch_end)
                
            train_indices = []
            test_indices = []
            
            for i, (ts, res_ts) in enumerate(zip(timestamps, resolution_timestamps)):
                # Train set
                if train_start <= ts < purge_start:
                    # PURGE: Drop training row if its label resolution falls at or after purge_start
                    if res_ts < purge_start:
                        train_indices.append(i)
                # Test set
                elif test_start <= ts < actual_test_end:
                    test_indices.append(i)
                    
            if len(train_indices) > 0 and len(test_indices) > 0:
                folds.append((train_indices, test_indices))
                
            current_train_end = test_end

    return folds

def run_harness(args) -> Tuple[int, List[str]]:
    from train_ranker import purged_chronological_split
    from validation_metrics import trade_metrics, select_threshold, calibration_bins
    import hashlib
    if lgb is None:
        print("ERROR: lightgbm not installed.")
        return 2, []
    try:
        rows = load_rows(args.data)
    except (OSError, ValueError) as exc:
        print(f"ERROR: {exc}")
        return 2, []
    if len(rows) < 300:
        print(f"ERROR: only {len(rows)} rows; need at least 300.")
        return 2, []
    X, y, ret = to_matrix(rows)
    folds = generate_folds(rows, min_train_days=getattr(args, "min_train_days", 180),
                           rolling_fixed_window=getattr(args, "rolling", False))
    print(f"Loaded {len(rows)} rows. Generated {len(folds)} folds.")
    all_indices, all_preds, selected_indices, selected_preds = [], [], [], []
    reports = []
    for fold_idx, (tr_idx, te_idx) in enumerate(folds):
        # Reuse the training splitter: preserve simultaneous signal groups and
        # purge labels at BOTH internal train/calibration and outer test edges.
        development = [rows[i] for i in tr_idx] + [rows[i] for i in te_idx]
        total = len(development)
        train_frac = len(tr_idx) * .8 / total
        calib_frac = len(tr_idx) * .2 / total
        train_rows, calib_rows, _, split = purged_chronological_split(
            development, train_frac, calib_frac, 24)
        X_tr, y_tr, _ = to_matrix(train_rows)
        X_ca, y_ca, ret_ca = to_matrix(calib_rows)
        X_te, y_te, ret_te = X[te_idx], y[te_idx], ret[te_idx]
        if min(len(X_tr), len(X_ca), len(X_te)) < 30 or len(np.unique(y_tr)) < 2:
            print(f"Fold {fold_idx+1}: insufficient train/calibration/test observations")
            continue
        booster = lgb.train({
            "objective": "binary", "metric": "binary_logloss", "learning_rate": .03,
            "num_leaves": 15, "max_depth": 4, "min_data_in_leaf": 40,
            "feature_fraction": .8, "bagging_fraction": .8, "bagging_freq": 5,
            "lambda_l1": .5, "lambda_l2": 1., "verbose": -1,
            "seed": 42, "num_threads": 2,
        }, lgb.Dataset(X_tr, label=y_tr, feature_name=FEATURE_KEYS),
            num_boost_round=300, valid_sets=[lgb.Dataset(X_ca, label=y_ca)],
            callbacks=[lgb.early_stopping(30, verbose=False)])
        raw_ca = np.asarray(booster.predict(X_ca))
        xs, ys = fit_isotonic(raw_ca, y_ca)
        cal_ca = np.clip(apply_isotonic(raw_ca, xs, ys), 0, 1)
        raw_te = np.asarray(booster.predict(X_te))
        cal_te = np.clip(apply_isotonic(raw_te, xs, ys), 0, 1)
        threshold, _ = select_threshold(cal_ca, ret_ca, max(30, len(X_ca)//20))
        mask = cal_te >= threshold
        picked = [i for i, keep in zip(te_idx, mask) if keep]
        all_indices.extend(te_idx); all_preds.extend(cal_te)
        selected_indices.extend(picked); selected_preds.extend(cal_te[mask])
        # Permutation lift uses TEST only as a diagnostic, never to select/drop
        # features or retrain this fold. Shuffle within entry date to preserve
        # market regime; this measures conditional cross-sectional contribution.
        groups = defaultdict(list)
        for i, row_idx in enumerate(te_idx):
            groups[rows[row_idx]["ts"][:10]].append(i)
        base_loss = brier(y_te, cal_te)
        feature_lift = {}
        rng = np.random.default_rng(42)
        for j, feature in enumerate(FEATURE_KEYS):
            perturbed = X_te.copy()
            for group in groups.values():
                perturbed[group, j] = perturbed[rng.permutation(group), j]
            perm = apply_isotonic(np.asarray(booster.predict(perturbed)), xs, ys)
            feature_lift[feature] = brier(y_te, perm) - base_loss
        report = {"fold": fold_idx+1, "train_n": len(X_tr), "calibration_n": len(X_ca),
                  "test_n": len(X_te), "threshold": threshold, "split": split,
                  "test_start": rows[te_idx[0]]["ts"], "test_end": rows[te_idx[-1]]["ts"],
                  "auc": auc(y_te, raw_te) if len(np.unique(y_te)) == 2 else None, "brier": base_loss,
                  "brier_base_rate": brier(y_te, np.full(len(y_te), float(y_tr.mean()))),
                  "take_all": trade_metrics([rows[i] for i in te_idx], ret_te),
                  "selected": trade_metrics([rows[i] for i in picked], ret[picked]),
                  "permutation_brier_lift": feature_lift}
        reports.append(report)
        print(f"Fold {fold_idx+1}: AUC={report['auc']}, all={ret_te.mean():+.4f}%, "
              f"selected={report['selected']['expectancy_pct']}, n={len(picked)}, threshold={threshold:.4f}")
    selected_rows = [rows[i] for i in selected_indices]
    selected_returns = ret[selected_indices]
    stats = trade_metrics(selected_rows, selected_returns)
    # Cost stress adds 10 bps to EACH leg beyond the replay's baseline costs.
    stressed = trade_metrics(selected_rows, selected_returns - .2)
    ci = stressed["expectancy_cluster_95_ci"]
    replay_verified = all(r.get("replayVersion") == "limit-gap-v2" and
                          r.get("feeModel") == VALIDATED_STRATEGY_SCOPE["fee_model"] and
                          r.get("notionalInr") == VALIDATED_STRATEGY_SCOPE["notional_inr"] and
                          r.get("direction") == VALIDATED_STRATEGY_SCOPE["direction"] and
                          r.get("slippageBpsPerSide", 0) >= VALIDATED_STRATEGY_SCOPE["minimum_slippage_bps_per_side"] and
                          r.get("horizonBars") == VALIDATED_STRATEGY_SCOPE["horizon_bars"] and
                          r.get("strategyScopeVersion") == VALIDATED_STRATEGY_SCOPE["version"] and
                          isinstance(r.get("averageTurnover20dInr"), (int, float)) and
                          math.isfinite(r["averageTurnover20dInr"]) and
                          r["averageTurnover20dInr"] >= VALIDATED_STRATEGY_SCOPE["minimum_average_turnover_20d_inr"] and
                          r["notionalInr"] / r["averageTurnover20dInr"] <= VALIDATED_STRATEGY_SCOPE["maximum_notional_to_average_turnover_20d"]
                          for r in rows)
    # Current membership is not historical membership. Explicitly prevent
    # deployment until the source supplies point-in-time universe provenance.
    universe_verified = all(r.get("pointInTimeUniverse") is True for r in rows)
    passed = (len(reports) >= 3 and stats["trades"] >= 100 and ci is not None and ci[0] > 0
              and replay_verified and universe_verified)
    report = {"validation_version": 2, "passed": bool(passed),
              "data_sha256": hashlib.sha256(open(args.data, "rb").read()).hexdigest(),
              "folds": reports, "take_all": trade_metrics([rows[i] for i in all_indices], ret[all_indices]),
              "selected": stats, "cost_stress": stressed,
              "calibration": calibration_bins(np.array(all_preds), y[all_indices]),
              "replay_verified": replay_verified, "point_in_time_universe_verified": universe_verified,
              "strategy_scope_verified": replay_verified,
              "strategy_scope": VALIDATED_STRATEGY_SCOPE,
              "limitations": ["Daily bars cannot resolve intrabar ordering",
                              "The score estimates target-before-stop probability, not probability of any profit or expected return",
                              "Live confidence and risk filters add gates not represented by score-only fold selection",
                              "Legacy institutional-flow history lacks source/publication provenance and is treated as missing",
                              "No portfolio equity curve; portfolio Sharpe/Sortino/drawdown unavailable",
                              "Entry-date HAC uncertainty remains approximate with sparse sessions and changing universe",
                              "Current-universe backfills cannot establish absence of survivorship bias"]}
    args.validation_report = report
    report_path = getattr(args, "report", None)
    if report_path:
        os.makedirs(os.path.dirname(os.path.abspath(report_path)), exist_ok=True)
        with open(report_path, "w", encoding="utf-8") as fh:
            json.dump(report, fh, indent=2, allow_nan=False)
    print(json.dumps({"selected": stats, "cost_stress": stressed, "passed": bool(passed)}, indent=2))
    return (0 if passed else 1), []

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=os.path.join(os.path.dirname(__file__), "..", "data", "ranker_train.jsonl"))
    ap.add_argument("--min-train-days", type=int, default=180)
    ap.add_argument("--report", default=None)
    ap.add_argument("--rolling", action="store_true", help="Use rolling fixed-window folds instead of expanding window")
    ap.add_argument("--drop-unstable", type=float, default=None, help="Threshold for CV of SHAP values to drop unstable features (e.g. 1.0).")
    args = ap.parse_args()
    status, _ = run_harness(args)
    return status

if __name__ == "__main__":
    sys.exit(main())
