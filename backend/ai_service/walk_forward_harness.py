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

    timestamps = []
    resolution_timestamps = []
    for r in rows:
        ts = parse_iso(r.get("ts", ""))
        res_ts = parse_iso(r.get("resolutionTs", r.get("ts", "")))
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
    if lgb is None:
        print("ERROR: lightgbm not installed.")
        return 2, []

    if not os.path.exists(args.data):
        print(f"ERROR: training data not found at {args.data}")
        return 2, []

    rows = load_rows(args.data)
    if len(rows) < 100:
        print(f"ERROR: only {len(rows)} rows. Need more history.")
        return 2, []

    X, y, ret = to_matrix(rows)
    n = len(rows)
    
    folds = generate_folds(
        rows,
        max_label_horizon_days=5,
        embargo_window_days=1,
        test_window_days=30,
        min_train_days=args.min_train_days,
        rolling_fixed_window=args.rolling,
    )

    print(f"Loaded {n} rows. Generated {len(folds)} folds.")

    aggregate_preds = []
    aggregate_labels = []
    aggregate_rets = []
    
    feature_fold_importances = defaultdict(list)

    for fold_idx, (tr_idx, te_idx) in enumerate(folds):
        # We need a calibration slice from the end of the train set.
        # Let's use the last 20% of the train set (by time, since rows are sorted).
        num_tr = len(tr_idx)
        calib_start_idx = int(num_tr * 0.8)
        
        tr_sub_idx = tr_idx[:calib_start_idx]
        ca_sub_idx = tr_idx[calib_start_idx:]
        
        X_tr, y_tr = X[tr_sub_idx], y[tr_sub_idx]
        X_ca, y_ca, ret_ca = X[ca_sub_idx], y[ca_sub_idx], ret[ca_sub_idx]
        X_te, y_te, ret_te = X[te_idx], y[te_idx], ret[te_idx]
        
        if len(X_tr) < 10 or len(X_ca) < 10 or len(X_te) < 10:
            print(f"Fold {fold_idx + 1}: Skipping due to insufficient data (train: {len(X_tr)}, calib: {len(X_ca)}, test: {len(X_te)})")
            continue

        pos_rate = max(1e-6, float(y_tr.mean()))
        scale_pos_weight = (1 - pos_rate) / pos_rate

        train_set = lgb.Dataset(X_tr, label=y_tr, feature_name=FEATURE_KEYS)
        calib_set = lgb.Dataset(X_ca, label=y_ca, reference=train_set)

        params = {
            "objective": "binary",
            "metric": ["auc", "binary_logloss"],
            "learning_rate": 0.03,
            "num_leaves": 31,
            "max_depth": 6,
            "min_data_in_leaf": max(10, len(X_tr) // 100),
            "feature_fraction": 0.8,
            "bagging_fraction": 0.8,
            "bagging_freq": 5,
            "lambda_l1": 0.5,
            "lambda_l2": 1.0,
            "scale_pos_weight": scale_pos_weight,
            "verbose": -1,
            "seed": 42 + fold_idx,
        }

        booster = lgb.train(
            params,
            train_set,
            num_boost_round=600,
            valid_sets=[calib_set],
            valid_names=["calib"],
            callbacks=[lgb.early_stopping(50, verbose=False)],
        )

        raw_ca = np.asarray(booster.predict(X_ca, num_iteration=booster.best_iteration))
        xs, ys = fit_isotonic(raw_ca, y_ca)
        
        raw_te = np.asarray(booster.predict(X_te, num_iteration=booster.best_iteration))
        cal_te = np.clip(apply_isotonic(raw_te, xs, ys), 0.0, 1.0)
        
        test_auc = auc(y_te, raw_te)
        test_brier = brier(y_te, cal_te)
        
        best_thr, sel_exp, sel_taken = 0.5, -1e9, 0
        for thr in np.linspace(0.45, 0.75, 31):
            exp, taken = expectancy_at_threshold(cal_ca, ret_ca, float(thr))
            if taken >= max(10, len(X_ca) // 20) and exp > sel_exp:
                best_thr, sel_exp, sel_taken = float(thr), exp, taken

        take_all_exp = float(ret_te.mean())
        best_exp, best_taken = expectancy_at_threshold(cal_te, ret_te, best_thr)
        
        print(f"\nFold {fold_idx + 1:02d} | Train: {len(X_tr)}, Calib: {len(X_ca)}, Test: {len(X_te)}")
        print(f"  Hit rate     - Train: {y_tr.mean():.3f}, Calib: {y_ca.mean():.3f}, Test: {y_te.mean():.3f}")
        print(f"  Metrics      - AUC: {test_auc:.4f}, Brier: {test_brier:.4f}")
        print(f"  Take-All     - Expectancy: {take_all_exp:+.4f}%, n={len(X_te)}")
        print(f"  Threshold    - p>={best_thr:.3f} (chosen on CALIB)")
        print(f"  Strategy     - Expectancy: {best_exp:+.4f}%, n={best_taken}")

        if shap is not None:
            explainer = shap.TreeExplainer(booster)
            shap_values = explainer.shap_values(X_te)
            if isinstance(shap_values, list):
                shap_values = shap_values[1]
            mean_abs_shap = np.abs(shap_values).mean(axis=0)
            for j, feat in enumerate(FEATURE_KEYS):
                feature_fold_importances[feat].append(float(mean_abs_shap[j]))

        aggregate_preds.extend(cal_te)
        aggregate_labels.extend(y_te)
        aggregate_rets.extend(ret_te)

    if not aggregate_preds:
        print("No valid folds completed.")
        return 1
        
    print("\n" + "="*50)
    print("Aggregate Out-Of-Fold Summary")
    print("="*50)
    
    agg_labels = np.array(aggregate_labels)
    agg_preds = np.array(aggregate_preds)
    agg_rets = np.array(aggregate_rets)
    
    agg_auc = auc(agg_labels, agg_preds)
    agg_brier = brier(agg_labels, agg_preds)
    agg_take_all_exp = agg_rets.mean()
    
    # We can evaluate aggregate greenlight expectancy at various fixed thresholds,
    # or just show the aggregate of the per-fold threshold selections.
    # The true "strategy" performance is the aggregate of each fold's choices.
    
    print(f"Total out-of-fold trades evaluated: {len(agg_labels)}")
    print(f"Overall hit rate:                   {agg_labels.mean():.3f}")
    print(f"Overall OOF AUC:                    {agg_auc:.4f}")
    print(f"Overall OOF Brier Score:            {agg_brier:.4f}")
    print(f"Overall Take-All Expectancy:        {agg_take_all_exp:+.4f}%")
    
    print("\nCalibration check (Predicted vs Realized):")
    bins = np.linspace(0, 1, 11)
    for i in range(len(bins)-1):
        mask = (agg_preds >= bins[i]) & (agg_preds < bins[i+1])
        if mask.sum() > 0:
            pred_mean = agg_preds[mask].mean()
            real_mean = agg_labels[mask].mean()
            print(f"  Bin {bins[i]:.1f}-{bins[i+1]:.1f}: Pred={pred_mean:.3f}, Real={real_mean:.3f} (n={mask.sum()})")

    unstable_features = []
    if shap is not None and feature_fold_importances:
        print("\n" + "="*50)
        print("SHAP Stability Report (Across Folds)")
        print("="*50)
        
        cv_report = []
        for feat in FEATURE_KEYS:
            vals = feature_fold_importances[feat]
            if len(vals) == 0:
                continue
            mean_imp = np.mean(vals)
            std_imp = np.std(vals)
            cv = std_imp / (mean_imp + 1e-9)
            cv_report.append((cv, mean_imp, feat))
            
        cv_report.sort(key=lambda x: x[0])
        print(f"{'Feature':<20} | {'Mean SHAP':<12} | {'CV':<10}")
        print("-" * 48)
        for cv, mean_imp, feat in cv_report:
            print(f"{feat:<20} | {mean_imp:<12.5f} | {cv:<10.5f}")
            if hasattr(args, 'drop_unstable') and args.drop_unstable is not None:
                if cv > args.drop_unstable:
                    unstable_features.append(feat)
                    
        if unstable_features:
            print(f"\n[WARNING] {len(unstable_features)} features exceeded CV threshold {args.drop_unstable}.")
            print("Unstable features: " + ", ".join(unstable_features))
    elif shap is None:
        print("\nNotice: 'shap' library not installed. SHAP stability report skipped.")

    return 0, unstable_features

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=os.path.join(os.path.dirname(__file__), "..", "data", "ranker_train.jsonl"))
    ap.add_argument("--min-train-days", type=int, default=180)
    ap.add_argument("--rolling", action="store_true", help="Use rolling fixed-window folds instead of expanding window")
    ap.add_argument("--drop-unstable", type=float, default=None, help="Threshold for CV of SHAP values to drop unstable features (e.g. 1.0).")
    args = ap.parse_args()
    status, _ = run_harness(args)
    return status

if __name__ == "__main__":
    sys.exit(main())
