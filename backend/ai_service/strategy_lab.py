"""Reproducible local strategy experiments; no orders or automatic live promotion.

Every inspected evaluation is recorded. Historical results from this project's
previously inspected data are exploratory, even when returns are positive.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path

from portfolio_research import RESEARCH_STRATEGIES, load_history, simulate_portfolio, engine_fingerprint
from corporate_accounting import CorporateEvidenceError
from corporate_history import load_corporate_history


def atomic_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, allow_nan=False), encoding="utf-8")
    temporary.replace(path)


def admission(result: dict, minimum_trades=30) -> list[str]:
    stats = result["statistics"]
    if stats is None:
        return [result.get("failure_reason", "simulation_evidence_unavailable")]
    failures = []
    if result["missing_held_position_sessions"]:
        failures.append("missing_held_position_prices")
    if stats["trades"] < minimum_trades:
        failures.append("insufficient_executed_trades")
    if stats["total_return_pct"] <= 0:
        failures.append("nonpositive_net_return")
    if stats["max_drawdown_pct"] < -10:
        failures.append("drawdown_exceeds_10_percent")
    if stats["profit_factor"] is None or stats["profit_factor"] < 1.1:
        failures.append("profit_factor_below_1_1")
    interval = stats["mean_daily_return_95_block_ci_pct"]
    if interval is None or interval[0] <= 0:
        failures.append("positive_mean_not_established")
    return failures


def compact(result: dict) -> dict:
    return {k: v for k, v in result.items() if k not in ("equity", "trades")}


def simulate_candidate(histories: dict, strategy: str, start: str, end: str, capital: float,
                       slip: float, risk_policy: str, maximum_risk_pct: float, corporate_events=None, fee_profile="upstox_delivery") -> dict:
    try:
        return simulate_portfolio(histories, strategy, start, end, capital, slip, enforce_economics=True,
            risk_policy=risk_policy, maximum_risk_pct=maximum_risk_pct, corporate_events=corporate_events, fee_profile=fee_profile)
    except CorporateEvidenceError:
        return {"strategy": strategy, "statistics": None, "slippage_bps_per_leg": slip, "fee_profile": fee_profile,
                "failure_reason": "corporate_action_or_share_delivery_evidence_unverified",
                "valuation_status": "invalid_corporate_accounting", "missing_held_position_sessions": None,
                "drawdown_halted": None, "economic_cost_gate": True}


def run_experiment(data: Path, directory: Path, capital: float, risk_policy="legacy_cost_screen", maximum_risk_pct=1.0,
                   corporate_directory=None) -> dict:
    if not math.isfinite(capital) or capital <= 0:
        raise ValueError("Positive finite capital required")
    histories, provenance = load_history(data, quarantine=True)
    corporate = None
    if corporate_directory is not None:
        if provenance["source_kind"] != "NSE_public_EOD_archives":
            raise ValueError("Raw exchange prices required for corporate-action research")
        corporate = load_corporate_history(corporate_directory, histories["NIFTY"].index[0], histories["NIFTY"].index[-1],
            corporate_directory.parent if corporate_directory.name == "historical_corporate" else None)
        histories, provenance = load_history(data, quarantine=True, corporate_events=corporate["events"])
    dates = list(histories["NIFTY"].index[253:])
    if len(dates) < 504:
        raise ValueError("Two years of sessions after twelve-month warmup required")
    split = int(len(dates) * .7)
    # Long strategies may hold 126 sessions: purge that entire horizon.
    development_end, evaluation_start = dates[split - 127], dates[split]
    specification = {"version": 1, "source_sha256": provenance["source_sha256"],
        "corporate_history_sha256": corporate["sha256"] if corporate else None,
        "source_kind": provenance["source_kind"], "price_basis": provenance["price_basis"],
        "source_provenance_sha256": provenance["source_provenance_sha256"],
        "calendar_sha256": provenance["calendar_sha256"],
        "engine_sha256": engine_fingerprint(),
        "lab_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "strategies": list(RESEARCH_STRATEGIES), "capital_inr": capital,
        "risk_policy": risk_policy, "maximum_risk_pct": maximum_risk_pct,
        "development_start": dates[0], "development_end": development_end,
        "embargo_sessions": 126, "evaluation_start": evaluation_start, "evaluation_end": dates[-1],
        "selection": "positive net stressed development return, >=30 trades, <=10% drawdown, no stale marks; rank return/drawdown",
        "evaluation_slippage_bps": [5, 15], "forward_required": True}
    experiment_id = hashlib.sha256(json.dumps(specification, sort_keys=True).encode()).hexdigest()
    directory.mkdir(parents=True, exist_ok=True)
    journal_path = directory / "forward-journal.json"
    if journal_path.exists() and json.loads(journal_path.read_text(encoding="utf-8"))["experiment_id"] != experiment_id:
        raise ValueError("An active forward experiment is frozen; use a separate directory for new research")
    output = directory / (experiment_id + ".json")
    if output.exists():
        existing = json.loads(output.read_text(encoding="utf-8"))
        atomic_json(directory / "latest.json", existing)
        return existing
    # The frozen manifest exists BEFORE any candidate is simulated.
    atomic_json(directory / (experiment_id + ".manifest.json"), specification)
    if corporate:
        atomic_json(directory / (experiment_id + ".corporate.json"), corporate)
    development = [simulate_candidate(histories, s, dates[0], development_end, capital, 15,
                   risk_policy, maximum_risk_pct, corporate["events"] if corporate else None)
                   for s in RESEARCH_STRATEGIES]
    eligible = [r for r in development if r["statistics"] is not None and not r["drawdown_halted"] and r["missing_held_position_sessions"] == 0
                and r["statistics"]["trades"] >= 30 and r["statistics"]["total_return_pct"] > 0
                and r["statistics"]["max_drawdown_pct"] >= -10]
    winner = max(eligible, key=lambda r: r["statistics"]["total_return_pct"] /
                 max(abs(r["statistics"]["max_drawdown_pct"]), 1))["strategy"] if eligible else None
    evaluations = [simulate_candidate(histories, winner, evaluation_start, dates[-1], capital, slip,
                   risk_policy, maximum_risk_pct, corporate["events"] if corporate else None)
                   for slip in (5, 15)] if winner else []
    failure = ["historical_universe_not_point_in_time_verified", "corporate_actions_not_verified",
               "previously_inspected_history_requires_new_forward_evidence"]
    if not winner:
        failure.append("no_development_candidate_passed")
    for result in evaluations:
        failure.extend(f"slippage_{result['slippage_bps_per_leg']}:{f}" for f in admission(result))
    report = {"experiment_id": experiment_id, "created_at": datetime.now(timezone.utc).isoformat(),
        "specification": specification, "provenance": provenance, "selected_strategy": winner,
        "corporate_history": {k: v for k, v in corporate.items() if k != "events"} if corporate else None,
        "mode": "research_only", "live_admitted": False, "admission_failures": failure,
        "development": [compact(r) for r in development], "evaluation": evaluations,
        "evaluations_are_exploratory": True,
        "cost_scope": "brokerage, delivery STT, exchange, SEBI, IPFT, GST, buy stamp, sell DP, adverse slippage; excludes personal income tax",
        "signal_status": "ABSTAIN"}
    atomic_json(output, report)
    atomic_json(directory / "latest.json", report)
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--directory", type=Path, default=Path("backend/data/strategy_lab"))
    parser.add_argument("--capital", type=float, default=10_000)
    parser.add_argument("--risk-policy", choices=("legacy_cost_screen", "total_loss_budget"), default="legacy_cost_screen")
    parser.add_argument("--maximum-risk-pct", type=float, default=1.0)
    parser.add_argument("--corporate-archives", type=Path)
    args = parser.parse_args()
    result = run_experiment(args.data, args.directory, args.capital, args.risk_policy, args.maximum_risk_pct, args.corporate_archives)
    print(json.dumps({"experiment_id": result["experiment_id"], "selected_strategy": result["selected_strategy"],
        "live_admitted": result["live_admitted"], "development": [{"strategy": r["strategy"],
        "return_pct": r["statistics"]["total_return_pct"] if r["statistics"] else None, "trades": r["statistics"]["trades"] if r["statistics"] else None,
        "missing_marks": r["missing_held_position_sessions"]} for r in result["development"]],
        "evaluation": [compact(r) for r in result["evaluation"]]}, allow_nan=False))
