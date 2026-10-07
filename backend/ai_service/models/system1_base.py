"""
Unified System-1 Decision Base Primitives.
─────────────────────────────────────────────────────────────────────────────
Defines canonical Choice, Score, and Noul primitives shared across
LAYA (Convai Innovations, open-weight ModernBERT RLCD). The former "jev"
(TypeSafe AI) was a managed cloud API and has been retired - see
system1_service.py.
Provides single, lean, deterministic RLCD-calibrated surrogate and hard circuit breakers.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class System1Decision:
    """
    Standardized System-1 decision output structure.

    Primitives:
    - Choice: verdict ("APPROVE" | "REJECT" | "CAUTION"), action ("EXECUTE_IMMEDIATELY" | "CONFIRMED_ENTRY" | "LIMIT_PULLBACK" | "CANCEL")
    - Score: confidence (0.0 to 1.0), opportunity_score (0.0 to 100.0), regime_alignment (-1.0 to 1.0)
    - Noul: p_execution_success (0.0 to 1.0), p_stop_hunt_risk (0.0 to 1.0), p_adverse_regime_shift (0.0 to 1.0)
    """
    verdict: str  # "APPROVE" | "REJECT" | "CAUTION"
    action: str  # "EXECUTE_IMMEDIATELY" | "CONFIRMED_ENTRY" | "LIMIT_PULLBACK" | "CANCEL"
    confidence: float  # 0.0 - 1.0 (RLCD calibrated)
    opportunity_score: float  # 0.0 - 100.0
    gate_reasons: List[str] = field(default_factory=list)
    regime_alignment: float = 0.0  # -1.0 to +1.0
    p_execution_success: float = 0.5  # Noul: P(fill without adverse selection)
    p_stop_hunt_risk: float = 0.2  # Noul: P(wick-triggered stop out)
    p_adverse_regime_shift: float = 0.2  # Noul: P(regime breakdown against setup)
    provider: str = "laya"  # "laya" | "risk_gate" | "local_surrogate"
    model_id: str = "convaiinnovations/laya"
    source: str = "local_surrogate"
    latency_ms: float = 0.0
    position_size_multiplier: float = 1.0  # Dynamic position sizing scaling (0.5x - 1.25x)

    def to_dict(self) -> Dict[str, Any]:
        result = asdict(self)
        # Handwritten sigmoid outputs and general-purpose model confidence have
        # no Indian-market execution calibration. Keep private rule diagnostics
        # private; publish unknown probabilities rather than invented odds.
        for key in ("p_execution_success", "p_stop_hunt_risk", "p_adverse_regime_shift"):
            result[key] = None
        result["probability_validation"] = "not_established"
        result["confidence_kind"] = "decision_score_not_win_probability"
        result["position_size_multiplier"] = min(1.0, max(0.0, self.position_size_multiplier))
        return result


def get_safe_float(state: Dict[str, Any], keys: List[str], default: float) -> float:
    for k in keys:
        val = state.get(k)
        if val is not None:
            try:
                f = float(val)
                if not math.isnan(f) and not math.isinf(f):
                    return f
            except (ValueError, TypeError):
                pass
    return default


def get_safe_str(state: Dict[str, Any], keys: List[str], default: str) -> str:
    for k in keys:
        val = state.get(k)
        if val is not None and str(val).strip():
            return str(val).strip()
    return default


def resolve_risk_reward(state: Dict[str, Any], default: float = 1.5) -> float:
    """
    Return risk-reward as a true R multiple (e.g. 2.0), never as a 0-100 score.

    `riskRewardScore` is NORMALIZED to 0-100 where 3.0 == 100 (see
    `computeRiskRewardScore` in backend/src/analysis/feature_engine.ts).
    Treating it as an R multiple is a units error with severe consequences: a
    setup whose real R:R is 0.3 (risking 3x more than it can win) reports
    riskRewardScore = 10, which read as `rr = 10` sails past the `rr < 1.2`
    hard gate, contributes (10/3)*20 = 66.7 opportunity points, and is scored
    as opportunity 100 / APPROVE / 1.25x — the maximum possible position size
    for the worst possible setup. De-normalize instead.
    """
    for key in ("risk_reward_ratio", "riskReward", "rr", "riskRewardRatio"):
        raw = state.get(key)
        if raw is None:
            continue
        try:
            f = float(raw)
        except (TypeError, ValueError):
            continue
        if math.isfinite(f) and f > 0.0:
            return f

    # Only the normalized 0-100 score is available: convert it back to an R
    # multiple (score 100 -> 3.0) rather than reading it as an R multiple.
    raw = state.get("riskRewardScore")
    if raw is not None:
        try:
            s = float(raw)
        except (TypeError, ValueError):
            s = float("nan")
        if math.isfinite(s) and 0.0 < s <= 100.0:
            return (s / 100.0) * 3.0

    return default


def _compute_calibrated_noul(
    direction: str,
    setup_type: str,
    rr: float,
    ofi: float,
    vix: float,
    regime: str,
    regime_alignment: float,
    chronos_trend: str,
) -> tuple[float, float, float]:
    """Compute RLCD-calibrated Bernoulli probabilities (p_exec, p_hunt, p_shift)."""
    ofi_confluence = 0.0
    if (direction == "BUY" and ofi > 0.1) or (direction == "SELL" and ofi < -0.1):
        ofi_confluence = 0.5
    elif (direction == "BUY" and ofi < -0.1) or (direction == "SELL" and ofi > 0.1):
        ofi_confluence = -0.5
    z_exec = 0.5 + ofi_confluence + 0.4 * regime_alignment - 0.05 * max(0.0, vix - 16.0)

    z_hunt = -1.2 + 0.1 * max(0.0, vix - 15.0) - (0.3 if rr >= 2.0 else -0.3)
    if "BREAKOUT" in setup_type and ("SIDEWAYS" in regime or "VOLATILE" in regime):
        z_hunt += 0.5

    z_shift = -1.5 + (0.8 if regime_alignment < 0 else 0.0) + 0.08 * max(0.0, vix - 18.0)
    if (direction == "BUY" and chronos_trend == "bearish") or (direction == "SELL" and chronos_trend == "bullish"):
        z_shift += 0.5

    def _sigmoid(z: float) -> float:
        return round(1.0 / (1.0 + math.exp(-max(-10.0, min(10.0, z)))), 4)

    return _sigmoid(z_exec), _sigmoid(z_hunt), _sigmoid(z_shift)


def check_hard_risk_gates(
    state: Dict[str, Any],
    provider: str = "laya",
    model_id: str = "convaiinnovations/laya",
    source: str = "local_surrogate",
) -> Optional[System1Decision]:
    """
    Sub-millisecond quantitative hard circuit breakers.
    Enforces institutional risk constraints before neural forward pass.
    """
    direction = get_safe_str(state, ["direction"], "BUY").upper()
    rr = resolve_risk_reward(state, default=1.5)
    ofi = get_safe_float(state, ["order_flow_imbalance_ratio", "ofi_ratio", "bidAskImbalance"], 0.0)
    fii_net = get_safe_float(state, ["fii_dii_net", "fiiNet", "fiiDiiNetFlowLag"], 0.0)
    vix = get_safe_float(state, ["india_vix", "vix"], 15.0)
    regime = get_safe_str(state, ["market_regime", "regime"], "UNKNOWN").upper()
    setup_type = get_safe_str(state, ["setup_type", "setupType"], "PULLBACK").upper()
    chronos_trend = get_safe_str(state, ["chronos_trend", "trend"], "neutral").lower()

    win_prob_raw = state.get("win_probability", state.get("winProb"))
    win_prob = None
    if win_prob_raw is not None:
        try:
            wp = float(win_prob_raw)
            if not math.isnan(wp) and not math.isinf(wp):
                win_prob = wp
        except (ValueError, TypeError):
            win_prob = None

    regime_alignment = 0.0
    if "BULL" in regime:
        regime_alignment = 0.8 if direction == "BUY" else -0.8
    elif "BEAR" in regime:
        regime_alignment = -0.8 if direction == "BUY" else 0.8
    elif "SIDEWAYS" in regime or "RANGE" in regime:
        regime_alignment = 0.2 if ("PULLBACK" in setup_type or "REVERSION" in setup_type) else -0.1
    elif "VOLATILE" in regime:
        regime_alignment = -0.5

    gate_reasons: List[str] = []
    hard_reject = False

    # Extreme VIX
    if vix > 25.0:
        hard_reject = True
        gate_reasons.append("HIGH_VOLATILITY_VIX_SPIKE")
    elif vix > 20.0 and regime_alignment < 0:
        hard_reject = True
        gate_reasons.append("ELEVATED_VIX_COUNTER_REGIME")

    # Insufficient Risk-Reward
    if rr < 1.2:
        hard_reject = True
        gate_reasons.append(f"UNFAVORABLE_RISK_REWARD_{rr:.2f}")

    # Heavy Institutional Counter-Flow
    if direction == "BUY" and fii_net < -2500.0:
        hard_reject = True
        gate_reasons.append("HEAVY_INSTITUTIONAL_SELLING")
    elif direction == "SELL" and fii_net > 2500.0:
        hard_reject = True
        gate_reasons.append("HEAVY_INSTITUTIONAL_BUYING")

    # Learned Ranker win probability gate (if present)
    if win_prob is not None and win_prob < 0.45:
        hard_reject = True
        gate_reasons.append(f"LOW_RANKER_WIN_PROB_{win_prob:.2f}")

    # Severe Order Flow Contradiction
    if (direction == "BUY" and ofi < -0.35) or (direction == "SELL" and ofi > 0.35):
        hard_reject = True
        gate_reasons.append("SEVERE_ORDER_FLOW_CONTRADICTION")

    if hard_reject:
        p_exec, p_hunt, p_shift = _compute_calibrated_noul(
            direction, setup_type, rr, ofi, vix, regime, regime_alignment, chronos_trend
        )
        return System1Decision(
            verdict="REJECT",
            action="CANCEL",
            confidence=0.88,
            opportunity_score=15.0,
            gate_reasons=gate_reasons,
            regime_alignment=round(regime_alignment, 2),
            p_execution_success=round(min(0.20, p_exec * 0.3), 4),
            p_stop_hunt_risk=round(max(0.75, p_hunt), 4),
            p_adverse_regime_shift=round(max(0.70, p_shift), 4),
            provider=provider,
            model_id=model_id,
            source=source,
            position_size_multiplier=0.0,
        )
    return None


def evaluate_deterministic_system1(
    state: Dict[str, Any],
    provider: str = "laya",
    model_id: str = "convaiinnovations/laya",
    source: str = "local_surrogate",
    check_gates: bool = True,
) -> System1Decision:
    """
    Deterministic, RLCD-calibrated System-1 decision function.
    Simulates System-1 non-autoregressive decision boundary and strictly proper
    scoring rules over market microstructure, risk-reward, trend, and institutional flow.
    """
    if check_gates:
        hard_rejection = check_hard_risk_gates(state, provider=provider, model_id=model_id, source=source)
        if hard_rejection is not None:
            return hard_rejection

    direction = get_safe_str(state, ["direction"], "BUY").upper()
    setup_type = get_safe_str(state, ["setup_type", "setupType"], "PULLBACK").upper()
    tech_score = get_safe_float(state, ["technical_score", "technicalScore"], 50.0)
    rr = resolve_risk_reward(state, default=1.5)
    ofi = get_safe_float(state, ["order_flow_imbalance_ratio", "ofi_ratio", "bidAskImbalance"], 0.0)
    fii_net = get_safe_float(state, ["fii_dii_net", "fiiNet", "fiiDiiNetFlowLag"], 0.0)
    vix = get_safe_float(state, ["india_vix", "vix"], 15.0)
    regime = get_safe_str(state, ["market_regime", "regime"], "UNKNOWN").upper()
    sentiment = get_safe_float(state, ["sentiment_score", "sentiment"], 0.0)
    chronos_trend = get_safe_str(state, ["chronos_trend", "trend"], "neutral").lower()

    win_prob_raw = state.get("win_probability", state.get("winProb"))
    win_prob = None
    if win_prob_raw is not None:
        try:
            wp = float(win_prob_raw)
            if not math.isnan(wp) and not math.isinf(wp):
                win_prob = wp
        except (ValueError, TypeError):
            win_prob = None

    regime_alignment = 0.0
    if "BULL" in regime:
        regime_alignment = 0.8 if direction == "BUY" else -0.8
    elif "BEAR" in regime:
        regime_alignment = -0.8 if direction == "BUY" else 0.8
    elif "SIDEWAYS" in regime or "RANGE" in regime:
        regime_alignment = 0.2 if ("PULLBACK" in setup_type or "REVERSION" in setup_type) else -0.1
    elif "VOLATILE" in regime:
        regime_alignment = -0.5

    gate_reasons: List[str] = []

    p_exec, p_hunt, p_shift = _compute_calibrated_noul(
        direction, setup_type, rr, ofi, vix, regime, regime_alignment, chronos_trend
    )

    # Opportunity scoring
    base_opp = tech_score * 0.45 + (rr / 3.0) * 20.0 + (regime_alignment + 1.0) * 15.0
    if (direction == "BUY" and ofi > 0.2) or (direction == "SELL" and ofi < -0.2):
        base_opp += 10.0
        gate_reasons.append("POSITIVE_ORDER_FLOW_CONFLUENCE")
    if (direction == "BUY" and chronos_trend == "bullish") or (
        direction == "SELL" and chronos_trend == "bearish"
    ):
        base_opp += 10.0
        gate_reasons.append("CHRONOS_DIRECTIONAL_ALIGNMENT")
    if (sentiment > 0.2 and direction == "BUY") or (sentiment < -0.2 and direction == "SELL"):
        base_opp += 5.0
    if win_prob is not None and win_prob >= 0.65:
        base_opp += 5.0
        gate_reasons.append("RANKER_CONVICTION_ALIGNMENT")

    opportunity_score = max(0.0, min(100.0, round(base_opp, 1)))

    is_pullback = "PULLBACK" in setup_type or "REVERSION" in setup_type
    if opportunity_score >= 70.0 and regime_alignment >= 0.0:
        verdict = "APPROVE"
        if p_hunt > 0.35 and not is_pullback:
            action = "LIMIT_PULLBACK"
            gate_reasons.append("PULLBACK_ENTRY_PREFERRED")
        else:
            action = "EXECUTE_IMMEDIATELY"
            gate_reasons.append("STRONG_SYSTEM_ONE_CONVICTION")
        confidence = min(0.95, 0.65 + (opportunity_score - 70.0) * 0.01)
        if confidence >= 0.80 and p_hunt <= 0.20 and (
            (direction == "BUY" and ofi > 0.1) or (direction == "SELL" and ofi < -0.1)
        ):
            size_multiplier = 1.25
            gate_reasons.append("POSITION_SIZE_SCALED_UP_1.25X")
        else:
            size_multiplier = 1.0
    elif opportunity_score >= 50.0:
        verdict = "CAUTION"
        action = "LIMIT_PULLBACK" if rr >= 1.5 else "CONFIRMED_ENTRY"
        confidence = 0.60
        size_multiplier = 0.65
        gate_reasons.append("MODERATE_OPPORTUNITY_REQUIRE_CONFIRMATION")
    else:
        verdict = "REJECT"
        action = "CANCEL"
        confidence = 0.75
        size_multiplier = 0.0
        gate_reasons.append("LOW_OPPORTUNITY_SCORE")

    return System1Decision(
        verdict=verdict,
        action=action,
        confidence=round(confidence, 2),
        opportunity_score=opportunity_score,
        gate_reasons=gate_reasons,
        regime_alignment=round(regime_alignment, 2),
        p_execution_success=p_exec,
        p_stop_hunt_risk=p_hunt,
        p_adverse_regime_shift=p_shift,
        provider=provider,
        model_id=model_id,
        source=source,
        position_size_multiplier=size_multiplier,
    )
