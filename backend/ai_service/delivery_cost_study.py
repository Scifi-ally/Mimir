"""Fixed, fully reported delivery-tariff comparison on inspected history.

No broker migration, order placement, strategy promotion or simulated source
data. A cheaper tariff is conditional on actually obtaining those account terms.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path

from corporate_history import load_frozen_corporate
from execution_economics import PROFILES
from portfolio_research import RESEARCH_STRATEGIES, load_history, engine_fingerprint
from strategy_lab import atomic_json, compact, admission, simulate_candidate


def reproduce_upstox(reference: dict, trials: list) -> list:
    errors = []
    observed = {r["strategy"]: r for r in trials if r["fee_profile"] == "upstox_delivery"}
    for old in reference["development"]:
        new = observed.get(old["strategy"])
        if new is None or (old["statistics"] is None) != (new["statistics"] is None):
            errors.append(old["strategy"] + ":statistics_availability")
            continue
        if old["statistics"] is None:
            if old.get("failure_reason") != new.get("failure_reason"):
                errors.append(old["strategy"] + ":failure_reason")
            continue
        for key in ("total_return_pct", "trades", "max_drawdown_pct", "fees_inr"):
            if not math.isclose(old["statistics"][key], new["statistics"][key], rel_tol=1e-10, abs_tol=1e-7):
                errors.append(old["strategy"] + ":" + key)
        if old["missing_held_position_sessions"] != new["missing_held_position_sessions"]:
            errors.append(old["strategy"] + ":missing_marks")
    return errors


def run_cost_study(data: Path, reference_directory: Path, directory: Path) -> dict:
    reference_path = reference_directory / "latest.json"
    reference = json.loads(reference_path.read_text(encoding="utf-8"))
    frozen = load_frozen_corporate(reference_directory, reference)
    if frozen is None or reference["specification"]["source_kind"] != "NSE_public_EOD_archives":
        raise ValueError("Frozen exchange/corporate inputs required")
    previous = reference["specification"]
    spec = {"version": 1, "study": "delivery_tariff_comparison", "reference_experiment": reference["experiment_id"],
        "reference_report_sha256": hashlib.sha256(reference_path.read_bytes()).hexdigest(),
        "source_sha256": previous["source_sha256"], "corporate_history_sha256": frozen["sha256"],
        "source_kind": previous["source_kind"], "engine_sha256": engine_fingerprint(),
        "study_code_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "capital_inr": previous["capital_inr"], "maximum_risk_pct": previous["maximum_risk_pct"],
        "risk_policy": "total_loss_budget", "slippage_bps_per_leg": 15,
        "development_start": previous["development_start"], "development_end": previous["development_end"],
        "strategies": list(RESEARCH_STRATEGIES), "fee_profiles": PROFILES,
        "trial_count": len(RESEARCH_STRATEGIES) * len(PROFILES),
        "history_already_inspected": True, "order_execution_authorized": False}
    if hashlib.sha256(data.read_bytes()).hexdigest() != spec["source_sha256"]:
        raise ValueError("Price input differs from frozen reference")
    identifier = hashlib.sha256(json.dumps(spec, sort_keys=True).encode()).hexdigest()
    directory.mkdir(parents=True, exist_ok=True)
    atomic_json(directory / (identifier + ".manifest.json"), spec)
    # Only compute causal features needed by this development-only comparison.
    histories, provenance = load_history(data, quarantine=True, corporate_events=frozen["events"], through=spec["development_end"])
    trials = []
    for profile in PROFILES:
        for strategy in RESEARCH_STRATEGIES:
            result = simulate_candidate(histories, strategy, spec["development_start"], spec["development_end"],
                spec["capital_inr"], spec["slippage_bps_per_leg"], spec["risk_policy"], spec["maximum_risk_pct"],
                frozen["events"], fee_profile=profile)
            result["development_admission_failures"] = admission(result)
            trials.append(compact(result))
            atomic_json(directory / (identifier + ".partial.json"), {"state": "incomplete", "specification": spec,
                "completed_trials": len(trials), "trials": trials, "live_admitted": False})
            print(json.dumps({"completed": len(trials), "total": spec["trial_count"], "strategy": strategy,
                "profile": profile, "return_pct": result["statistics"]["total_return_pct"] if result["statistics"] else None}, allow_nan=False), flush=True)
    errors = reproduce_upstox(reference, trials)
    report = {"experiment_id": identifier, "created_at": datetime.now(timezone.utc).isoformat(),
        "specification": spec, "provenance": provenance, "state": "complete", "trials": trials,
        "upstox_reference_reproduced": not errors, "reproduction_errors": errors,
        "selected_strategy": None, "live_admitted": False, "admitted_for_signals": False,
        "mode": "exploratory_cost_comparison", "profitability_established": False,
        "limitations": ["Inspected history is not fresh independent validation", "Conditional alternative broker tariff; account not migrated",
            "Unrounded charge estimates; actual contract-note rounding can differ", "Corporate coverage and delivery evidence remain unverified",
            "Daily bars do not establish executable fills", "No reserved-period evaluation or live promotion"]}
    atomic_json(directory / (identifier + ".json"), report)
    atomic_json(directory / "latest.json", report)
    if errors:
        raise ValueError("Reference execution results did not reproduce")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--directory", type=Path, required=True)
    args = parser.parse_args()
    report = run_cost_study(args.data, args.reference, args.directory)
    print(json.dumps({"experiment_id": report["experiment_id"], "completed_trials": len(report["trials"]),
        "upstox_reference_reproduced": report["upstox_reference_reproduced"], "live_admitted": False}))
