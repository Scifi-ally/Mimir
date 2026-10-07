from datetime import datetime, timezone, timedelta
import copy

from strategy_promotion import evaluate_forward_admission, policy_sha256

NOW = datetime(2026, 10, 4, 12, tzinfo=timezone.utc)


def evidence():
    research = {"selected_strategy": "momentum_60d", "experiment_id": "frozen"}
    forward = {"experiment_id": "frozen", "promotion_policy_sha256": policy_sha256(), "recorded_sessions": 252,
               "execution_kind": "daily_bar_simulation_not_broker_fills", "missing_held_position_sessions": 0,
               "drawdown_halted": False, "slippage_bps_per_leg": 15, "economic_cost_gate": True,
               "observed_at": NOW.isoformat(), "session_sha256": "last-session",
               "statistics": {"trades": 40, "total_return_pct": 8, "profit_factor": 1.5, "max_drawdown_pct": -4,
                              "mean_daily_return_95_block_ci_pct": [.005, .08]}}
    verification = {"session_sha256": "last-session", "verified_sessions": 252,
                    "journal_integrity_verified": True, "all_receipts_prospective": True,
                    "all_prices_exchange_verified": True, "corporate_action_accounting_verified": True,
                    "selection_precedes_forward_receipts": True, "simulation_recomputed_from_frozen_rows": True}
    return research, forward, verification


def test_complete_forward_evidence_can_admit_signals_but_never_orders():
    result = evaluate_forward_admission(*evidence(), now=NOW)
    assert result["admitted_for_signals"] is True
    assert result["failures"] == []
    assert result["live_admitted"] is False
    assert result["order_execution_authorized"] is False
    assert result["profitability_guaranteed"] is False


def test_profitable_history_or_unverified_forward_returns_cannot_admit():
    research, forward, _ = evidence()
    assert not evaluate_forward_admission(research, None, None, NOW)["admitted_for_signals"]
    assert not evaluate_forward_admission(research, forward, None, NOW)["admitted_for_signals"]


def test_each_provenance_failure_revokes_admission():
    research, forward, verification = evidence()
    for field in ("journal_integrity_verified", "all_receipts_prospective", "all_prices_exchange_verified",
                  "corporate_action_accounting_verified", "selection_precedes_forward_receipts", "simulation_recomputed_from_frozen_rows"):
        changed = {**verification, field: False}
        assert not evaluate_forward_admission(research, forward, changed, NOW)["admitted_for_signals"], field


def test_costs_drawdown_stale_and_malformed_metrics_revoke_admission():
    research, forward, verification = evidence()
    cases = [{"recorded_sessions": 251}, {"promotion_policy_sha256": "changed"}, {"missing_held_position_sessions": 1},
             {"drawdown_halted": True}, {"slippage_bps_per_leg": 5}, {"economic_cost_gate": False},
             {"observed_at": (NOW + timedelta(minutes=1)).isoformat()}, {"observed_at": (NOW - timedelta(days=5)).isoformat()}]
    for change in cases:
        assert not evaluate_forward_admission(research, {**forward, **change}, verification, NOW)["admitted_for_signals"]
    for field, value in (("trades", 29), ("total_return_pct", 0), ("profit_factor", float("nan")),
                         ("max_drawdown_pct", -9), ("mean_daily_return_95_block_ci_pct", [-.01, .1])):
        changed = copy.deepcopy(forward)
        changed["statistics"][field] = value
        assert not evaluate_forward_admission(research, changed, verification, NOW)["admitted_for_signals"]
