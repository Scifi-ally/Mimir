"""Derive admission evidence from local immutable receipts; never trust API claims.

Raw exchange prices are compared without translating adjusted vendor prices.
Corporate actions are explicitly unverified until an accounting ledger exists.
No broker operations and no fabricated forward sessions.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path

import pandas as pd

from nse_archive import load_session, session_date
from portfolio_research import simulate_portfolio, engine_fingerprint
from strategy_lab import atomic_json, compact
from strategy_promotion import evaluate_forward_admission, timestamp
from corporate_accounting import decode_action
from nse_corporate_archive import load_corporate_receipt, session_events
from corporate_history import load_frozen_corporate


def digest(value: dict) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, allow_nan=False).encode()).hexdigest()


def prices_match(row: dict, values: list) -> bool:
    try:
        actual = [row[k] for k in ("open", "high", "low", "close", "volume")]
        return all(not isinstance(a, bool) and math.isfinite(float(a)) and
                   math.isclose(float(a), float(b), rel_tol=1e-7, abs_tol=1e-4 if i < 4 else 0)
                   for i, (a, b) in enumerate(zip(actual, values)))
    except (KeyError, TypeError, ValueError):
        return False


def verify_forward(directory: Path, archives: Path, now=None) -> dict:
    clock = now or datetime.now(timezone.utc)
    research = json.loads((directory / "latest.json").read_text(encoding="utf-8"))
    forward_path = directory / "forward-status.json"
    forward = json.loads(forward_path.read_text(encoding="utf-8")) if forward_path.exists() else None
    evidence = {"session_sha256": (forward or {}).get("session_sha256"), "verified_sessions": 0,
                "journal_integrity_verified": False, "all_receipts_prospective": False,
                "all_prices_exchange_verified": False, "corporate_action_accounting_verified": False,
                "selection_precedes_forward_receipts": False, "simulation_recomputed_from_frozen_rows": False,
                "checked_at": clock.isoformat(), "session_checks": [],
                "limitations": ["Corporate coverage, delivery timing and indicator adjustments not fully verified; admission remains withheld",
                                "Price verification does not establish executable broker fills",
                                "Warmup indicators are frozen research inputs, not independently certified"]}
    journal_path = directory / "forward-journal.json"
    if journal_path.exists():
        try:
            journal = json.loads(journal_path.read_text(encoding="utf-8"))
            load_frozen_corporate(directory, research)
            sessions = journal["sessions"]
            engine = engine_fingerprint()
            previous = digest(journal["context"])
            valid = bool(sessions) and previous == journal["context_sha256"]
            valid &= journal["experiment_id"] == research["experiment_id"]
            valid &= journal["strategy"] == research["selected_strategy"]
            valid &= journal["capital"] == research["specification"]["capital_inr"]
            valid &= journal.get("source_kind", "recorded_vendor_candles") == research["specification"].get("source_kind", "recorded_vendor_candles")
            valid &= journal.get("corporate_history_sha256") == research["specification"].get("corporate_history_sha256")
            valid &= journal.get("risk_policy", "legacy_cost_screen") == research["specification"].get("risk_policy", "legacy_cost_screen")
            valid &= journal.get("fee_profile", "upstox_delivery") == research["specification"].get("fee_profile", "upstox_delivery") == "upstox_delivery"
            valid &= research.get("mode") != "exploratory_cost_comparison"
            valid &= journal.get("maximum_risk_pct", 1.0) == research["specification"].get("maximum_risk_pct", 1.0)
            valid &= journal["engine_sha256"] == engine == research["specification"]["engine_sha256"]
            valid &= journal.get("promotion_policy_sha256") == (forward or {}).get("promotion_policy_sha256")
            last_day = None
            prospective, selected_first, exchange_match = True, True, True
            selected_at = timestamp(research.get("created_at"))
            for session in sessions:
                day = session_date(session["date"])
                session_hash = digest({k: v for k, v in session.items() if k != "sha256"})
                valid &= session_hash == session["sha256"] and session["previous_sha256"] == previous
                valid &= last_day is None or day > last_day
                previous, last_day = session_hash, day
                received = timestamp(session.get("observed_at"))
                local = received.astimezone(pd.Timestamp("now", tz="Asia/Kolkata").tzinfo) if received else None
                on_time = local is not None and local.date() == day and (local.hour, local.minute) >= (15, 30) and received <= clock
                prospective &= on_time
                if "corporate_receipt_sha256" in session:
                    corporate_receipt = load_corporate_receipt(archives, session["corporate_receipt_sha256"])
                    corporate_received = timestamp(corporate_receipt["observed_at"])
                    opening = timestamp(day.isoformat() + "T09:15:00+05:30")
                    valid &= corporate_received is not None and 0 <= (opening - corporate_received).total_seconds() <= 96 * 3600
                    valid &= corporate_receipt["from"] <= day.isoformat() <= corporate_receipt["to"]
                    valid &= session.get("corporate_events") == session_events(corporate_receipt, day.isoformat())
                selected_first &= selected_at is not None and received is not None and selected_at <= received
                check = {"date": day.isoformat(), "exchange_verified": False, "mismatched_symbols": [], "receipt_prospective": False}
                try:
                    source = load_session(archives, day)
                    source_time = timestamp(source.get("observed_at"))
                    source_local = source_time.astimezone(local.tzinfo) if source_time and local else None
                    check["receipt_prospective"] = source.get("historical_backfill") is False and source_local is not None and source_local.date() == day and (source_local.hour, source_local.minute) >= (15, 30) and source_time <= clock
                    prospective &= check["receipt_prospective"]
                    selected_first &= selected_at is not None and source_time is not None and selected_at <= source_time
                    for symbol, row in session["rows"].items():
                        expected = source["benchmark"]["ohlcv"] if symbol == "NIFTY" else source["equities"].get(symbol.split("|")[-1], {}).get("ohlcv")
                        if expected is None or not prices_match(row, expected):
                            check["mismatched_symbols"].append(symbol)
                    check["exchange_verified"] = "NIFTY" in session["rows"] and not check["mismatched_symbols"]
                    check["exchange_sha256"] = source["sha256"]
                except (OSError, ValueError, KeyError):
                    check["error"] = "independent_exchange_receipt_missing_or_invalid"
                    prospective = False
                exchange_match &= check["exchange_verified"]
                evidence["verified_sessions"] += int(check["exchange_verified"])
                evidence["session_checks"].append(check)
            valid &= previous == (forward or {}).get("session_sha256") and len(sessions) == (forward or {}).get("recorded_sessions")
            valid &= journal["start"] == sessions[0]["date"]
            evidence.update(journal_integrity_verified=bool(valid), all_receipts_prospective=bool(prospective),
                            selection_precedes_forward_receipts=bool(selected_first), all_prices_exchange_verified=bool(exchange_match))
            if valid:
                frames = {s: dict(rows) for s, rows in journal["context"].items()}
                for session in sessions:
                    for symbol, row in session["rows"].items():
                        frames.setdefault(symbol, {})[session["date"]] = row
                frozen = {s: pd.DataFrame.from_dict(rows, orient="index").sort_index() for s, rows in frames.items()}
                replay = simulate_portfolio(frozen, journal["strategy"], journal["start"], sessions[-1]["date"], journal["capital"], 15, enforce_economics=True, finalize=False,
                    risk_policy=journal.get("risk_policy", "legacy_cost_screen"), maximum_risk_pct=journal.get("maximum_risk_pct", 1.0),
                    corporate_events=[event for s in sessions for event in s.get("corporate_events", [])] if "corporate_events" in sessions[0] else None)
                result = compact(replay)
                corporate_path = archives / "corporate-status.json"
                if corporate_path.exists():
                    corporate = json.loads(corporate_path.read_text(encoding="utf-8"))
                    exposure = []
                    holdings = replay["trades"] + [{**p, "symbol": s, "exit_date": sessions[-1]["date"]} for s, p in replay["open_positions"].items()]
                    for action in corporate.get("events") or []:
                        for holding in holdings:
                            if holding["symbol"].split("|")[-1] == action["isin"] and holding["entry_date"] < action["ex_date"] <= holding["exit_date"]:
                                exposure.append({"isin": action["isin"], "ex_date": action["ex_date"], "purpose": action["purpose"],
                                                 "terms": decode_action(action["purpose"]), "accounting_applied_to_simulation": False})
                    evidence["corporate_exposure_diagnostics"] = {"source_available": corporate.get("available") is True,
                        "coverage_from": corporate.get("from"), "coverage_to": corporate.get("to"),
                        "exposures": exposure, "receipt_hash": corporate.get("sha256"),
                        "complete_forward_coverage_verified": False}
                # The recorder supplies its own explanatory limitations; financial
                # values and portfolio state must agree with a fresh replay.
                evidence["simulation_recomputed_from_frozen_rows"] = all((forward or {}).get(k) == v for k, v in result.items() if k != "limitations")
        except (OSError, ValueError, KeyError, TypeError, IndexError):
            evidence["error"] = "journal_or_simulation_invalid"
    else:
        evidence["error"] = "no_forward_journal"
    promotion = evaluate_forward_admission(research, forward, evidence, clock)
    result = {"verification": evidence, "admission": promotion}
    atomic_json(directory / "admission-status.json", result)
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--archives", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(verify_forward(args.directory, args.archives), allow_nan=False))
