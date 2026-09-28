"""
Is per-symbol expectancy a real, exploitable signal, or sampling noise?

26 of 95 symbols showed positive expectancy on the full 5y set. If that is
noise, trading it is a coin flip dressed as a strategy. The honest test is
out-of-sample: rank symbols by expectancy on the TRAIN+CALIB window only, then
measure what that same basket returns on the untouched TEST window.

The learned ranker cannot make this detector set profitable (best decile sits
at ~9% win rate against a 13.1% breakeven), so a name-level filter is the only
lead with a plausible mechanism left.
"""
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from train_ranker import load_rows, to_matrix, purged_chronological_split, auc  # noqa: E402

DATA = os.path.join(HERE, "..", "data", "ranker_train.jsonl")
TRAIN_FRAC, CALIB_FRAC, EMBARGO_H = 0.6, 0.2, 24.0
MIN_ROWS_IN = 25  # per symbol, in the selection window


def bucket(rows):
    m = {}
    for r in rows:
        m.setdefault(r["symbol"], []).append(r)
    return m


def expectancy(rows):
    if not rows:
        return None, 0
    return float(np.mean([r["retPct"] for r in rows])), len(rows)


def main() -> int:
    rows = load_rows(DATA)
    tr, ca, te, _ = purged_chronological_split(rows, TRAIN_FRAC, CALIB_FRAC, EMBARGO_H)
    sel = tr + ca  # everything the selector is allowed to look at

    sel_by = bucket(sel)
    te_by = bucket(te)

    stats = []
    for sym, rs in sel_by.items():
        exp, n = expectancy(rs)
        if exp is None or n < MIN_ROWS_IN:
            continue
        stats.append((sym, exp, n))
    stats.sort(key=lambda x: -x[1])

    print(f"selection window: train+calib rows={len(sel)}  symbols={len(sel_by)}")
    print(f"eligible symbols (n>={MIN_ROWS_IN} in selection window): {len(stats)}\n")

    # Realised TEST expectancy of the top-k names chosen in the selection window.
    print("=== top-k symbols by SELECTION-window expectancy, measured on TEST ===")
    print(f"  {'k':>4} {'nNames':>7} {'testN':>7} {'testExp%':>10} {'vs take-all':>13} {'win%':>7}")

    _, _, r_te = to_matrix(te)
    y_te = np.array([r["label"] for r in te], dtype=float)
    take_all = float(r_te.mean())

    for k in (10, 20, 30, 40, 50, 60):
        chosen = [s for s, _, _ in stats[:k]]
        picked = [r for r in te if r["symbol"] in set(chosen)]
        if not picked:
            continue
        exp, n = expectancy(picked)
        win = float(np.mean([r["label"] for r in picked])) * 100
        delta = exp - take_all
        flag = "  <-- beats take-all" if delta > 0 else ""
        print(f"  {k:4d} {len(chosen):7d} {n:7d} {exp:+10.4f} {delta:+13.4f} {win:7.2f}{flag}")

    print(f"\n  take-all TEST expectancy = {take_all:+.4f}% / trade (n={len(te)})\n")

    # Control: is a random basket of the same size any different? If not, the
    # per-symbol signal is indistinguishable from luck.
    print("=== control: random symbols of the same size (200 draws) ===")
    rng = np.random.default_rng(12345)
    all_syms = sorted(sel_by.keys())
    results = []
    for k in (30, 50):
        wins = 0
        for _ in range(200):
            chosen = set(rng.choice(all_syms, size=min(k, len(all_syms)), replace=False))
            picked = [r for r in te if r["symbol"] in chosen]
            if not picked:
                continue
            exp, _ = expectancy(picked)
            if exp - take_all > 0:
                wins += 1
        print(f"  k={k:3d}: random basket beat take-all in {wins/200*100:5.1f}% of draws")

    # A directional control, since SELL was much worse than BUY.
    print("\n=== direction control on TEST ===")
    for d in ("BUY", "SELL"):
        sub = [r for r in te if r["direction"] == d]
        exp, n = expectancy(sub)
        win = float(np.mean([r["label"] for r in sub])) * 100
        print(f"  {d:5s} n={n:6d}  exp={exp:+.4f}%  win={win:5.2f}%")
    return 0


if __name__ == "__main__":
    sys.exit(main())
