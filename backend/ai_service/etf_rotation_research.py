"""Low-turnover cross-asset ETF rotation research on retained public NSE bhavcopies.

Why this family: earlier single-stock studies in this repo failed mainly because
flat per-order charges (brokerage + DP) consume a ₹10,000 account. A monthly,
single-position ETF rotation trades ~12 times a year and has the most published
out-of-sample support for small accounts (Faber 2007 "A Quantitative Approach to
Tactical Asset Allocation"; Antonacci 2014 "Dual Momentum"; Moskowitz, Ooi &
Pedersen 2012 "Time Series Momentum").

Discipline: all variants and the selection rule are fixed below BEFORE any
simulation. Selection uses only development data; the holdout is evaluated once
for the selected variant only. Research only: no orders, no live promotion.
"""
from __future__ import annotations

import argparse
import csv
from datetime import date, datetime, timezone
import glob
import hashlib
import io
import json
import math
import os
from pathlib import Path
import zipfile

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data/exchange_archive/raw"
OUT = ROOT / "data/strategy_lab/etf_rotation"

# Liquid NSE ETFs spanning distinct return drivers. Equity ETFs pay sell-side STT
# of 0.001%; gold/silver/international ETFs are not equity-oriented (no STT).
UNIVERSE = {
    "NIFTYBEES": "equity", "JUNIORBEES": "equity", "BANKBEES": "equity",
    "GOLDBEES": "non_equity", "SILVERBEES": "non_equity", "MON100": "non_equity",
}
# Upstox delivery (per order ₹20, sell DP ₹20) — same as execution_economics.PROFILES.
BROKERAGE, SELL_DP, NSE_RATE = 20.0, 20.0, 0.0000307


def leg_cost(price: float, qty: int, side: str, kind: str) -> float:
    turnover = price * qty
    dp = SELL_DP if side == "SELL" else 0.0
    exchange, sebi, ipft = turnover * NSE_RATE, turnover * 1e-6, turnover * 1e-9
    gst = 0.18 * (BROKERAGE + dp + exchange + sebi + ipft)
    stt = turnover * 0.00001 if (side == "SELL" and kind == "equity") else 0.0
    stamp = turnover * 0.00015 if side == "BUY" else 0.0  # delivery-buy stamp duty (conservative for ETFs)
    return BROKERAGE + dp + exchange + sebi + ipft + gst + stt + stamp


def parse_raw(symbols: set[str]) -> tuple[pd.DataFrame, dict]:
    rows, hashes = [], hashlib.sha256()
    files = sorted(glob.glob(str(RAW / "*.zip")))
    for path in files:
        archive = zipfile.ZipFile(path)
        member = archive.infolist()[0]
        payload = archive.read(member)
        hashes.update(hashlib.sha256(payload).digest())
        reader = csv.DictReader(io.StringIO(payload.decode("utf-8-sig")))
        udiff = "TckrSymb" in (reader.fieldnames or [])
        for raw in reader:
            sym = (raw.get("TckrSymb") if udiff else raw.get("SYMBOL") or "").strip()
            if sym not in symbols or (raw.get("SctySrs") if udiff else raw.get("SERIES", "")).strip() != "EQ":
                continue
            if udiff:
                day = raw["TradDt"].strip()
                f = ("OpnPric", "HghPric", "LwPric", "ClsPric", "TtlTradgVol")
            else:
                day = datetime.strptime(raw["TIMESTAMP"].strip(), "%d-%b-%Y").date().isoformat()
                f = ("OPEN", "HIGH", "LOW", "CLOSE", "TOTTRDQTY")
            try:
                o, h, l, c, v = (float(raw[k]) for k in f)
            except (ValueError, KeyError):
                continue
            if not all(map(math.isfinite, (o, h, l, c, v))) or l <= 0 or v <= 0 or h < max(o, c) or l > min(o, c):
                continue
            rows.append((day, sym, o, h, l, c, v))
    df = pd.DataFrame(rows, columns=["date", "symbol", "open", "high", "low", "close", "volume"])
    dupes = df.duplicated(["date", "symbol"], keep=False)
    df = df[~dupes]
    return df, {"raw_files": len(files), "raw_sha256": hashes.hexdigest(), "duplicates_dropped": int(dupes.sum())}


def panel(df: pd.DataFrame, field: str) -> pd.DataFrame:
    return df.pivot(index="date", columns="symbol", values=field).sort_index()


