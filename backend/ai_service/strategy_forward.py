"""Immutable daily observation journal and shadow portfolio, never broker orders."""
from __future__ import annotations

import argparse
from datetime import datetime
import hashlib
import json
from pathlib import Path

import numpy as np
import pandas as pd

from portfolio_research import load_history, simulate_portfolio, engine_fingerprint
from strategy_lab import atomic_json, compact, admission
from strategy_promotion import policy_sha256
from nse_corporate_archive import ROOT, preopen_receipt, session_events
from corporate_history import load_frozen_corporate


def serial_frame(frame: pd.DataFrame) -> dict:
    return json.loads(frame.replace([np.inf, -np.inf], np.nan).to_json(orient="index"))


def record_session(data: Path, directory: Path, now=None, archives=None) -> dict:
    clock = pd.Timestamp(now or datetime.now().astimezone()).tz_convert("Asia/Kolkata")
    latest = directory / "latest.json"
    if not latest.exists():
        raise ValueError("Run a frozen research experiment first")
    research = json.loads(latest.read_text(encoding="utf-8"))
    risk_policy = research.get("specification", {}).get("risk_policy", "legacy_cost_screen")
    maximum_risk_pct = research.get("specification", {}).get("maximum_risk_pct", 1.0)
    strategy = research["selected_strategy"]
    if strategy is None:
        result = {"mode": "shadow_paper", "signal_status": "ABSTAIN", "live_admitted": False,
                  "reason": "no_development_candidate_passed", "observed_at": clock.isoformat(),
                  "experiment_id": research["experiment_id"], "statistics": None}
        atomic_json(directory / "forward-status.json", result)
        return result
    if research.get("mode") == "exploratory_cost_comparison" or research["specification"].get("fee_profile", "upstox_delivery") != "upstox_delivery":
        raise ValueError("Alternative delivery tariff studies cannot seed the configured broker forward cohort")
    engine_hash = engine_fingerprint()
    if research["specification"].get("engine_sha256") != engine_hash:
        raise ValueError("Engine changed since the experiment; forward evidence cannot be recalculated with different rules")
    if clock.hour < 15 or (clock.hour == 15 and clock.minute < 30):
        raise ValueError("Completed daily session required")
    day = clock.strftime("%Y-%m-%d")
    journal_path = directory / "forward-journal.json"
    corporate = load_frozen_corporate(directory, research)
    corporate_receipt = preopen_receipt(archives, day) if archives is not None else None
    indicator_events = list(corporate["events"]) if corporate else []
    if corporate is not None and journal_path.exists():
        old = json.loads(journal_path.read_text(encoding="utf-8"))
        indicator_events.extend(e for s in old["sessions"] if s["date"] < day for e in s.get("corporate_events", []))
    if corporate is not None and corporate_receipt is not None:
        indicator_events.extend(session_events(corporate_receipt, day))
    histories, provenance = load_history(data, quarantine=True, corporate_events=indicator_events if corporate is not None else None)
    source_kind = research["specification"].get("source_kind", "recorded_vendor_candles")
    if source_kind != provenance["source_kind"]:
        raise ValueError("Forward data source is frozen; exchange and vendor price bases cannot be mixed")
    if research["specification"].get("calendar_sha256") != provenance["calendar_sha256"]:
        raise ValueError("Exchange calendar changed since the experiment; use a separate frozen experiment")
    if archives is not None:
        received = pd.Timestamp(corporate_receipt["observed_at"])
        opening = pd.Timestamp(day + "T09:15:00+05:30")
        if received.tzinfo is None or not pd.Timedelta(0) <= opening - received <= pd.Timedelta(hours=96) or not corporate_receipt["from"] <= day <= corporate_receipt["to"]:
            raise ValueError("Fresh corporate coverage received before the session open required")
    benchmark = histories["NIFTY"]
    if day not in benchmark.index or not bool(benchmark.loc[day, "observed"]):
        raise ValueError("Current-session recorded benchmark missing; refusing stale/backfilled forward evidence")
    if journal_path.exists():
        journal = json.loads(journal_path.read_text(encoding="utf-8"))
        context_hash = hashlib.sha256(json.dumps(journal["context"], sort_keys=True, allow_nan=False).encode()).hexdigest()
        if context_hash != journal.get("context_sha256") or journal.get("engine_sha256") != engine_hash:
            raise ValueError("Forward context or engine changed; journal needs review")
        previous_hash = context_hash
        for observed in journal["sessions"]:
            content = {k: v for k, v in observed.items() if k != "sha256"}
            digest = hashlib.sha256(json.dumps(content, sort_keys=True, allow_nan=False).encode()).hexdigest()
            if digest != observed["sha256"] or observed["previous_sha256"] != previous_hash:
                raise ValueError("Forward observation hash chain invalid; journal needs review")
            previous_hash = digest
        if journal["experiment_id"] != research["experiment_id"]:
            raise ValueError("Forward experiment is frozen; strategy reselection requires a separate journal directory")
        if journal.get("source_kind", "recorded_vendor_candles") != source_kind:
            raise ValueError("Forward journal source kind differs from the frozen experiment")
        if journal.get("corporate_history_sha256") != research["specification"].get("corporate_history_sha256"):
            raise ValueError("Forward corporate history is frozen")
        if journal.get("risk_policy", "legacy_cost_screen") != risk_policy or journal.get("maximum_risk_pct", 1.0) != maximum_risk_pct:
            raise ValueError("Forward risk policy is frozen; changed limits require a separate experiment")
        if journal.get("fee_profile", "upstox_delivery") != "upstox_delivery":
            raise ValueError("Forward delivery tariff is frozen")
        if journal["sessions"][-1]["date"] == day:
            status = json.loads((directory / "forward-status.json").read_text(encoding="utf-8"))
            if status.get("session_sha256") != previous_hash:
                raise ValueError("Forward status and journal disagree; review interrupted writes")
            return status
        if journal["sessions"][-1]["date"] >= day:
            raise ValueError("Forward observations must increase monotonically")
        previous = journal["sessions"][-1]["date"]
        # An unobserved trading session cannot be silently replayed from later data.
        if any(previous < d < day for d in benchmark.index):
            raise ValueError("Missed forward session; journal requires review, no historical backfill allowed")
    else:
        journal = {"experiment_id": research["experiment_id"], "start": day,
                   "corporate_history_sha256": research["specification"].get("corporate_history_sha256"),
                   "source_kind": source_kind,
                   "risk_policy": risk_policy, "maximum_risk_pct": maximum_risk_pct,
                   "fee_profile": "upstox_delivery",
                   "strategy": strategy, "capital": research["specification"]["capital_inr"],
                   "context": {s: serial_frame(f.loc[:day].tail(253)) for s, f in histories.items()}, "sessions": []}
        journal["engine_sha256"] = engine_hash
        journal["promotion_policy_sha256"] = policy_sha256()
        journal["context_sha256"] = hashlib.sha256(json.dumps(journal["context"], sort_keys=True, allow_nan=False).encode()).hexdigest()
    rows = {s: serial_frame(f.loc[[day]])[day] for s, f in histories.items()
            if day in f.index and bool(f.loc[day, "observed"])}
    session = {"date": day, "observed_at": clock.isoformat(), "source_sha256": provenance["source_sha256"],
               "previous_sha256": journal["sessions"][-1]["sha256"] if journal["sessions"] else journal["context_sha256"],
               "rows": rows}
    if corporate_receipt is not None:
        session.update(corporate_receipt_sha256=corporate_receipt["sha256"],
                       corporate_events=session_events(corporate_receipt, day))
    session["sha256"] = hashlib.sha256(json.dumps(session, sort_keys=True, allow_nan=False).encode()).hexdigest()
    journal["sessions"].append(session)
    frames = {s: dict(values) for s, values in journal["context"].items()}
    for observed in journal["sessions"]:
        for symbol, row in observed["rows"].items():
            frames.setdefault(symbol, {})[observed["date"]] = row
    frozen = {s: pd.DataFrame.from_dict(rows, orient="index").sort_index() for s, rows in frames.items()}
    result = simulate_portfolio(frozen, strategy, journal["start"], day, journal["capital"], 15,
                                enforce_economics=True, finalize=False, risk_policy=risk_policy, maximum_risk_pct=maximum_risk_pct,
                                corporate_events=[event for s in journal["sessions"] for event in s.get("corporate_events", [])] if "corporate_events" in journal["sessions"][0] else None)
    status = {**compact(result), "mode": "shadow_paper", "live_admitted": False,
              "experiment_id": journal["experiment_id"], "observed_at": clock.isoformat(),
              "session_sha256": session["sha256"], "recorded_sessions": len(journal["sessions"]),
              "promotion_policy_sha256": journal.get("promotion_policy_sha256"),
              "forward_diagnostics": admission(result),
              "signal_status": "SHADOW_ONLY", "execution_kind": "daily_bar_simulation_not_broker_fills",
              "limitations": ["Daily bars cannot prove executable fills", "Recorded data is not independent exchange verification",
                               "No live promotion; minimum forward evidence and independent review required"]}
    atomic_json(journal_path, journal)
    atomic_json(directory / "forward-status.json", status)
    return status


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--archives", type=Path, default=ROOT / "data/exchange_archive")
    args = parser.parse_args()
    print(json.dumps(record_session(args.data, args.directory, archives=args.archives), allow_nan=False))
