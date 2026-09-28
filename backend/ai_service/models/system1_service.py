"""
Unified System-1 Fast Decision Router.
─────────────────────────────────────────────────────────────────────────────
Seamlessly routes System-1 triage between:
1. LAYA (Convai Innovations, open-weight ModernBERT RLCD, local on-prem)
2. JEV (TypeSafe AI, managed cloud API)
3. Local deterministic surrogate (zero-dependency offline safety net)
"""

from __future__ import annotations

import logging
import os
import threading
from typing import Any, Dict, List, Optional

from .jev_service import jev_service
from .laya_service import laya_service
from .system1_base import System1Decision

logger = logging.getLogger("ai_service.system1")


class System1Service:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._default_engine: str = os.getenv("SYSTEM1_ENGINE", "laya").lower()
        self._enabled: bool = os.getenv("SYSTEM1_ENABLED", "true").lower() in ("true", "1", "yes")

    def reload_config(self) -> None:
        with self._lock:
            self._default_engine = os.getenv("SYSTEM1_ENGINE", "laya").lower()
            self._enabled = os.getenv("SYSTEM1_ENABLED", "true").lower() in ("true", "1", "yes")
        laya_service.reload_config()
        jev_service.reload_config()

    def get_status(self) -> Dict[str, Any]:
        with self._lock:
            default_engine = self._default_engine
            enabled = self._enabled

        laya_status = laya_service.get_status()
        jev_status = jev_service.get_status()

        # An open Jev breaker degrades the cloud tier but does not make System-1
        # unhealthy: tiers 1/3/4 (local Laya, Python surrogate, native TS
        # surrogate) still answer. Report the cloud state separately instead of
        # folding it into a misleading top-level healthy=false.
        jev_breaker_open = jev_status.get("circuit_state") == "open"
        return {
            "default_engine": default_engine,
            "enabled": enabled,
            "laya": laya_status,
            "jev": jev_status,
            "healthy": laya_status.get("healthy", True),
            "jev_cloud_degraded": jev_breaker_open,
        }

    def evaluate_decision(
        self, state: Dict[str, Any], engine: Optional[str] = None
    ) -> System1Decision:
        with self._lock:
            selected_engine = (engine or state.get("preferred_engine") or self._default_engine).lower()

        if selected_engine == "jev":
            return jev_service.evaluate_decision(state)
        elif selected_engine == "consensus":
            laya_res = laya_service.evaluate_decision(state)
            jev_res = jev_service.evaluate_decision(state)
            return self.resolve_decision(laya_res, jev_res, preferred_engine="laya")

        # Default to Laya (local open-weight System-1)
        return laya_service.evaluate_decision(state)

    def resolve_decision(
        self,
        laya_dec: System1Decision,
        jev_dec: System1Decision,
        preferred_engine: Optional[str] = None,
    ) -> System1Decision:
        """
        Resolve between Laya and Jev decisions.
        When both agree on APPROVE, boost confidence and confirm sizing.
        When they disagree, adopt the more conservative verdict/action.
        """
        with self._lock:
            engine = (preferred_engine or self._default_engine).lower()

        jev_multiplier = jev_dec.position_size_multiplier
        laya_multiplier = laya_dec.position_size_multiplier

        # Consensus check: both agree on verdict
        if laya_dec.verdict == jev_dec.verdict:
            base_dec = jev_dec if engine == "jev" else laya_dec
            combined_reasons = list(base_dec.gate_reasons)
            combined_reasons.append("SYSTEM1_DUAL_ENGINE_CONSENSUS")
            conf = min(0.98, max(laya_dec.confidence, jev_dec.confidence) + 0.05)
            # The two multipliers are OPPOSITE-polarity signals, not two votes on
            # the same question: 1.25 is returned only when an engine sees clean
            # conditions, 0.85 only when it sees elevated risk. Taking max() would
            # let one optimistic engine overrule the other's risk downsize and
            # size UP on a state the other engine flagged as dangerous. Use min()
            # so any engine that sees risk wins — fail-safe, matching the
            # conservative-verdict rule above.
            mult = min(laya_multiplier, jev_multiplier)
            if mult < max(laya_multiplier, jev_multiplier):
                combined_reasons.append("SYSTEM1_RISK_DOWNSIZE_APPLIED")

            # Probabilities are a severity signal too, so they must be pooled with
            # the same fail-safe asymmetry: risk averages up, quality averages down.
            # A plain mean would halve a 0.60 stop-hunt reading to 0.375, sitting
            # right on the 0.35 routing threshold and erasing the warning.
            p_exec = min(laya_dec.p_execution_success, jev_dec.p_execution_success)
            p_hunt = max(laya_dec.p_stop_hunt_risk, jev_dec.p_stop_hunt_risk)
            p_shift = max(laya_dec.p_adverse_regime_shift, jev_dec.p_adverse_regime_shift)
            regime_align = min(laya_dec.regime_alignment, jev_dec.regime_alignment)
            opp = min(laya_dec.opportunity_score, jev_dec.opportunity_score)

            return System1Decision(
                verdict=base_dec.verdict,
                action=base_dec.action,
                confidence=round(conf, 4),
                opportunity_score=round(opp, 1),
                gate_reasons=combined_reasons,
                regime_alignment=round(regime_align, 2),
                p_execution_success=round(p_exec, 4),
                p_stop_hunt_risk=round(p_hunt, 4),
                p_adverse_regime_shift=round(p_shift, 4),
                provider=engine,
                model_id=base_dec.model_id,
                source=f"{base_dec.source}_consensus",
                latency_ms=round(max(laya_dec.latency_ms, jev_dec.latency_ms), 2),
                position_size_multiplier=mult,
            )

        # If one rejects, conservative risk management forces REJECT
        if laya_dec.verdict == "REJECT" or jev_dec.verdict == "REJECT":
            rejecting = laya_dec if laya_dec.verdict == "REJECT" else jev_dec
            return System1Decision(
                verdict="REJECT",
                action="CANCEL",
                confidence=round(max(laya_dec.confidence, jev_dec.confidence), 4),
                opportunity_score=round(min(laya_dec.opportunity_score, jev_dec.opportunity_score), 1),
                gate_reasons=list(rejecting.gate_reasons) + ["ENGINE_DISAGREEMENT_FAIL_CLOSED"],
                regime_alignment=round(min(laya_dec.regime_alignment, jev_dec.regime_alignment), 2),
                p_execution_success=round(min(laya_dec.p_execution_success, jev_dec.p_execution_success), 4),
                p_stop_hunt_risk=round(max(laya_dec.p_stop_hunt_risk, jev_dec.p_stop_hunt_risk), 4),
                p_adverse_regime_shift=round(max(laya_dec.p_adverse_regime_shift, jev_dec.p_adverse_regime_shift), 4),
                provider=engine,
                model_id=rejecting.model_id,
                source=rejecting.source,
                latency_ms=round(max(laya_dec.latency_ms, jev_dec.latency_ms), 2),
                position_size_multiplier=0.0,
            )

        # Disagreement without reject: fall through to preferred engine
        if engine == "jev":
            return jev_dec
        return laya_dec

    def evaluate_batch(
        self, states: List[Dict[str, Any]], engine: Optional[str] = None
    ) -> List[System1Decision]:
        with self._lock:
            selected_engine = (engine or self._default_engine).lower()
        if selected_engine == "laya":
            return laya_service.evaluate_batch(states)
        elif selected_engine == "jev":
            return jev_service.evaluate_batch(states)
        return [self.evaluate_decision(state, engine=selected_engine) for state in states]


system1_service = System1Service()
