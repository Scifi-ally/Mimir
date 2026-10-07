"""Admission for evidence-backed signal publication, never authority to place orders.

The criteria must be frozen before the forward cohort starts. Historical returns
alone cannot satisfy this gate. Missing or malformed evidence fails closed.
"""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import math
from pathlib import Path

POLICY = {"version": 1, "minimum_forward_sessions": 252, "minimum_closed_trades": 30,
          "minimum_profit_factor": 1.1, "maximum_drawdown_pct": 8,
          "minimum_slippage_bps_per_leg": 15, "maximum_receipt_age_hours": 96,
          "require_independent_price_verification": True, "require_corporate_action_accounting": True,
          "order_execution_authorized": False}


def policy_sha256() -> str:
    return hashlib.sha256(Path(__file__).read_bytes()).hexdigest()


def finite(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def timestamp(value) -> datetime | None:
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return result.astimezone(timezone.utc) if result.tzinfo else None
    except (AttributeError, TypeError, ValueError):
        return None


def evaluate_forward_admission(research: dict, forward: dict | None, verification: dict | None, now=None) -> dict:
    clock = now or datetime.now(timezone.utc)
    failures = []
    if not research.get("selected_strategy"):
        failures.append("no_frozen_strategy_selected")
    if not forward:
        failures.append("no_forward_portfolio")
    else:
        if forward.get("experiment_id") != research.get("experiment_id"):
            failures.append("experiment_identity_mismatch")
        if forward.get("promotion_policy_sha256") != policy_sha256():
            failures.append("admission_rules_not_frozen_for_cohort")
        sessions = forward.get("recorded_sessions")
        if not finite(sessions) or sessions < POLICY["minimum_forward_sessions"]:
            failures.append("insufficient_forward_sessions")
        if forward.get("execution_kind") != "daily_bar_simulation_not_broker_fills":
            failures.append("unrecognized_execution_evidence")
        if not finite(forward.get("missing_held_position_sessions")) or forward["missing_held_position_sessions"] != 0:
            failures.append("missing_held_position_prices")
        if forward.get("drawdown_halted") is not False:
            failures.append("portfolio_drawdown_halted_or_unknown")
        slip = forward.get("slippage_bps_per_leg")
        if not finite(slip) or slip < POLICY["minimum_slippage_bps_per_leg"]:
            failures.append("insufficient_cost_stress")
        if forward.get("economic_cost_gate") is not True:
            failures.append("economic_cost_filter_missing")
        stats = forward.get("statistics") or {}
        checks = [("trades", lambda x: x >= POLICY["minimum_closed_trades"], "insufficient_closed_trades"),
                  ("total_return_pct", lambda x: x > 0, "nonpositive_net_return"),
                  ("profit_factor", lambda x: x >= POLICY["minimum_profit_factor"], "insufficient_profit_factor"),
                  ("max_drawdown_pct", lambda x: x >= -POLICY["maximum_drawdown_pct"], "excessive_drawdown")]
        for field, check, reason in checks:
            value = stats.get(field)
            if not finite(value) or not check(value):
                failures.append(reason)
        interval = stats.get("mean_daily_return_95_block_ci_pct")
        if not isinstance(interval, list) or len(interval) != 2 or not all(finite(v) for v in interval) or not 0 < interval[0] <= interval[1]:
            failures.append("positive_net_mean_not_established")
        received = timestamp(forward.get("observed_at"))
        if received is None or not 0 <= (clock - received).total_seconds() <= POLICY["maximum_receipt_age_hours"] * 3600:
            failures.append("forward_evidence_stale_or_future")
    if not verification:
        failures.append("no_independent_forward_verification")
    else:
        if verification.get("session_sha256") != (forward or {}).get("session_sha256"):
            failures.append("verification_identity_mismatch")
        for field, reason in (("journal_integrity_verified", "forward_journal_not_verified"),
                              ("all_receipts_prospective", "historical_backfill_or_late_receipts"),
                              ("all_prices_exchange_verified", "prices_not_independently_verified"),
                              ("corporate_action_accounting_verified", "corporate_action_accounting_not_verified"),
                              ("selection_precedes_forward_receipts", "retrospective_strategy_selection")):
            if verification.get(field) is not True:
                failures.append(reason)
        if verification.get("verified_sessions") != (forward or {}).get("recorded_sessions"):
            failures.append("incomplete_independent_session_coverage")
        if verification.get("simulation_recomputed_from_frozen_rows") is not True:
            failures.append("reported_returns_not_recomputed")
    return {"policy": POLICY, "policy_sha256": policy_sha256(), "experiment_id": research.get("experiment_id"),
            "evaluated_at": clock.isoformat(), "admitted_for_signals": not failures,
            "order_execution_authorized": False, "live_admitted": False,
            "state": "SIGNAL_ADMITTED" if not failures else "ABSTAIN",
            "failures": list(dict.fromkeys(failures)),
            "evidence_kind": "prospective_shadow_portfolio_not_broker_fills",
            "profitability_guaranteed": False}
