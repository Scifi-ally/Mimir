import argparse
import numpy as np
import lightgbm as lgb
from train_ranker import load_rows, to_matrix, fit_isotonic, apply_isotonic, FEATURE_KEYS
from walk_forward_harness import generate_folds

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="backend/data/ranker_train.jsonl")
    args = ap.parse_args()

    rows = load_rows(args.data)
    X, y, ret = to_matrix(rows)
    
    folds = generate_folds(
        rows,
        max_label_horizon_days=5,
        embargo_window_days=1,
        test_window_days=30,
        min_train_days=180,
    )
    
    if len(folds) < 3:
        print("Not enough folds to hold out and train.")
        return 1
        
    # Hold out the last 2 folds (or the last epoch)
    holdout_folds = folds[-2:]
    train_folds = folds[:-2]
    
    print(f"Total folds: {len(folds)}")
    print(f"Train/Val folds: {len(train_folds)}")
    print(f"Holdout folds: {len(holdout_folds)}")
    
    oof_probs = []
    oof_rets = []
    oof_b = []
    
    rr_idx = FEATURE_KEYS.index("riskRewardScore")
    
    for fold_idx, (tr_idx, te_idx) in enumerate(train_folds):
        print(f"Processing Train/Val Fold {fold_idx + 1}/{len(train_folds)}...")
        num_tr = len(tr_idx)
        calib_start_idx = int(num_tr * 0.8)
        tr_sub_idx = tr_idx[:calib_start_idx]
        ca_sub_idx = tr_idx[calib_start_idx:]
        
        X_tr, y_tr = X[tr_sub_idx], y[tr_sub_idx]
        X_ca, y_ca = X[ca_sub_idx], y[ca_sub_idx]
        X_te, y_te, ret_te = X[te_idx], y[te_idx], ret[te_idx]
        
        train_set = lgb.Dataset(X_tr, label=y_tr)
        calib_set = lgb.Dataset(X_ca, label=y_ca, reference=train_set)
        
        pos_rate = max(1e-6, float(y_tr.mean()))
        scale_pos_weight = (1 - pos_rate) / pos_rate
        
        params = {
            "objective": "binary",
            "metric": "binary_logloss",
            "learning_rate": 0.03,
            "num_leaves": 31,
            "scale_pos_weight": scale_pos_weight,
            "verbose": -1,
            "seed": 42 + fold_idx,
        }
        
        booster = lgb.train(params, train_set, num_boost_round=600, valid_sets=[calib_set], callbacks=[lgb.early_stopping(50, verbose=False)])
        
        raw_ca = booster.predict(X_ca, num_iteration=booster.best_iteration)
        xs, ys = fit_isotonic(raw_ca, y_ca)
        
        raw_te = booster.predict(X_te, num_iteration=booster.best_iteration)
        cal_te = np.clip(apply_isotonic(raw_te, xs, ys), 0.0, 1.0)
        
        oof_probs.extend(cal_te)
        oof_rets.extend(ret_te)
        # Approximate b from riskRewardScore (which is 0-100)
        b_approx = np.clip(X_te[:, rr_idx] * 0.03, 0.01, 5.0) 
        oof_b.extend(b_approx)

    oof_probs = np.array(oof_probs)
    oof_rets = np.array(oof_rets)
    oof_b = np.array(oof_b)
    
    best_sharpe = -1e9
    best_thr = 0.5
    best_k = 0.25
    
    # We want to maximize a Sharpe-like metric: mean(P&L) / std(P&L)
    for thr in np.linspace(0.45, 0.75, 31):
        mask = oof_probs >= thr
        if mask.sum() < 10:
            continue
            
        p = oof_probs[mask]
        r = oof_rets[mask]
        b = oof_b[mask]
        
        for k in np.linspace(0.1, 1.0, 19): # 0.1 to 1.0 in steps of 0.05
            kelly_f = p - (1 - p) / b
            kelly_f = np.clip(kelly_f, 0, None)
            risk_pct = np.clip(kelly_f * k * 100, 0, 2.0)
            
            pnl = risk_pct * r
            
            if np.std(pnl) < 1e-6:
                continue
            sharpe = np.mean(pnl) / np.std(pnl)
            
            if sharpe > best_sharpe:
                best_sharpe = sharpe
                best_thr = float(thr)
                best_k = float(k)
                
    print(f"\nOptimized on {len(oof_probs)} OOF predictions.")
    print(f"Best Threshold: {best_thr:.3f}")
    print(f"Best Kelly Multiplier: {best_k:.3f}")
    print(f"Train/Val Sharpe: {best_sharpe:.4f}")
    
    # Now evaluate on holdout folds
    holdout_probs = []
    holdout_rets = []
    holdout_b = []
    
    for fold_idx, (tr_idx, te_idx) in enumerate(holdout_folds):
        print(f"\nProcessing Holdout Fold {fold_idx + 1}/{len(holdout_folds)}...")
        num_tr = len(tr_idx)
        calib_start_idx = int(num_tr * 0.8)
        tr_sub_idx = tr_idx[:calib_start_idx]
        ca_sub_idx = tr_idx[calib_start_idx:]
        
        X_tr, y_tr = X[tr_sub_idx], y[tr_sub_idx]
        X_ca, y_ca = X[ca_sub_idx], y[ca_sub_idx]
        X_te, y_te, ret_te = X[te_idx], y[te_idx], ret[te_idx]
        
        train_set = lgb.Dataset(X_tr, label=y_tr)
        calib_set = lgb.Dataset(X_ca, label=y_ca, reference=train_set)
        
        pos_rate = max(1e-6, float(y_tr.mean()))
        scale_pos_weight = (1 - pos_rate) / pos_rate
        
        params = {
            "objective": "binary",
            "metric": "binary_logloss",
            "learning_rate": 0.03,
            "num_leaves": 31,
            "scale_pos_weight": scale_pos_weight,
            "verbose": -1,
            "seed": 99 + fold_idx,
        }
        
        booster = lgb.train(params, train_set, num_boost_round=600, valid_sets=[calib_set], callbacks=[lgb.early_stopping(50, verbose=False)])
        raw_ca = booster.predict(X_ca, num_iteration=booster.best_iteration)
        xs, ys = fit_isotonic(raw_ca, y_ca)
        
        raw_te = booster.predict(X_te, num_iteration=booster.best_iteration)
        cal_te = np.clip(apply_isotonic(raw_te, xs, ys), 0.0, 1.0)
        
        holdout_probs.extend(cal_te)
        holdout_rets.extend(ret_te)
        b_approx = np.clip(X_te[:, rr_idx] * 0.03, 0.01, 5.0) 
        holdout_b.extend(b_approx)
        
    holdout_probs = np.array(holdout_probs)
    holdout_rets = np.array(holdout_rets)
    holdout_b = np.array(holdout_b)
    
    mask = holdout_probs >= best_thr
    taken = int(mask.sum())
    
    if taken == 0:
        print(f"\nHoldout Result: 0 trades taken at threshold {best_thr:.3f}")
    else:
        p = holdout_probs[mask]
        r = holdout_rets[mask]
        b = holdout_b[mask]
        
        kelly_f = p - (1 - p) / b
        kelly_f = np.clip(kelly_f, 0, None)
        risk_pct = np.clip(kelly_f * best_k * 100, 0, 2.0)
        
        pnl = risk_pct * r
        sharpe = np.mean(pnl) / (np.std(pnl) + 1e-9)
        total_pnl = np.sum(pnl)
        
        print("\n" + "="*50)
        print("Holdout Final Evaluation")
        print("="*50)
        print(f"Trades Taken: {taken} / {len(holdout_probs)}")
        print(f"Threshold: >={best_thr:.3f}")
        print(f"Kelly Multiplier: {best_k:.3f}")
        print(f"Total Net P&L: {total_pnl:+.4f}%")
        print(f"Holdout Sharpe (per trade): {sharpe:.4f}")
        
if __name__ == "__main__":
    main()