# ---------------------------------------------------------------- pre-registered variants
VARIANTS = {
    # name: (risky assets, lookback sessions or "blend", absolute filter, sma filter days)
    "bh_niftybees": None,  # benchmark only, never selectable
    "trend_nifty_sma100": ("trend", ["NIFTYBEES"], 100),
    "trend_nifty_sma200": ("trend", ["NIFTYBEES"], 200),
    "dualmom_63": ("dual", ["NIFTYBEES", "JUNIORBEES", "GOLDBEES", "MON100"], 63),
    "dualmom_126": ("dual", ["NIFTYBEES", "JUNIORBEES", "GOLDBEES", "MON100"], 126),
    "dualmom_blend": ("dual", ["NIFTYBEES", "JUNIORBEES", "GOLDBEES", "MON100"], "blend"),
    "dualmom_wide_blend": ("dual", ["NIFTYBEES", "JUNIORBEES", "BANKBEES", "GOLDBEES", "SILVERBEES", "MON100"], "blend"),
}
SELECTION = ("highest development Sharpe among non-benchmark variants with positive net return, "
             ">= 6 rebalances, max drawdown >= -15%; evaluate holdout once at 15 and 30 bps")


def momentum(close: pd.DataFrame, lookback) -> pd.DataFrame:
    if lookback == "blend":
        return (close.pct_change(21) + close.pct_change(63) + close.pct_change(126)) / 3
    return close.pct_change(lookback)


def target_schedule(close: pd.DataFrame, variant) -> pd.Series:
    """Target asset decided at each month's last session close (None = cash)."""
    kind, assets, param = variant
    month_end = close.index.to_series().groupby(pd.Index([d[:7] for d in close.index])).transform("max") == close.index.to_series()
    targets = {}
    if kind == "trend":
        sma = close[assets[0]].rolling(param, min_periods=param).mean()
        for d in close.index[month_end.values]:
            c, s = close.at[d, assets[0]], sma.at[d]
            targets[d] = assets[0] if (np.isfinite(s) and np.isfinite(c) and c > s) else ("CASH" if np.isfinite(s) else "WARMUP")
    else:
        mom = momentum(close[assets], param)
        for d in close.index[month_end.values]:
            row = mom.loc[d].dropna()
            if len(row) < len(assets):
                targets[d] = "WARMUP"
                continue
            best = row.idxmax()
            targets[d] = best if row[best] > 0 else "CASH"  # absolute momentum vs cash (LIQUIDBEES price return ~0)
    return pd.Series(targets)


