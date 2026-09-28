"""
Is the learned ranker worth pursuing on the current detector set?

The trainer correctly refuses to ship a model whose greenlight expectancy is
negative. But that alone does not say whether the *approach* is dead: if the
best-scoring decile of candidates is already comfortably profitable, more/better
data or a better model would cross the line. If even the top 1% loses money,
then no ranker can rescue this detector set and the real fix is the setup
geometry (target/stop/hold), not the model.

Reuses train_ranker.py's own purged chronological split and feature prep so the
numbers line up with what the trainer reports.
"""
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from train_ranker import (  # noqa: E402
    load_rows,
    to_matrix,
    purged_chronological_split,
    auc,
)

DATA = os.path.join(HERE, "..", "data", "ranker_train.jsonl")
TRAIN_FRAC, CALIB_FRAC, EMBARGO_H = 0.6, 0.2, 24.0


def main() -> int:
    rows = load_rows(DATA)
    if not rows:
        print("no rows")
        return 1
    # rows[0]["features"] is the float vector, not names; take names from the
    # shared manifest so the per-feature table is readable.
    manifest = os.path.join(HERE, "..", "config", "ranker_features_manifest.json")
    try:
        with open(manifest, "r", encoding="utf-8") as fh:
            feat_names = json.load(fh)
    except Exception:
        feat_names = [f"f{j}" for j in range(len(rows[0]["features"]))]
    n_feat = len(feat_names)
    print(f"rows={len(rows)} features={n_feat}")
    base = float(np.mean([r["label"] for r in rows]))
    print(f"base win rate (all rows) = {base*100:.2f}%\n")

    tr, ca, te, _ = purged_chronological_split(rows, TRAIN_FRAC, CALIB_FRAC, EMBARGO_H)
    X_tr, y_tr, r_tr = to_matrix(tr)
    X_ca, y_ca, r_ca = to_matrix(ca)
    X_te, y_te, r_te = to_matrix(te)
    print(f"train={len(X_tr)} calib={len(X_ca)} test={len(X_te)}")
    print(f"test base win rate = {y_te.mean()*100:.2f}%\n")

    import lightgbm as lgb

    params = {
        "objective": "binary",
        "metric": ["auc", "binary_logloss"],
        "learning_rate": 0.05,
        "num_leaves": 31,
        "min_data_in_leaf": 40,
        "feature_fraction": 0.8,
        "bagging_fraction": 0.8,
        "bagging_freq": 1,
        "lambda_l1": 0.5,
        "lambda_l2": 1.0,
        "verbose": -1,
        "seed": 42,
    }
    ds_tr = lgb.Dataset(X_tr, label=y_tr)
    ds_ca = lgb.Dataset(X_ca, label=y_ca, reference=ds_tr)
    booster = lgb.train(
        params, ds_tr, num_boost_round=800, valid_sets=[ds_ca],
        callbacks=[lgb.early_stopping(50, verbose=False)],
    )
    s_te = booster.predict(X_te, num_iteration=booster.best_iteration)
    a = auc(y_te, s_te)
    print(f"test AUC = {a:.4f}\n")

    take_all = float(r_te.mean())
    print(f"take-all expectancy = {take_all:+.4f}% / trade (n={len(y_te)})\n")

    print("=== lift curve on TEST (greenlight the top-k% by model score) ===")
    print(f"  {'top%':>6} {'n':>6} {'win%':>7} {'exp%':>9} {'vs take-all':>12}")
    order = np.argsort(-s_te)
    for frac in (0.01, 0.02, 0.05, 0.10, 0.20, 0.30, 0.50):
        k = max(1, int(len(order) * frac))
        idx = order[:k]
        wr = float(y_te[idx].mean()) * 100
        exp = float(r_te[idx].mean())
        delta = exp - take_all
        flag = "  <-- beats take-all" if delta > 0 else ""
        print(f"  {frac*100:6.1f} {k:6d} {wr:7.2f} {exp:+9.4f} {delta:+12.4f}{flag}")

    # What win rate is actually needed to break even at the observed payoff?
    wins = r_te[y_te == 1]
    losses = r_te[y_te == 0]
    mean_win = float(wins.mean())
    mean_loss = float(losses.mean())
    if mean_loss != 0:
        breakeven = -mean_loss / (mean_win - mean_loss)
        print(f"\nmean WIN  = {mean_win:+.4f}%  (n={len(wins)})")
        print(f"mean LOSS = {mean_loss:+.4f}%  (n={len(losses)})")
        print(f"breakeven win rate at this payoff = {breakeven*100:.2f}%")
        print(f"observed test win rate            = {y_te.mean()*100:.2f}%")

    # Per-feature lift: is there ANY feature that separates winners?
    print("\n=== single-feature AUC on TEST (|auc-0.5| as signal) ===")
    scores = []
    for j, name in enumerate(feat_names):
        aj = auc(y_te, X_te[:, j])
        scores.append((abs(aj - 0.5), aj, name))
    for d, aj, name in sorted(scores, reverse=True)[:10]:
        print(f"  {name:<24} auc={aj:.4f}  lift={d:.4f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
