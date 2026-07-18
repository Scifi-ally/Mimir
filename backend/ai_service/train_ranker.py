"""
Train the learned ranker: a LightGBM classifier that predicts
P(trade hits target1 before stop) from the shared candle-derived feature
contract, calibrated to real probabilities on a held-out time slice.

Pipeline:
  1. Load JSONL rows produced by scripts/extract_training_data.ts
     (each: { ts, symbol, setupType, direction, features:[...], label, retPct }).
  2. WALK-FORWARD split by time: the earliest `train_frac` of rows (by ts) train,
     the middle `calib_frac` calibrates, the most recent slice is the out-of-sample
     TEST. No shuffling — a model that only works because it peeked at the future
     is worse than useless, so the split is strictly chronological.
  3. Train LightGBM with early stopping against the calibration slice.
  4. Fit an isotonic map on the calibration slice (raw score -> real P(win)).
  5. Report out-of-sample metrics on TEST: AUC, Brier, and — the number that
     actually matters — the expectancy of trades the model would GREENLIGHT at a
     probability threshold vs. taking every trade. If the model does not beat
     "take every signal" out-of-sample, we DO NOT write artifacts (a bad model
     silently shipped is the worst outcome).

Artifacts written next to the AI service (only on success):
  ranker_model.txt, ranker_meta.json

Run:
  python backend/ai_service/train_ranker.py \
    --data backend/data/ranker_train.jsonl [--min-rows 300] [--threshold auto]
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

# Keep the feature key list in sync with feature_engine.ts RANKER_FEATURE_KEYS.
# The extractor already emits features in this exact order; this list is stored
# in the meta purely so predictions are self-describing and importances are named.
FEATURE_KEYS = [
    "rsi14", "atr14", "atrPct", "adx14", "volumeRatio", "vwapDistance",
    "ema20Dist", "ema50Dist", "ema200Dist", "emaAlignment", "trendConsistency",
    "rsVsNifty60d", "rsVsSector60d", "pocDistancePct", "bbWidthPct",
    "vcpContraction", "momentumScore", "trendScore", "volatilityScore",
    "riskRewardScore", "priceRoc5", "priceRoc10", "priceRoc20",
    "bodyRatio", "upperWickRatio", "lowerWickRatio", "closeLocation",
    "realizedVol5", "realizedVol20", "volOfVol", "cprWidthPct",
]

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH = os.path.join(HERE, "ranker_model.txt")
META_PATH = os.path.join(HERE, "ranker_meta.json")


def load_rows(path: str) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    # Chronological order is essential for a walk-forward split.
    rows.sort(key=lambda r: r.get("ts", ""))
    return rows


def to_matrix(rows: List[Dict[str, Any]]) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    n = len(rows)
    d = len(FEATURE_KEYS)
    X = np.zeros((n, d), dtype=np.float64)
    y = np.zeros(n, dtype=np.int32)
    ret = np.zeros(n, dtype=np.float64)
    for i, r in enumerate(rows):
        feats = r.get("features", [])
        for j in range(min(d, len(feats))):
            v = feats[j]
            X[i, j] = v if isinstance(v, (int, float)) and math.isfinite(v) else 0.0
        y[i] = int(r.get("label", 0))
        ret[i] = float(r.get("retPct", 0.0))
    return X, y, ret


def fit_isotonic(scores: np.ndarray, labels: np.ndarray) -> Tuple[List[float], List[float]]:
    """Fit a monotonic score->probability map. Uses sklearn's IsotonicRegression
    when available, else a simple binned-monotonic fallback (pool-adjacent-violators
    is overkill for the fallback; equal-frequency bins + cummax is monotone and
    good enough to avoid a hard sklearn dependency)."""
    order = np.argsort(scores)
    s = scores[order]
    l = labels[order].astype(np.float64)
    try:
        from sklearn.isotonic import IsotonicRegression

        iso = IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0)
        iso.fit(s, l)
        xs = np.linspace(float(s.min()), float(s.max()), num=50)
        ys = iso.predict(xs)
        return [float(v) for v in xs], [float(v) for v in ys]
    except Exception:
        # Fallback: equal-frequency bins, monotone via cumulative max of bin means.
        n = len(s)
        nb = max(4, min(20, n // 50))
        edges = np.linspace(0, n, nb + 1).astype(int)
        xs, ys = [], []
        run_max = 0.0
        for b in range(nb):
            lo, hi = edges[b], edges[b + 1]
            if hi <= lo:
                continue
            xs.append(float(s[lo:hi].mean()))
            run_max = max(run_max, float(l[lo:hi].mean()))
            ys.append(run_max)
        if len(xs) < 2:
            return [0.0, 1.0], [float(l.mean()), float(l.mean())]
        return xs, ys


def apply_isotonic(p: np.ndarray, xs: List[float], ys: List[float]) -> np.ndarray:
    if len(xs) < 2:
        return p
    return np.interp(p, np.asarray(xs), np.asarray(ys))


def auc(labels: np.ndarray, scores: np.ndarray) -> float:
    """Rank-based AUC (Mann-Whitney), no sklearn dependency."""
    pos = scores[labels == 1]
    neg = scores[labels == 0]
    if len(pos) == 0 or len(neg) == 0:
        return float("nan")
    order = np.argsort(scores)
    ranks = np.empty_like(order, dtype=np.float64)
    ranks[order] = np.arange(1, len(scores) + 1)
    # Average ranks for ties
    _, inv, counts = np.unique(scores, return_inverse=True, return_counts=True)
    sums = np.zeros(len(counts))
    np.add.at(sums, inv, ranks)
    avg = sums / counts
    ranks = avg[inv]
    r_pos = ranks[labels == 1].sum()
    n_pos, n_neg = len(pos), len(neg)
    return float((r_pos - n_pos * (n_pos + 1) / 2) / (n_pos * n_neg))


def brier(labels: np.ndarray, probs: np.ndarray) -> float:
    return float(np.mean((probs - labels) ** 2))


def expectancy_at_threshold(
    probs: np.ndarray, rets: np.ndarray, thr: float
) -> Tuple[float, int]:
    mask = probs >= thr
    taken = int(mask.sum())
    if taken == 0:
        return 0.0, 0
    return float(rets[mask].mean()), taken


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=os.path.join(HERE, "..", "data", "ranker_train.jsonl"))
    ap.add_argument("--min-rows", type=int, default=300)
    ap.add_argument("--train-frac", type=float, default=0.6)
    ap.add_argument("--calib-frac", type=float, default=0.2)
    ap.add_argument("--threshold", default="auto",
                    help="'auto' picks the prob threshold maximising TEST expectancy, or a float")
    ap.add_argument("--force", action="store_true",
                    help="Skip the champion-challenger gate and deploy if it beats take-all (first deploy / manual retrain)")
    args = ap.parse_args()

    try:
        import lightgbm as lgb
    except ImportError:
        print("ERROR: lightgbm not installed. `pip install lightgbm` (or scikit-learn) to train.")
        print("The serving path degrades gracefully without it — training is the only blocker.")
        return 2

    if not os.path.exists(args.data):
        print(f"ERROR: training data not found at {args.data}")
        print("Run: npx tsx backend/scripts/extract_training_data.ts first.")
        return 2

    rows = load_rows(args.data)
    if len(rows) < args.min_rows:
        print(f"ERROR: only {len(rows)} rows (< min-rows {args.min_rows}). Need more history/scans.")
        return 2

    X, y, ret = to_matrix(rows)
    n = len(rows)
    i_train = int(n * args.train_frac)
    i_calib = int(n * (args.train_frac + args.calib_frac))

    X_tr, y_tr = X[:i_train], y[:i_train]
    X_ca, y_ca, ret_ca = X[i_train:i_calib], y[i_train:i_calib], ret[i_train:i_calib]
    X_te, y_te, ret_te = X[i_calib:], y[i_calib:], ret[i_calib:]

    print(f"Rows: {n}  train={len(X_tr)}  calib={len(X_ca)}  test={len(X_te)}")
    print(f"Base win rate — train {y_tr.mean():.3f} | calib {y_ca.mean():.3f} | test {y_te.mean():.3f}")
    if len(X_ca) < 30 or len(X_te) < 30:
        print("ERROR: calib/test slice too small for a trustworthy evaluation.")
        return 2

    # Class imbalance handling: weight positives by inverse prevalence.
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
        "min_data_in_leaf": 40,
        "feature_fraction": 0.8,
        "bagging_fraction": 0.8,
        "bagging_freq": 5,
        "lambda_l1": 0.5,
        "lambda_l2": 1.0,
        "scale_pos_weight": scale_pos_weight,
        "verbose": -1,
        "seed": 42,
    }

    booster = lgb.train(
        params,
        train_set,
        num_boost_round=600,
        valid_sets=[calib_set],
        valid_names=["calib"],
        callbacks=[lgb.early_stopping(50, verbose=False), lgb.log_evaluation(0)],
    )

    # Calibrate on the calib slice, evaluate on the untouched test slice.
    raw_ca = np.asarray(booster.predict(X_ca, num_iteration=booster.best_iteration))
    xs, ys = fit_isotonic(raw_ca, y_ca)
    cal_ca = np.clip(apply_isotonic(raw_ca, xs, ys), 0.0, 1.0)

    raw_te = np.asarray(booster.predict(X_te, num_iteration=booster.best_iteration))
    cal_te = np.clip(apply_isotonic(raw_te, xs, ys), 0.0, 1.0)

    test_auc = auc(y_te, raw_te)
    test_brier = brier(y_te, cal_te)

    # Choose the decision threshold on the CALIB slice, then freeze it. Selecting
    # it on TEST and reporting that maximum would be selection bias: the live gate
    # and the shipped threshold would be optimistically overfit to one window.
    # TEST stays a true holdout used only to evaluate the frozen threshold.
    if args.threshold == "auto":
        best_thr, sel_exp, sel_taken = 0.5, -1e9, 0
        for thr in np.linspace(0.45, 0.75, 31):
            exp, taken = expectancy_at_threshold(cal_ca, ret_ca, float(thr))
            # Require a minimum sample so we don't pick a threshold that only
            # greenlights a few lucky trades.
            if taken >= max(20, len(X_ca) // 20) and exp > sel_exp:
                best_thr, sel_exp, sel_taken = float(thr), exp, taken
    else:
        best_thr = float(args.threshold)

    # Evaluate the frozen threshold out-of-sample on TEST — these are the numbers
    # that gate shipping and get reported.
    take_all_exp = float(ret_te.mean())
    best_exp, best_taken = expectancy_at_threshold(cal_te, ret_te, best_thr)

    print("\n── Out-of-sample (TEST) ─────────────────────────────")
    print(f"AUC:               {test_auc:.4f}   (0.5 = no skill)")
    print(f"Brier:             {test_brier:.4f}  (lower = better calibrated)")
    print(f"Threshold p>={best_thr:.3f} chosen on CALIB (exp {sel_exp:+.4f}%, n={sel_taken})"
          if args.threshold == "auto" else f"Threshold p>={best_thr:.3f} (fixed)")
    print(f"Take-ALL expectancy:       {take_all_exp:+.4f}% / trade  (n={len(X_te)})")
    print(f"Greenlight @ p>={best_thr:.3f}:   {best_exp:+.4f}% / trade  (n={best_taken})")

    # Gate 1: the model must (a) show real ranking skill and (b) improve expectancy
    # out-of-sample. Otherwise refuse to ship — the composite fallback is safer.
    improves = (
        not math.isnan(test_auc)
        and test_auc >= 0.53
        and best_taken > 0
        and best_exp > take_all_exp
        and best_exp > 0
    )
    if not improves:
        print("\nRESULT: model does NOT beat take-all out-of-sample (AUC>=0.53 & "
              "positive, improved expectancy required). Artifacts NOT written; "
              "serving stays on the composite fallback.")
        return 1

    # Gate 2 (champion-challenger): if a champion is already deployed, the new
    # model must beat it, not merely beat take-all. A retrain on an unlucky data
    # window must never silently demote a good incumbent. The comparison uses the
    # champion's recorded greenlight expectancy with a small margin so we don't
    # churn the model on noise. Set --force to override (first deploy / manual).
    if not args.force and os.path.exists(META_PATH):
        try:
            with open(META_PATH, "r", encoding="utf-8") as fh:
                champ = json.load(fh)
            champ_exp = float(champ.get("metrics", {}).get("greenlight_expectancy_pct", -1e9))
            # Require the challenger to clear the champion by a margin scaled to the
            # champion's own expectancy (10% relative, min 0.02%/trade absolute).
            margin = max(0.02, abs(champ_exp) * 0.10)
            if best_exp <= champ_exp + margin:
                print(
                    f"\nRESULT: challenger expectancy {best_exp:+.4f}% does not beat "
                    f"champion {champ_exp:+.4f}% by margin {margin:.4f}%. "
                    f"Champion RETAINED; challenger discarded."
                )
                return 1
            print(f"Champion-challenger: challenger {best_exp:+.4f}% beats champion "
                  f"{champ_exp:+.4f}% (margin {margin:.4f}%). Promoting.")
        except Exception as exc:  # unreadable champion meta — treat as no champion
            print(f"Champion meta unreadable ({exc}); proceeding as first deploy.")

    booster.save_model(MODEL_PATH, num_iteration=booster.best_iteration)
    importances = dict(zip(FEATURE_KEYS, [int(v) for v in booster.feature_importance()]))
    meta = {
        "feature_keys": FEATURE_KEYS,
        "isotonic": {"x": xs, "y": ys},
        "recommended_threshold": best_thr,
        "metrics": {
            # This is the out-of-sample TEST AUC. Kept the legacy "val_auc" key
            # for backward-compat with already-deployed meta files.
            "test_auc": round(test_auc, 4),
            "val_auc": round(test_auc, 4),
            "test_brier": round(test_brier, 4),
            "take_all_expectancy_pct": round(take_all_exp, 4),
            "greenlight_expectancy_pct": round(best_exp, 4),
            "greenlight_n": best_taken,
            "test_n": len(X_te),
        },
        "feature_importance": importances,
        "trained_at": _utc_now(),
    }
    with open(META_PATH, "w", encoding="utf-8") as fh:
        json.dump(meta, fh, indent=2)

    print(f"\nRESULT: model beats take-all. Wrote:\n  {MODEL_PATH}\n  {META_PATH}")
    top = sorted(importances.items(), key=lambda kv: -kv[1])[:8]
    print("Top features: " + ", ".join(f"{k}={v}" for k, v in top))
    return 0


def _utc_now() -> str:
    # Avoid importing datetime.now at module import to keep this deterministic-ish;
    # the timestamp is metadata only.
    import datetime
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


if __name__ == "__main__":
    sys.exit(main())