def simulate(opens: pd.DataFrame, close: pd.DataFrame, schedule: pd.Series, start: str, end: str,
             capital: float, slip_bps: float) -> dict:
    dates = [d for d in close.index if start <= d <= end]
    cash, holding, qty = capital, None, 0
    equity, trades, fees_paid, rebalances = [], [], 0.0, 0
    pending, pending_set = None, False
    slip = slip_bps / 1e4
    for d in dates:
        if pending_set:  # execute decisions at this session's open
            target = pending
            pending, pending_set = None, False
            if target != holding:
                rebalances += 1
                if holding is not None:
                    px = opens.at[d, holding]
                    if not np.isfinite(px):
                        return {"invalid": f"missing open for {holding} on {d}"}
                    fill = px * (1 - slip)
                    fee = leg_cost(fill, qty, "SELL", UNIVERSE[holding])
                    cash += fill * qty - fee
                    fees_paid += fee
                    trades.append({"date": d, "side": "SELL", "symbol": holding, "qty": qty, "price": round(fill, 4), "fee": round(fee, 2)})
                    holding, qty = None, 0
                if target is not None:
                    px = opens.at[d, target]
                    if not np.isfinite(px):
                        return {"invalid": f"missing open for {target} on {d}"}
                    fill = px * (1 + slip)
                    q = int(cash // (fill * 1.003))
                    while q > 0 and q * fill + leg_cost(fill, q, "BUY", UNIVERSE[target]) > cash:
                        q -= 1
                    if q > 0:
                        fee = leg_cost(fill, q, "BUY", UNIVERSE[target])
                        cash -= q * fill + fee
                        fees_paid += fee
                        holding, qty = target, q
                        trades.append({"date": d, "side": "BUY", "symbol": target, "qty": q, "price": round(fill, 4), "fee": round(fee, 2)})
        mark = close.at[d, holding] if holding else 0.0
        if holding and not np.isfinite(mark):
            return {"invalid": f"missing close for held {holding} on {d}"}
        equity.append((d, cash + qty * mark))
        if d in schedule.index and d != dates[-1]:
            t = schedule[d]
            if t != "WARMUP":
                pending = None if t == "CASH" else t
                pending_set = True
    eq = pd.Series(dict(equity))
    r = eq.pct_change().dropna()
    monthly = eq.groupby(pd.Index([d[:7] for d in eq.index])).last().pct_change().dropna()
    dd = (eq / eq.cummax() - 1).min()
    years = len(eq) / 248
    return {
        "start": dates[0], "end": dates[-1], "sessions": len(dates),
        "final_equity": round(float(eq.iloc[-1]), 2),
        "total_return_pct": round(100 * (eq.iloc[-1] / capital - 1), 3),
        "cagr_pct": round(100 * ((eq.iloc[-1] / capital) ** (1 / years) - 1), 3) if years > 0 else None,
        "max_drawdown_pct": round(100 * float(dd), 3),
        "sharpe": round(float(r.mean() / r.std() * math.sqrt(248)), 3) if r.std() > 0 else None,
        "positive_month_rate": round(float((monthly > 0).mean()), 3) if len(monthly) else None,
        "months": int(len(monthly)), "rebalances": rebalances, "orders": len(trades),
        "fees_inr": round(fees_paid, 2), "slippage_bps_per_leg": slip_bps,
        "trades": trades,
    }


def buy_hold(opens, close, symbol, start, end, capital, slip):
    return simulate(opens, close, pd.Series({start: symbol}), start, end, capital, slip)


def run(capital: float, drawdown_gate: float = -15.0) -> dict:
    df, provenance = parse_raw(set(UNIVERSE))
    opens, close = panel(df, "open"), panel(df, "close")
    jumps = {s: [d for d, v in close[s].pct_change().items() if np.isfinite(v) and abs(v) > 0.2] for s in close}
    dates = list(close.index)
    # Warmup 126 sessions for the longest lookback; then 70/30 split with a 21-session embargo.
    usable = dates[130:]
    split = int(len(usable) * 0.7)
    dev_start, dev_end = usable[0], usable[split - 22]
    hold_start, hold_end = usable[split], usable[-1]
    spec = {"universe": UNIVERSE, "variants": {k: v for k, v in VARIANTS.items()}, "selection": SELECTION,
            "capital_inr": capital, "development": [dev_start, dev_end], "holdout": [hold_start, hold_end],
            "execution": "decide at month-end close, fill next session open, integer units, Upstox delivery fees",
            "raw_sha256": provenance["raw_sha256"], "drawdown_gate_pct": drawdown_gate,
            "post_hoc_deviation": None if drawdown_gate == -15.0 else
                "drawdown gate changed from the pre-registered -15% AFTER development results were seen"}
    spec_id = hashlib.sha256(json.dumps(spec, sort_keys=True, default=str).encode()).hexdigest()
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / f"{spec_id}.manifest.json").write_text(json.dumps(spec, indent=2, default=str), encoding="utf-8")

    dev = {}
    for name, v in VARIANTS.items():
        if v is None:
            dev[name] = buy_hold(opens, close, "NIFTYBEES", dev_start, dev_end, capital, 15)
        else:
            dev[name] = simulate(opens, close, target_schedule(close, v), dev_start, dev_end, capital, 15)
    eligible = [n for n, r in dev.items() if VARIANTS[n] is not None and "invalid" not in r
                and r["total_return_pct"] > 0 and r["rebalances"] >= 6 and r["max_drawdown_pct"] >= drawdown_gate]
    winner = max(eligible, key=lambda n: dev[n]["sharpe"] or -1e9) if eligible else None
    holdout = {}
    if winner:
        sched = target_schedule(close, VARIANTS[winner])
        for slip in (15, 30):
            holdout[f"{winner}@{slip}bps"] = simulate(opens, close, sched, hold_start, hold_end, capital, slip)
        holdout["bh_niftybees@15bps"] = buy_hold(opens, close, "NIFTYBEES", hold_start, hold_end, capital, 15)
    # Diagnostics only (never used for selection): every variant on the full period.
    full = {n: (buy_hold(opens, close, "NIFTYBEES", dev_start, hold_end, capital, 15) if v is None
                else simulate(opens, close, target_schedule(close, v), dev_start, hold_end, capital, 15))
            for n, v in VARIANTS.items()}
    current = {n: (str(target_schedule(close, v).iloc[-1]) if v else "NIFTYBEES") for n, v in VARIANTS.items()}
    report = {"experiment_id": spec_id, "created_at": datetime.now(timezone.utc).isoformat(),
              "specification": spec, "provenance": provenance, "large_one_day_moves": jumps,
              "selected": winner, "development": dev, "holdout": holdout,
              "full_period_diagnostic_not_for_selection": full,
              "latest_month_end_targets": current, "last_session": dates[-1],
              "mode": "research_only", "live_admitted": False}
    (OUT / f"{spec_id}.json").write_text(json.dumps(report, indent=2, default=str), encoding="utf-8")
    (OUT / "latest.json").write_text(json.dumps(report, indent=2, default=str), encoding="utf-8")
    return report


