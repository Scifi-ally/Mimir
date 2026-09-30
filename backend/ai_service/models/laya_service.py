"""
LAYA Service — Convai Innovations System-1 Fast Decision Engine.
─────────────────────────────────────────────────────────────────────────────
• Non-autoregressive System-1 decision architecture built on ModernBERT encoder.
• Open-source (Apache-2.0), self-hosted counterpart to TypeSafe AI's Jev.
• Trained via RLCD (Reinforcement Learning for Calibrated Decisions) against
  strictly proper scoring rules (Brier / logarithmic scoring rules) to guarantee
  honest, well-calibrated confidence probabilities without overconfidence.
• Delivers sub-40ms decision inference on GPU/CPU for pre-trade triage.
• Supports:
  1. Official `laya` package (ConvAI Innovations, `pip install laya`).
  2. HuggingFace / Transformers checkpoint (`convaiinnovations/laya`).
  3. ONNX Runtime inference session for ultra-fast C++ runtime.
  4. Lean deterministic RLCD-calibrated surrogate for zero-disk/GPU default footprint.
• Produces strongly typed primitives: Choice (verdict/action), Score (confidence,
  opportunity, regime alignment), Noul (calibrated Bernoulli probabilities), and
  dynamic position sizing multiplier.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from typing import Any, Dict, List, Optional

import numpy as np

from .system1_base import (
    System1Decision,
    check_hard_risk_gates,
    evaluate_deterministic_system1,
)

logger = logging.getLogger("ai_service.laya")

# Type alias for caller convenience
LayaDecision = System1Decision


class LayaService:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._model_id: str = os.getenv("LAYA_MODEL_ID", "convaiinnovations/laya")
        self._model_path: Optional[str] = os.getenv("LAYA_MODEL_PATH")
        self._onnx_path: Optional[str] = os.getenv("LAYA_ONNX_PATH")
        # "typed-decisions" is the checkpoint tuned for choice/score/noul
        # questions, which is what a trading verdict is. The default
        # (english) checkpoint answers them but is not tuned for them.
        self._subfolder: str = os.getenv("LAYA_SUBFOLDER", "typed-decisions")
        # Windows has no Metal, so CPU is the only backend here. Laya-MLX
        # (Apple Silicon) is a separate, faster runtime for the same weights.
        self._device: str = os.getenv("LAYA_DEVICE", "cpu")
        self._enabled: bool = os.getenv("LAYA_ENABLED", "true").lower() in ("true", "1", "yes")
        self._inference_count: int = 0
        self._weights_call_count: int = 0
        self._surrogate_call_count: int = 0
        self._last_error: Optional[str] = None
        self._weights_loaded: bool = False
        self._laya_agent: Any = None
        self._model: Any = None
        self._tokenizer: Any = None
        self._onnx_session: Any = None
        self._init_model()

    def _init_model(self) -> None:
        """Attempt to load the real Laya checkpoint: ONNX first, then the laya package.

        Preference order is deliberate. ONNXAgent is the faithful path - it keeps
        Laya's own tokenizer, typed-question encoding and calibration. The
        generic onnxruntime branch in _evaluate_model_weights is a naive
        stand-in that feeds raw logits through a softmax with no calibration,
        so it must never win over a real agent.
        """
        load_flag = os.getenv("LAYA_LOAD_WEIGHTS", "false").lower() in ("true", "1", "yes")
        path_exists = bool(self._model_path and os.path.exists(self._model_path))

        if not (load_flag or path_exists or self._onnx_exists()):
            self._weights_loaded = False
            logger.info("Laya initialised with fast calibrated RLCD surrogate (no real weights requested)")
            return

        # 1. ONNX graph, through Laya's own ONNXAgent so calibration is preserved.
        if self._onnx_exists():
            try:
                from laya.onnx_agent import ONNXAgent

                self._laya_agent = ONNXAgent(
                    onnx_path=self._onnx_path,
                    device=self._device,
                )
                self._weights_loaded = True
                logger.info("Loaded Laya ONNX graph from %s via ONNXAgent", self._onnx_path)
                return
            except Exception as e:
                logger.warning("ONNXAgent load failed (%s); falling back to the laya package", e)
                self._last_error = str(e)

        # 2. The official laya package (PyTorch on CPU, or Metal on Apple Silicon).
        target = self._model_path or self._model_id
        try:
            import laya

            kwargs: Dict[str, Any] = {"device": self._device}
            # "typed-decisions" is the checkpoint tuned for choice/score/noul
            # questions, which is exactly what a trading verdict is.
            if self._model_path is None and self._subfolder:
                kwargs["subfolder"] = self._subfolder
            self._laya_agent = laya.load(target, **kwargs)
            self._weights_loaded = True
            logger.info(
                "Loaded official Laya agent from %s (subfolder=%s, device=%s)",
                target, kwargs.get("subfolder"), self._device,
            )
            return
        except Exception as e:
            logger.info("Official laya.load not active (%s); checking PyTorch weights path", e)
            self._last_error = str(e)

        # 3. Local PyTorch / Transformers fallback.
        target_path = self._model_path or self._model_id
        try:
            from transformers import AutoModelForSequenceClassification, AutoTokenizer

            self._tokenizer = AutoTokenizer.from_pretrained(target_path)
            self._model = AutoModelForSequenceClassification.from_pretrained(target_path)
            self._model.eval()
            self._weights_loaded = True
            logger.info("Loaded Laya PyTorch weights from %s", target_path)
            return
        except Exception as e:
            logger.warning("Failed to load Laya PyTorch weights from %s: %s", target_path, e)
            self._last_error = str(e)

        # 4. Surrogate. Only reached when a real checkpoint was asked for and
        # could not be loaded - logged loudly, because it silently changes how
        # every decision is made.
        self._weights_loaded = False
        logger.error(
            "Laya real weights were requested but could not be loaded; falling back to the "
            "RLCD surrogate. Decisions will NOT come from the neural checkpoint."
        )

    def _onnx_exists(self) -> bool:
        return bool(self._onnx_path and os.path.exists(self._onnx_path))

    def reload_config(self) -> None:
        with self._lock:
            self._model_id = os.getenv("LAYA_MODEL_ID", "convaiinnovations/laya")
            self._model_path = os.getenv("LAYA_MODEL_PATH")
            self._onnx_path = os.getenv("LAYA_ONNX_PATH")
            self._subfolder = os.getenv("LAYA_SUBFOLDER", "typed-decisions")
            self._device = os.getenv("LAYA_DEVICE", "cpu")
            self._enabled = os.getenv("LAYA_ENABLED", "true").lower() in ("true", "1", "yes")
            self._init_model()

    def get_status(self) -> Dict[str, Any]:
        with self._lock:
            if self._weights_loaded:
                mode = "onnx" if self._onnx_exists() and self._laya_agent is not None else "laya_package"
            else:
                mode = "local_surrogate"
            return {
                "model": self._model_id,
                "subfolder": self._subfolder,
                "device": self._device,
                "loaded": True,
                "healthy": True,
                "enabled": self._enabled,
                "weights_loaded": self._weights_loaded,
                "mode": mode,
                "architecture": "ModernBERT-large-RLCD",
                "inference_count": self._inference_count,
                "weights_call_count": self._weights_call_count,
                "surrogate_call_count": self._surrogate_call_count,
                "last_error": self._last_error,
            }

    def _check_hard_risk_gates(self, state: Dict[str, Any]) -> Optional[LayaDecision]:
        """Sub-millisecond quantitative hard circuit breakers before neural forward pass."""
        # Labelled risk_gate, not local_surrogate: these fire *instead of* the
        # checkpoint, so calling them the surrogate would misreport which
        # component actually produced the decision.
        return check_hard_risk_gates(state, provider="laya", model_id=self._model_id, source="risk_gate")

    def _evaluate_local_surrogate(self, state: Dict[str, Any], check_gates: bool = True) -> LayaDecision:
        """Deterministic RLCD-calibrated System-1 decision function."""
        return evaluate_deterministic_system1(
            state, provider="laya", model_id=self._model_id, source="local_surrogate", check_gates=check_gates
        )

    def evaluate_decision(self, state: Dict[str, Any]) -> LayaDecision:
        """
        Evaluate candidate setup state and produce a strongly typed System-1 decision.
        Runs hard risk gates first, then ModernBERT/ONNX model if loaded, otherwise RLCD surrogate.
        """
        t0 = time.time()

        # Step 1: Pre-trade quant hard risk gates (sub-millisecond execution)
        gate_rejection = self._check_hard_risk_gates(state)
        if gate_rejection is not None:
            gate_rejection.latency_ms = round((time.time() - t0) * 1000, 2)
            with self._lock:
                self._inference_count += 1
                self._surrogate_call_count += 1
            return gate_rejection

        with self._lock:
            weights_loaded = self._weights_loaded
            enabled = self._enabled

        if weights_loaded and enabled:
            decision = self._evaluate_model_weights(state)
            if decision is not None:
                decision.latency_ms = round((time.time() - t0) * 1000, 2)
                with self._lock:
                    self._inference_count += 1
                    self._weights_call_count += 1
                return decision

        # Run RLCD-calibrated local surrogate (gates already checked above)
        decision = self._evaluate_local_surrogate(state, check_gates=False)
        decision.latency_ms = round((time.time() - t0) * 1000, 2)
        with self._lock:
            self._inference_count += 1
            self._surrogate_call_count += 1
        return decision

    @staticmethod
    def _get_laya_questions() -> Dict[str, Dict[str, Any]]:
        return {
            "verdict": {
                "type": "choice",
                "instructions": "Evaluate whether candidate trading setup should be approved, rejected, or entered with caution.",
                "criteria": {
                    "APPROVE": "High quality setup aligned with regime and order flow",
                    "REJECT": "Risky, low risk-reward, or counter-regime setup",
                    "CAUTION": "Moderate setup requiring confirmation or pullback entry",
                },
            },
            "action": {
                "type": "choice",
                "instructions": "Recommended execution action",
                "criteria": {
                    "EXECUTE_IMMEDIATELY": "Immediate market execution",
                    "CONFIRMED_ENTRY": "Wait for trigger price or level confirmation",
                    "LIMIT_PULLBACK": "Enter on limit order pullback to VWAP/support",
                    "CANCEL": "Cancel setup",
                },
            },
            "opportunity_score": {
                "type": "score",
                "instructions": "Trading opportunity score between 0 and 100",
                "criteria": ["none", "low", "medium", "high", "elite"],
            },
            "p_execution_success": {
                "type": "noul",
                "instructions": "Probability of clean execution fill without adverse market selection",
            },
            "p_stop_hunt_risk": {
                "type": "noul",
                "instructions": "Probability of wick-triggered stop out before profit target",
            },
            "p_adverse_regime_shift": {
                "type": "noul",
                "instructions": "Probability of adverse market regime shift against trade direction",
            },
        }

    def _decode_laya_agent_answers(self, answers: Dict[str, Any], source: str = "laya_package") -> LayaDecision:
        def _extract_choice(val: Any, default: str) -> str:
            if isinstance(val, dict):
                return str(val.get("choice") or default).upper()
            return str(val or default).upper()

        def _extract_score(val: Any, default: float, max_levels: float = 4.0) -> float:
            if isinstance(val, dict):
                s = val.get("score")
                if s is not None:
                    try:
                        return round((float(s) / max_levels) * 100.0, 1)
                    except (ValueError, TypeError):
                        pass
            try:
                f = float(val)
                return f if f > 1.0 else round(f * 100.0, 1)
            except (ValueError, TypeError):
                return default

        def _extract_noul(val: Any, default: float) -> float:
            if isinstance(val, dict):
                n = val.get("noul")
                if n is not None:
                    try:
                        return round(float(n), 4)
                    except (ValueError, TypeError):
                        pass
            try:
                return round(float(val), 4)
            except (ValueError, TypeError):
                return default

        def _extract_conf(val: Any, default: float) -> float:
            if isinstance(val, dict):
                c = val.get("answer_confidence") if val.get("answer_confidence") is not None else val.get("confidence")
                if c is not None:
                    try:
                        return round(float(c), 4)
                    except (ValueError, TypeError):
                        pass
            try:
                return round(float(val), 4)
            except (ValueError, TypeError):
                return default

        verdict = _extract_choice(answers.get("verdict"), "CAUTION")
        action = _extract_choice(answers.get("action"), "CONFIRMED_ENTRY")

        verdict_val = answers.get("verdict")
        conf_raw = None
        if isinstance(verdict_val, dict):
            conf_raw = verdict_val.get("answer_confidence") if verdict_val.get("answer_confidence") is not None else verdict_val.get("confidence")
        if conf_raw is None:
            conf_raw = answers.get("confidence")
        if conf_raw is None:
            conf_raw = verdict_val
        conf_val = _extract_conf(conf_raw, 0.70)

        opp_val = _extract_score(answers.get("opportunity_score"), 65.0, max_levels=4.0)
        p_exec = _extract_noul(answers.get("p_execution_success"), 0.85 if verdict == "APPROVE" else (0.20 if verdict == "REJECT" else 0.50))
        p_hunt = _extract_noul(answers.get("p_stop_hunt_risk"), 0.15 if verdict == "APPROVE" else (0.75 if verdict == "REJECT" else 0.40))
        p_shift = _extract_noul(answers.get("p_adverse_regime_shift"), 0.15 if verdict == "APPROVE" else (0.70 if verdict == "REJECT" else 0.35))

        if verdict == "REJECT":
            action = "CANCEL"
            mult = 0.0
        elif verdict == "APPROVE":
            if action == "CANCEL":
                action = "EXECUTE_IMMEDIATELY"
            if p_hunt > 0.35 and action == "EXECUTE_IMMEDIATELY":
                action = "LIMIT_PULLBACK"
            mult = 1.25 if conf_val >= 0.80 and p_hunt <= 0.20 else 1.0
        else:  # CAUTION
            if action == "EXECUTE_IMMEDIATELY":
                action = "CONFIRMED_ENTRY"
            mult = 0.65

        regime_alignment = 0.6 if verdict == "APPROVE" else (-0.6 if verdict == "REJECT" else 0.0)

        return LayaDecision(
            verdict=verdict,
            action=action,
            confidence=round(max(0.0, min(1.0, conf_val)), 4),
            opportunity_score=round(max(0.0, min(100.0, opp_val)), 1),
            gate_reasons=[f"LAYA_{source.upper()}_FORWARD_PASS"],
            regime_alignment=regime_alignment,
            p_execution_success=p_exec,
            p_stop_hunt_risk=p_hunt,
            p_adverse_regime_shift=p_shift,
            provider="laya",
            model_id=self._model_id,
            source=source,
            position_size_multiplier=mult,
        )

    def evaluate_batch(self, states: List[Dict[str, Any]]) -> List[LayaDecision]:
        """Evaluate a batch of candidate states."""
        t0 = time.time()
        with self._lock:
            laya_agent = self._laya_agent
            weights_loaded = self._weights_loaded
            enabled = self._enabled

        decisions: List[Optional[LayaDecision]] = [self._check_hard_risk_gates(s) for s in states]

        pending_indices = [i for i, d in enumerate(decisions) if d is None]
        predicted_count = 0
        if laya_agent is not None and enabled and len(pending_indices) > 0:
            try:
                questions = self._get_laya_questions()
                prompts = [self.format_state_prompt(states[i]) if isinstance(states[i], dict) else states[i] for i in pending_indices]
                batch_res = laya_agent.predict_batch(prompts, questions)
                for idx, res in zip(pending_indices, batch_res):
                    ans = res.get("answers", {}) if isinstance(res, dict) else getattr(res, "answers", {})
                    decisions[idx] = self._decode_laya_agent_answers(ans, source="laya_package")
                predicted_count = len(pending_indices)
                with self._lock:
                    self._inference_count += predicted_count
                    self._weights_call_count += predicted_count
            except Exception as e:
                logger.warning(f"Laya agent predict_batch failed: {e}; falling back to individual evaluation")

        final_results: List[LayaDecision] = []
        surrogate_count = 0
        for i, dec in enumerate(decisions):
            if dec is not None:
                final_results.append(dec)
                if dec.source == "local_surrogate":
                    surrogate_count += 1
            elif weights_loaded and enabled:
                final_results.append(self.evaluate_decision(states[i]))
            else:
                surrogate_dec = self._evaluate_local_surrogate(states[i], check_gates=False)
                final_results.append(surrogate_dec)
                surrogate_count += 1

        if surrogate_count > 0:
            with self._lock:
                self._inference_count += surrogate_count
                self._surrogate_call_count += surrogate_count

        elapsed_per_item = round(((time.time() - t0) * 1000) / max(1, len(states)), 2)
        for dec in final_results:
            if dec.latency_ms == 0.0:
                dec.latency_ms = elapsed_per_item

        return final_results

    def _logits_to_decision(
        self, logits: np.ndarray, probs: np.ndarray, source: str
    ) -> LayaDecision:
        verdicts = ["APPROVE", "REJECT", "CAUTION"]
        actions = [
            "EXECUTE_IMMEDIATELY",
            "CONFIRMED_ENTRY",
            "LIMIT_PULLBACK",
            "CANCEL",
        ]

        if len(probs) >= 3:
            verdict_idx = int(np.argmax(probs[:3]))
            verdict = verdicts[verdict_idx]
            conf = float(probs[verdict_idx])
        elif len(probs) == 2:
            if probs[1] >= 0.65:
                verdict = "APPROVE"
                conf = float(probs[1])
            elif probs[1] <= 0.35:
                verdict = "REJECT"
                conf = float(probs[0])
            else:
                verdict = "CAUTION"
                conf = float(max(probs))
        else:
            verdict = "CAUTION"
            conf = 0.50

        if verdict == "APPROVE":
            action = actions[0]
            opportunity_score = round(min(100.0, 50.0 + conf * 50.0), 1)
            regime_alignment = 0.6
            p_exec = round(min(0.98, max(0.55, conf)), 4)
            p_hunt = round(max(0.02, min(0.40, 1.0 - conf)), 4)
            p_shift = 0.20
            multiplier = 1.25 if conf >= 0.80 else 1.0
        elif verdict == "REJECT":
            action = actions[3]
            opportunity_score = round(max(0.0, (1.0 - conf) * 40.0), 1)
            regime_alignment = -0.6
            p_exec = round(max(0.02, min(0.25, 1.0 - conf)), 4)
            p_hunt = round(min(0.98, max(0.70, conf)), 4)
            p_shift = round(min(0.95, max(0.65, conf * 0.9)), 4)
            multiplier = 0.0
        else:  # CAUTION
            action = actions[1]
            opportunity_score = 50.0
            regime_alignment = 0.0
            p_exec = 0.50
            p_hunt = 0.40
            p_shift = 0.35
            multiplier = 0.65

        return LayaDecision(
            verdict=verdict,
            action=action,
            confidence=round(conf, 4),
            opportunity_score=opportunity_score,
            gate_reasons=[f"LAYA_{source.upper()}_FORWARD_PASS"],
            regime_alignment=regime_alignment,
            p_execution_success=p_exec,
            p_stop_hunt_risk=p_hunt,
            p_adverse_regime_shift=p_shift,
            provider="laya",
            model_id=self._model_id,
            source=source,
            position_size_multiplier=multiplier,
        )

    def _evaluate_model_weights(self, state: Dict[str, Any]) -> Optional[LayaDecision]:
        """Inference with official laya package, ONNX, or PyTorch weights."""
        try:
            if self._laya_agent is not None:
                questions = self._get_laya_questions()
                prompt_input = self.format_state_prompt(state) if isinstance(state, dict) else state
                res = self._laya_agent.predict(prompt_input, questions)
                answers = res.get("answers", {}) if isinstance(res, dict) else getattr(res, "answers", {})
                return self._decode_laya_agent_answers(answers, source="laya_package")

            prompt = self.format_state_prompt(state)

            if self._onnx_session is not None:
                session = self._onnx_session
                input_names = [inp.name for inp in session.get_inputs()]

                if self._tokenizer is not None and ("input_ids" in input_names or len(input_names) >= 1):
                    inputs = self._tokenizer(
                        prompt, return_tensors="np", max_length=512, truncation=True
                    )
                    onnx_inputs = {}
                    for inp in session.get_inputs():
                        if inp.name in inputs:
                            onnx_inputs[inp.name] = inputs[inp.name].astype(np.int64)
                    outputs = session.run(None, onnx_inputs)
                    logits = outputs[0]
                else:
                    first_inp = session.get_inputs()[0]
                    feat_vec = np.array([
                        float(state.get("technical_score", 50.0) or 50.0),
                        float(state.get("risk_reward_ratio", 1.5) or 1.5),
                        float(state.get("order_flow_imbalance_ratio", 0.0) or 0.0),
                        float(state.get("fii_dii_net", 0.0) or 0.0),
                        float(state.get("india_vix", 15.0) or 15.0),
                        float(state.get("sentiment_score", 0.0) or 0.0),
                        float(state.get("win_probability", 0.5) or 0.5),
                    ], dtype=np.float32)
                    expected_dim = first_inp.shape[-1] if len(first_inp.shape) > 1 else len(first_inp.shape)
                    if isinstance(expected_dim, int) and expected_dim > len(feat_vec):
                        pad = np.zeros(expected_dim - len(feat_vec), dtype=np.float32)
                        feat_vec = np.concatenate([feat_vec, pad])
                    elif isinstance(expected_dim, int) and expected_dim < len(feat_vec):
                        feat_vec = feat_vec[:expected_dim]
                    onnx_inputs = {first_inp.name: np.expand_dims(feat_vec, axis=0)}
                    outputs = session.run(None, onnx_inputs)
                    logits = outputs[0]

                if len(logits.shape) > 1:
                    logits = logits[0]

                exp_logits = np.exp(logits - np.max(logits))
                probs = exp_logits / np.sum(exp_logits)
                return self._logits_to_decision(logits, probs, source="laya_onnx")

            if self._model is not None and self._tokenizer is not None:
                import torch

                inputs = self._tokenizer(
                    prompt, return_tensors="pt", max_length=512, truncation=True
                )
                with torch.no_grad():
                    outputs = self._model(**inputs)
                    logits = outputs.logits.squeeze(0).cpu().numpy()

                exp_logits = np.exp(logits - np.max(logits))
                probs = exp_logits / np.sum(exp_logits)
                return self._logits_to_decision(logits, probs, source="laya_weights")

            return None
        except Exception as e:
            logger.warning(f"Laya model weights execution failed: {e}; degrading to RLCD surrogate")
            self._last_error = str(e)
            return None

    def format_state_prompt(self, state: Dict[str, Any]) -> str:
        """Format candidate dictionary into structured ModernBERT sequence tokens."""
        symbol = str(state.get("symbol", "UNKNOWN"))
        direction = str(state.get("direction", "BUY")).upper()
        setup = str(state.get("setup_type", "PULLBACK"))
        tech = state.get("technical_score", 50.0)
        rr = state.get("risk_reward_ratio", 1.5)
        ofi = state.get("order_flow_imbalance_ratio", 0.0)
        fii = state.get("fii_dii_net", 0.0)
        vix = state.get("india_vix", 15.0)
        regime = str(state.get("market_regime", "UNKNOWN"))
        win_prob = state.get("win_probability", 0.5)

        return (
            f"Symbol: {symbol} | Direction: {direction} | Setup: {setup} | "
            f"TechScore: {tech} | RiskReward: {rr} | OFI: {ofi} | "
            f"FIINet: {fii} | VIX: {vix} | Regime: {regime} | "
            f"WinProb: {win_prob}"
        )


# Singleton instance
laya_service = LayaService()