# Frozen from experiment c77078f2f8810ca7c373f0b3dc5ba321ecf56322946486f7e0b4faf872ffc6d5
# (development-only selection under a -20% drawdown gate, a recorded post-hoc deviation).
# Changing this constant is a NEW experiment; never re-select on recent results.
FROZEN_SIGNAL_VARIANT = "dualmom_63"
FROZEN_FROM_EXPERIMENT = "c77078f2f8810ca7c373f0b3dc5ba321ecf56322946486f7e0b4faf872ffc6d5"


def signal(capital: float) -> dict:
    """Current monthly target for the frozen variant. Research signal, not an order."""
    df, provenance = parse_raw(set(UNIVERSE))
    opens, close = panel(df, "open"), panel(df, "close")
    kind, assets, param = VARIANTS[FROZEN_SIGNAL_VARIANT]
    schedule = target_schedule(close, VARIANTS[FROZEN_SIGNAL_VARIANT])
    last = close.index[-1]
    # A month is complete only once a session from a later month exists.
    completed = [d for d in schedule.index if d[:7] < last[:7]]
    official_date = completed[-1] if completed else None
    official = schedule[official_date] if official_date else None
    mom = momentum(close[assets], param).loc[last]
    price = close.at[last, official] if official not in (None, "CASH", "WARMUP") else None
    units = int(capital // (price * 1.003)) if price else 0
    result = {
        "strategy": FROZEN_SIGNAL_VARIANT, "frozen_from_experiment": FROZEN_FROM_EXPERIMENT,
        "rule": f"At each month-end close hold the asset with the highest {param}-session return among "
                f"{assets} if that return > 0, else cash/LIQUIDBEES; act at the next session open.",
        "as_of_session": last, "decision_month_end": official_date, "target": official,
        "provisional_if_month_ended_today": str(schedule[last]) if last in schedule.index else None,
        "lookback_returns_pct": {k: (round(100 * float(v), 2) if np.isfinite(v) else None) for k, v in mom.items()},
        "indicative_units_for_capital": units, "capital_inr": capital,
        "data_stale_sessions_warning": "Run the exchange archive collection first; this reads retained bhavcopies only.",
        "evidence": "Exploratory: ~4 holdout rebalances, holdout max drawdown about -24%. Not a profit guarantee.",
        "mode": "research_signal", "live_admitted": False, "raw_sha256": provenance["raw_sha256"],
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "signal.json").write_text(json.dumps(result, indent=2, default=str), encoding="utf-8")
    return result


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--capital", type=float, default=10_000)
    ap.add_argument("--drawdown-gate", type=float, default=-15.0,
                    help="Non-default values are recorded as a post-hoc deviation")
    ap.add_argument("--signal", action="store_true", help="Emit the frozen variant's current target only")
    a = ap.parse_args()
    if a.signal:
        print(json.dumps(signal(a.capital), indent=1, default=str))
        raise SystemExit(0)
    rep = run(a.capital, a.drawdown_gate)
    strip = lambda r: {k: v for k, v in r.items() if k != "trades"}
    print(json.dumps({"experiment_id": rep["experiment_id"], "split": [rep["specification"]["development"], rep["specification"]["holdout"]],
                      "large_moves": {k: v for k, v in rep["large_one_day_moves"].items() if v},
                      "development": {k: strip(v) for k, v in rep["development"].items()},
                      "selected": rep["selected"], "holdout": {k: strip(v) for k, v in rep["holdout"].items()},
                      "full_diag": {k: strip(v) for k, v in rep["full_period_diagnostic_not_for_selection"].items()},
                      "targets": rep["latest_month_end_targets"]}, indent=1, default=str))

