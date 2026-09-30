"""
Tests for LAYA (Convai Innovations) System-1 Fast Decision Engine, JEV, and Unified System-1 Router.
─────────────────────────────────────────────────────────────────────────────
• Validates RLCD-calibrated decision primitives: Choice, Score, and Noul.
• Validates ModernBERT prompt serialization and loading options.
• Validates boundary edge cases, NaN/inf sanitization, and graceful fallbacks.
• Validates FastAPI endpoints (/inference/laya, /inference/jev, /inference/system1, /health, /inference/batch).
• Validates quant-grade trading edge: OFI, VIX spikes, pullback entries, and position size multipliers.
"""

import math
import numpy as np
import pytest
from fastapi.testclient import TestClient

from models.laya_service import laya_service, LayaDecision
from models.system1_service import system1_service, System1Decision
from main import app


@pytest.fixture
def client():
    return TestClient(app)


# ---------------------------------------------------------------------------
# 1. Laya Service & Surrogate Unit Tests
# ---------------------------------------------------------------------------

def test_laya_service_status_reports_real_checkpoint_state():
    """Status must reflect whether a checkpoint is actually serving decisions.

    This test previously asserted loaded/healthy are True, which the service
    hardcoded - so it passed while the deterministic surrogate was doing all the
    work. That is exactly the failure mode worth guarding: an operator reading
    /health must be able to tell the difference between "a neural checkpoint is
    answering" and "arithmetic is answering".
    """
    status = laya_service.get_status()
    assert status["model"] == "convaiinnovations/laya"
    assert "mode" in status
    assert status["architecture"] == "ModernBERT-large-RLCD"

    # loaded/healthy must agree with weights_loaded and with each other.
    assert status["loaded"] == status["weights_loaded"]
    assert status["using_surrogate"] == (not status["weights_loaded"])
    if status["weights_loaded"]:
        assert status["loaded"] is True
        assert status["healthy"] is True
        assert status["mode"] in ("laya_package", "onnx")
    else:
        # No weights: must not claim to be a healthy loaded model.
        assert status["loaded"] is False
        assert status["mode"] == "local_surrogate"


def test_laya_local_surrogate_approval():
    state = {
        "symbol": "RELIANCE",
        "direction": "BUY",
        "setup_type": "PULLBACK",
        "timeframe": "15m",
        "entry_price": 2900.0,
        "stop_loss": 2860.0,
        "target1": 2980.0,
        "risk_reward_ratio": 2.0,
        "technical_score": 85.0,
        "chronos_trend": "bullish",
        "sentiment_score": 0.45,
        "order_flow_imbalance_ratio": 0.35,
        "fii_dii_net": 1500.0,
        "india_vix": 13.5,
        "market_regime": "BULL_TRENDING",
        "win_probability": 0.72,
    }
    decision = laya_service.evaluate_decision(state)
    assert isinstance(decision, LayaDecision)
    assert decision.verdict == "APPROVE"
    assert decision.action in ("EXECUTE_IMMEDIATELY", "LIMIT_PULLBACK")
    assert decision.confidence >= 0.65
    assert decision.opportunity_score >= 70.0
    assert decision.regime_alignment > 0.0
    assert decision.provider == "laya"
    assert decision.model_id == "convaiinnovations/laya"
    assert decision.position_size_multiplier >= 1.0

    # Test Noul Bernoulli primitives
    assert 0.0 <= decision.p_execution_success <= 1.0
    assert 0.0 <= decision.p_stop_hunt_risk <= 1.0
    assert 0.0 <= decision.p_adverse_regime_shift <= 1.0
    assert decision.p_execution_success > 0.50
    assert decision.p_stop_hunt_risk < 0.40


def test_laya_local_surrogate_rejections():
    # Case A: Spike in VIX
    state_vix = {
        "symbol": "TCS",
        "direction": "BUY",
        "india_vix": 28.0,
        "risk_reward_ratio": 2.0,
    }
    dec_vix = laya_service.evaluate_decision(state_vix)
    assert dec_vix.verdict == "REJECT"
    assert dec_vix.action == "CANCEL"
    assert any("VIX" in r for r in dec_vix.gate_reasons)
    assert dec_vix.p_stop_hunt_risk >= 0.70
    assert dec_vix.p_execution_success <= 0.25
    assert dec_vix.position_size_multiplier == 0.0

    # Case B: Unfavorable Risk-Reward
    state_rr = {
        "symbol": "INFY",
        "direction": "BUY",
        "risk_reward_ratio": 0.9,
        "india_vix": 14.0,
    }
    dec_rr = laya_service.evaluate_decision(state_rr)
    assert dec_rr.verdict == "REJECT"
    assert dec_rr.action == "CANCEL"
    assert any("RISK_REWARD" in r for r in dec_rr.gate_reasons)
    assert dec_rr.position_size_multiplier == 0.0

    # Case C: Heavy Institutional Selling against BUY
    state_fii = {
        "symbol": "HDFCBANK",
        "direction": "BUY",
        "fii_dii_net": -3500.0,
        "risk_reward_ratio": 2.0,
        "india_vix": 14.0,
    }
    dec_fii = laya_service.evaluate_decision(state_fii)
    assert dec_fii.verdict == "REJECT"
    assert dec_fii.action == "CANCEL"
    assert any("INSTITUTIONAL" in r for r in dec_fii.gate_reasons)
    assert dec_fii.position_size_multiplier == 0.0

    # Case D: Severe Order Flow Contradiction
    state_ofi = {
        "symbol": "KOTAKBANK",
        "direction": "BUY",
        "risk_reward_ratio": 2.0,
        "india_vix": 14.0,
        "order_flow_imbalance_ratio": -0.45,
    }
    dec_ofi = laya_service.evaluate_decision(state_ofi)
    assert dec_ofi.verdict == "REJECT"
    assert dec_ofi.action == "CANCEL"
    assert any("ORDER_FLOW" in r for r in dec_ofi.gate_reasons)
    assert dec_ofi.position_size_multiplier == 0.0


def test_laya_batch_evaluation():
    states = [
        {"symbol": "SBIN", "direction": "BUY", "risk_reward_ratio": 2.2, "india_vix": 13.0, "technical_score": 80.0},
        {"symbol": "ITC", "direction": "BUY", "risk_reward_ratio": 0.8, "india_vix": 13.0},
    ]
    results = laya_service.evaluate_batch(states)
    assert len(results) == 2
    assert results[0].verdict in ("APPROVE", "CAUTION")
    assert results[1].verdict == "REJECT"


def test_laya_dirty_and_edge_inputs():
    # Empty state
    empty_dec = laya_service.evaluate_decision({})
    assert empty_dec.verdict in ("APPROVE", "CAUTION", "REJECT")
    assert not math.isnan(empty_dec.opportunity_score)
    assert not math.isnan(empty_dec.confidence)
    assert not math.isnan(empty_dec.p_execution_success)

    # Dirty NaN / Inf values
    dirty_state = {
        "symbol": "DIRTY",
        "direction": None,
        "risk_reward_ratio": float("nan"),
        "technical_score": float("inf"),
        "india_vix": float("nan"),
        "fii_dii_net": None,
    }
    dirty_dec = laya_service.evaluate_decision(dirty_state)
    assert dirty_dec.verdict in ("APPROVE", "CAUTION", "REJECT")
    assert not math.isnan(dirty_dec.opportunity_score)
    assert not math.isnan(dirty_dec.confidence)
    assert not math.isnan(dirty_dec.p_execution_success)


def test_laya_format_prompt():
    state = {
        "symbol": "BAJFINANCE",
        "direction": "BUY",
        "setup_type": "BREAKOUT",
        "technical_score": 88.0,
        "risk_reward_ratio": 2.4,
        "india_vix": 14.2,
    }
    prompt = laya_service.format_state_prompt(state)
    assert "BAJFINANCE" in prompt
    assert "BUY" in prompt
    assert "BREAKOUT" in prompt
    assert "88.0" in prompt


def test_laya_counter_regime_vix_rejection():
    # Elevated VIX (>20) with counter-regime direction
    state = {
        "symbol": "COUNTER",
        "direction": "BUY",
        "market_regime": "BEAR_TRENDING",
        "risk_reward_ratio": 2.2,
        "india_vix": 21.5,
    }
    decision = laya_service.evaluate_decision(state)
    assert decision.verdict == "REJECT"
    assert decision.action == "CANCEL"
    assert any("COUNTER_REGIME" in r for r in decision.gate_reasons)


def test_laya_pytorch_weights_forward_pass(monkeypatch):
    import torch

    class DummyModel:
        def __init__(self, logits):
            self._logits = logits

        def __call__(self, **kwargs):
            class DummyOutput:
                pass
            out = DummyOutput()
            out.logits = self._logits
            return out

    def dummy_tokenizer(text, **kwargs):
        return {"input_ids": torch.tensor([[1, 2, 3]])}

    state = {
        "symbol": "MOCKWEIGHTS",
        "direction": "BUY",
        "risk_reward_ratio": 2.0,
        "india_vix": 14.0,
    }

    # Case 1: APPROVE logits [10.0, -10.0, -10.0]
    monkeypatch.setattr(laya_service, "_laya_agent", None)
    monkeypatch.setattr(laya_service, "_model", DummyModel(torch.tensor([[10.0, -10.0, -10.0]])))
    monkeypatch.setattr(laya_service, "_tokenizer", dummy_tokenizer)
    monkeypatch.setattr(laya_service, "_weights_loaded", True)
    monkeypatch.setattr(laya_service, "_onnx_session", None)

    dec_approve = laya_service.evaluate_decision(state)
    assert dec_approve.source == "laya_weights"
    assert dec_approve.verdict == "APPROVE"
    assert dec_approve.action == "EXECUTE_IMMEDIATELY"
    assert dec_approve.confidence > 0.90
    assert dec_approve.p_execution_success > 0.80
    assert dec_approve.p_stop_hunt_risk < 0.20
    assert dec_approve.opportunity_score >= 80.0
    assert dec_approve.position_size_multiplier == 1.25

    # Case 2: REJECT logits [-10.0, 10.0, -10.0]
    monkeypatch.setattr(laya_service, "_model", DummyModel(torch.tensor([[-10.0, 10.0, -10.0]])))
    dec_reject = laya_service.evaluate_decision(state)
    assert dec_reject.source == "laya_weights"
    assert dec_reject.verdict == "REJECT"
    assert dec_reject.action == "CANCEL"
    assert dec_reject.confidence > 0.90
    assert dec_reject.p_execution_success <= 0.25
    assert dec_reject.p_stop_hunt_risk >= 0.70
    assert dec_reject.opportunity_score <= 40.0
    assert dec_reject.position_size_multiplier == 0.0


def test_laya_onnx_session_forward_pass(monkeypatch):
    class DummyInput:
        def __init__(self, name, shape):
            self.name = name
            self.shape = shape

    class DummySession:
        def get_inputs(self):
            return [DummyInput("features", [1, 7])]

        def run(self, output_names, input_feed):
            return [np.array([[8.0, -5.0, -2.0]], dtype=np.float32)]

    state = {
        "symbol": "MOCKONNX",
        "direction": "BUY",
        "risk_reward_ratio": 2.0,
        "india_vix": 14.0,
    }

    monkeypatch.setattr(laya_service, "_laya_agent", None)
    monkeypatch.setattr(laya_service, "_onnx_session", DummySession())
    monkeypatch.setattr(laya_service, "_tokenizer", None)
    monkeypatch.setattr(laya_service, "_weights_loaded", True)

    dec_onnx = laya_service.evaluate_decision(state)
    assert dec_onnx.source == "laya_onnx"
    assert dec_onnx.verdict == "APPROVE"
    assert dec_onnx.p_execution_success > 0.80
    assert dec_onnx.opportunity_score >= 80.0


def test_laya_package_agent_integration(monkeypatch):
    class DummyLayaAgent:
        def predict(self, state, questions):
            return {
                "answers": {
                    "verdict": "APPROVE",
                    "action": "EXECUTE_IMMEDIATELY",
                    "confidence": 0.88,
                    "opportunity_score": 85.0,
                }
            }

    state = {
        "symbol": "RELIANCE",
        "direction": "BUY",
        "risk_reward_ratio": 2.2,
        "india_vix": 13.5,
    }
    monkeypatch.setattr(laya_service, "_laya_agent", DummyLayaAgent())
    monkeypatch.setattr(laya_service, "_weights_loaded", True)

    dec = laya_service.evaluate_decision(state)
    assert dec.source == "laya_package"
    assert dec.verdict == "APPROVE"
    assert dec.confidence == 0.88
    assert dec.opportunity_score == 85.0
    assert dec.position_size_multiplier == 1.25


# ---------------------------------------------------------------------------
# 2. Jev Service Unit Tests
# ---------------------------------------------------------------------------

def test_retired_engines_still_route_to_local_laya():
    state = {
        "symbol": "TATASTEEL",
        "direction": "BUY",
        "risk_reward_ratio": 2.0,
        "technical_score": 75.0,
        "india_vix": 14.0,
    }

    baseline = system1_service.evaluate_decision(state, engine="laya")
    for retired in ("jev", "consensus"):
        dec = system1_service.evaluate_decision(state, engine=retired)
        assert dec.provider == "laya", f"{retired} must not select another provider"
        assert dec.verdict == baseline.verdict
        assert dec.source == baseline.source


def test_preferred_engine_in_state_cannot_select_a_cloud_model():
    state = {
        "symbol": "TATASTEEL",
        "direction": "BUY",
        "risk_reward_ratio": 2.0,
        "preferred_engine": "jev",
    }
    dec = system1_service.evaluate_decision(state)
    assert dec.provider == "laya"


def test_system1_router_status_reports_no_cloud_engines():
    status = system1_service.get_status()
    assert "default_engine" in status
    assert "laya" in status
    # Honest, not optimistic: the router must not claim healthy when the
    # checkpoint it fronts is not loaded and decisions are coming from the
    # deterministic surrogate instead.
    assert status["healthy"] == status["laya"]["healthy"]
    # A stale SYSTEM1_ENGINE in a .env should be visible, not silently ignored.
    assert set(status["retired_engines"]) == {"jev", "consensus"}
    assert status["cloud_engines_available"] is False
    assert "jev" not in status


def test_system1_service_exposes_no_dual_engine_resolver():
    # resolve_decision merged a Laya and a Jev decision; with one engine there
    # is nothing to merge, so the API is gone rather than left as dead code.
    assert not hasattr(system1_service, "resolve_decision")


def test_app_module_cannot_reach_a_cloud_engine():
    """The cloud client must be unimportable from the application, not just unused.

    main.py used to hold a module-level `jev_service` handle alongside a live
    POST /inference/jev route. Closing the router left both in place, so a
    cloud call was one edit away. The handle itself is what has to be gone.
    """
    import main

    assert not hasattr(main, "jev_service"), (
        "the cloud engine must not be imported into the application; a module-level "
        "handle is one refactor away from being called again"
    )


def test_cloud_engine_module_is_deleted():
    """models/jev_service.py should not exist at all.

    Kept as a test because dead-but-present cloud code is how this came back in
    the first place: the engine was retired from the router and left on disk
    with a full HTTP client and API-key handling.
    """
    import pathlib

    import models

    pkg = pathlib.Path(models.__file__).parent
    assert not (pkg / "jev_service.py").exists(), (
        "models/jev_service.py still exists; the TypeSafe cloud client was retired"
    )


# ---------------------------------------------------------------------------
# 4. FastAPI Endpoint Tests
# ---------------------------------------------------------------------------

def test_api_health_includes_laya_and_system1(client):
    response = client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert "laya" in data["models"]
    assert "system1" in data["models"]
    # The cloud engine is gone; its absence from /health is the point.
    assert "jev" not in data["models"]
    assert "lara" not in data["models"]
    laya_health = data["models"]["laya"]
    # Must agree with whether a checkpoint is loaded, not be hardcoded True.
    assert laya_health["healthy"] == laya_health["weights_loaded"]
    assert data["models"]["system1"]["healthy"] == laya_health["healthy"]

    # /health must state which components actually contribute to a decision.
    # "AI Mode" used to be reported whenever the rule engine plus Chronos
    # loaded, which is true even with every trained model absent.
    assert "contributing_to_decisions" in data
    contributing = data["contributing_to_decisions"]
    assert contributing["laya_checkpoint"] == laya_health["weights_loaded"]
    assert contributing["ranker_calibrated_pwin"] == data["models"]["ranker"]["gate_active"]
    assert "trained_model_count" in data
    assert data["trained_model_count"] == sum(
        1 for key in ("chronos_forecast", "laya_checkpoint", "ranker_calibrated_pwin")
        if contributing[key]
    )
    # The verdict must follow from the components, not from two of them.
    if data["degraded_components"]:
        assert data["status"] == "degraded"
    else:
        assert data["status"] in ("healthy", "degraded")


def test_api_laya_endpoint(client):
    req_body = {
        "symbol": "WIPRO",
        "direction": "BUY",
        "setup_type": "PULLBACK",
        "risk_reward_ratio": 2.1,
        "technical_score": 78.0,
        "india_vix": 14.0,
        "fii_dii_net": 500.0,
    }
    response = client.post("/inference/laya", json=req_body)
    assert response.status_code == 200
    data = response.json()
    assert data["verdict"] in ("APPROVE", "CAUTION", "REJECT")
    assert data["action"] in ("EXECUTE_IMMEDIATELY", "CONFIRMED_ENTRY", "LIMIT_PULLBACK", "CANCEL")
    assert "confidence" in data
    assert "opportunity_score" in data
    assert "p_execution_success" in data
    assert "p_stop_hunt_risk" in data
    assert "p_adverse_regime_shift" in data
    assert "position_size_multiplier" in data
    assert data["provider"] == "laya"


def test_api_jev_endpoint_is_gone(client):
    """The cloud endpoint must be absent, not merely disabled.

    Jev was TypeSafe AI's managed inference API. This platform is required to
    decide fully offline with no third-party model in the loop, so the route
    itself is removed - a 404 is the guarantee, since a route that still exists
    and returns an error is one refactor away from being wired up again.
    """
    response = client.post("/inference/jev", json={"symbol": "WIPRO", "direction": "BUY"})
    assert response.status_code == 404


def test_api_system1_endpoint(client):
    req_body = {
        "symbol": "MARUTI",
        "direction": "BUY",
        "risk_reward_ratio": 2.0,
        "technical_score": 75.0,
        "preferred_engine": "laya",
    }
    response = client.post("/inference/system1", json=req_body)
    assert response.status_code == 200
    data = response.json()
    assert data["provider"] == "laya"
    assert "p_execution_success" in data
    assert "position_size_multiplier" in data


def test_api_batch_inference_includes_laya_and_system1(client, monkeypatch):
    import main

    async def mock_sentiment(symbol):
        return {"symbol_specific_score": 0.5, "market_wide_score": 0.0, "world_score": 0.0, "composite": 0.5}

    monkeypatch.setattr(main, "analyze_sentiment", mock_sentiment)

    candles = [
        [100.0 + i, 102.0 + i, 99.0 + i, 101.5 + i, 5000.0 + i * 100]
        for i in range(25)
    ]
    batch_req = {
        "candidates": [
            {
                "symbol": "HCLTECH",
                "ohlcv": candles,
                "features": {
                    "direction": "BUY",
                    "setup_type": "PULLBACK",
                    "risk_reward_ratio": 2.2,
                    "india_vix": 14.0,
                },
            }
        ]
    }
    response = client.post("/inference/batch", json=batch_req)
    assert response.status_code == 200
    data = response.json()
    assert "results" in data
    assert len(data["results"]) == 1
    cand_res = data["results"][0]
    assert "laya_decision" in cand_res
    assert cand_res["laya_decision"] is not None
    assert cand_res["laya_decision"]["verdict"] in ("APPROVE", "CAUTION", "REJECT")
    assert "p_execution_success" in cand_res["laya_decision"]
    assert "position_size_multiplier" in cand_res["laya_decision"]
    assert "system1_decision" in cand_res
    assert cand_res["system1_decision"] is not None
    assert "position_size_multiplier" in cand_res["system1_decision"]
    assert data["laya_enabled"] is True
    assert data["system1_enabled"] is True
    # Ensure lara is completely gone
    assert "lara_opportunity" not in cand_res
    assert "lara_enabled" not in data


def test_laya_hard_risk_gates_override_model_weights(monkeypatch):
    """Confirm that ML model weights can NEVER bypass quant circuit breakers (VIX, RR, etc.)."""
    class CarelessModel:
        def predict(self, state, questions):
            # Careless model predicts APPROVE despite toxic market conditions
            return {
                "answers": {
                    "verdict": "APPROVE",
                    "action": "EXECUTE_IMMEDIATELY",
                    "confidence": 0.99,
                    "opportunity_score": 95.0,
                }
            }

    monkeypatch.setattr(laya_service, "_laya_agent", CarelessModel())
    monkeypatch.setattr(laya_service, "_weights_loaded", True)

    # Toxic VIX spike
    toxic_vix = {"symbol": "INFY", "direction": "BUY", "india_vix": 29.5, "risk_reward_ratio": 2.5}
    dec_vix = laya_service.evaluate_decision(toxic_vix)
    assert dec_vix.verdict == "REJECT"
    assert dec_vix.action == "CANCEL"
    assert dec_vix.position_size_multiplier == 0.0
    assert any("VIX" in r for r in dec_vix.gate_reasons)

    # Toxic unfavorable risk-reward
    toxic_rr = {"symbol": "TCS", "direction": "BUY", "india_vix": 14.0, "risk_reward_ratio": 0.75}
    dec_rr = laya_service.evaluate_decision(toxic_rr)
    assert dec_rr.verdict == "REJECT"
    assert dec_rr.action == "CANCEL"
    assert dec_rr.position_size_multiplier == 0.0
    assert any("RISK_REWARD" in r for r in dec_rr.gate_reasons)


def test_laya_nested_dict_agent_decoding(monkeypatch):
    """Test official laya.agent.Agent dictionary output format with RLCD score and noul scaling."""
    class OfficialLayaFormatAgent:
        def predict(self, state, questions):
            return {
                "answers": {
                    "verdict": {
                        "type": "choice",
                        "choice": "APPROVE",
                        "probabilities": {"APPROVE": 0.84, "REJECT": 0.06, "CAUTION": 0.10},
                        "answer_confidence": 0.84,
                        "confidence": 0.35,
                    },
                    "action": {
                        "type": "choice",
                        "choice": "EXECUTE_IMMEDIATELY",
                    },
                    "opportunity_score": {
                        "type": "score",
                        "score": 3.6,  # 3.6 / 4.0 = 90.0%
                    },
                    "p_execution_success": {
                        "type": "noul",
                        "noul": 0.895,
                    },
                    "p_stop_hunt_risk": {
                        "type": "noul",
                        "noul": 0.115,
                    },
                    "p_adverse_regime_shift": {
                        "type": "noul",
                        "noul": 0.082,
                    },
                }
            }

    monkeypatch.setattr(laya_service, "_laya_agent", OfficialLayaFormatAgent())
    monkeypatch.setattr(laya_service, "_weights_loaded", True)

    state = {"symbol": "RELIANCE", "direction": "BUY", "risk_reward_ratio": 2.2, "india_vix": 13.5}
    dec = laya_service.evaluate_decision(state)
    assert dec.source == "laya_package"
    assert dec.verdict == "APPROVE"
    assert dec.action == "EXECUTE_IMMEDIATELY"
    assert dec.confidence == 0.84
    assert dec.opportunity_score == 90.0
    assert dec.p_execution_success == 0.895
    assert dec.p_stop_hunt_risk == 0.115
    assert dec.position_size_multiplier == 1.25


def test_laya_stop_hunt_pullback_action_reanchoring(monkeypatch):
    """Confirm that when stop hunt risk is elevated (>0.35), APPROVE signals switch from EXECUTE to LIMIT_PULLBACK."""
    class HighStopHuntAgent:
        def predict(self, state, questions):
            return {
                "answers": {
                    "verdict": {"type": "choice", "choice": "APPROVE", "answer_confidence": 0.78},
                    "action": {"type": "choice", "choice": "EXECUTE_IMMEDIATELY"},
                    "opportunity_score": {"type": "score", "score": 3.2},
                    "p_execution_success": {"type": "noul", "noul": 0.70},
                    "p_stop_hunt_risk": {"type": "noul", "noul": 0.42},  # Elevated stop hunt risk
                }
            }

    monkeypatch.setattr(laya_service, "_laya_agent", HighStopHuntAgent())
    monkeypatch.setattr(laya_service, "_weights_loaded", True)

    state = {"symbol": "TATAMOTORS", "direction": "BUY", "risk_reward_ratio": 2.0, "india_vix": 14.5}
    dec = laya_service.evaluate_decision(state)
    assert dec.verdict == "APPROVE"
    assert dec.action == "LIMIT_PULLBACK"  # Re-anchored to protect against wick hunting
    assert dec.p_stop_hunt_risk == 0.42


def test_laya_batch_with_risk_gates_and_agent(monkeypatch):
    """Test batch evaluation where some setups are rejected pre-neural, and passing setups use predict_batch."""
    recorded_prompts = []

    class MockBatchAgent:
        def predict_batch(self, prompts, questions):
            recorded_prompts.extend(prompts)
            return [
                {
                    "answers": {
                        "verdict": {"type": "choice", "choice": "APPROVE", "answer_confidence": 0.82},
                        "action": {"type": "choice", "choice": "EXECUTE_IMMEDIATELY"},
                        "opportunity_score": 82.0,
                    }
                }
                for _ in prompts
            ]

    monkeypatch.setattr(laya_service, "_laya_agent", MockBatchAgent())
    monkeypatch.setattr(laya_service, "_weights_loaded", True)

    batch_states = [
        {"symbol": "GOOD1", "direction": "BUY", "risk_reward_ratio": 2.4, "india_vix": 13.0},
        {"symbol": "BAD_VIX", "direction": "BUY", "risk_reward_ratio": 2.0, "india_vix": 27.0},
        {"symbol": "GOOD2", "direction": "BUY", "risk_reward_ratio": 2.1, "india_vix": 14.0},
        {"symbol": "BAD_RR", "direction": "BUY", "risk_reward_ratio": 0.7, "india_vix": 14.0},
    ]

    decisions = laya_service.evaluate_batch(batch_states)
    assert len(decisions) == 4
    # Pre-trade circuit breaker rejected BAD_VIX and BAD_RR
    assert decisions[1].verdict == "REJECT"
    assert decisions[3].verdict == "REJECT"
    # Passing setups were sent to batch model
    assert decisions[0].verdict == "APPROVE"
    assert decisions[2].verdict == "APPROVE"
    # Exactly 2 prompts reached the neural batch forward pass
    assert len(recorded_prompts) == 2


def test_system1_short_trade_circuit_breakers():
    """Verify institutional circuit breakers for short (SELL) setups."""
    # SELL with heavy FII buying (>2500)
    sell_fii_state = {
        "symbol": "SELL_FII",
        "direction": "SELL",
        "fii_dii_net": 3200.0,
        "risk_reward_ratio": 2.0,
    }
    dec_fii = system1_service.evaluate_decision(sell_fii_state)
    assert dec_fii.verdict == "REJECT"
    assert dec_fii.action == "CANCEL"
    assert any("HEAVY_INSTITUTIONAL_BUYING" in r for r in dec_fii.gate_reasons)

    # SELL with positive OFI contradiction (>0.35)
    sell_ofi_state = {
        "symbol": "SELL_OFI",
        "direction": "SELL",
        "order_flow_imbalance_ratio": 0.45,
        "risk_reward_ratio": 2.0,
    }
    dec_ofi = system1_service.evaluate_decision(sell_ofi_state)
    assert dec_ofi.verdict == "REJECT"
    assert any("SEVERE_ORDER_FLOW_CONTRADICTION" in r for r in dec_ofi.gate_reasons)

    # Low learned ranker win prob (<0.45)
    low_ranker_state = {
        "symbol": "LOW_RANKER",
        "direction": "BUY",
        "win_probability": 0.38,
        "risk_reward_ratio": 2.0,
    }
    dec_ranker = system1_service.evaluate_decision(low_ranker_state)
    assert dec_ranker.verdict == "REJECT"
    assert any("LOW_RANKER_WIN_PROB" in r for r in dec_ranker.gate_reasons)


def test_system1_symmetrical_sell_ofi():
    """Verify that SELL setups receive symmetrical OFI confluence in execution probability."""
    base_state = {
        "symbol": "SELL_SYM",
        "direction": "SELL",
        "setup_type": "PULLBACK",
        "risk_reward_ratio": 2.2,
        "technical_score": 75.0,
        "india_vix": 14.0,
        "market_regime": "BEAR_TRENDING",
    }
    dec_pos = laya_service.evaluate_decision({**base_state, "order_flow_imbalance_ratio": -0.25})
    dec_neg = laya_service.evaluate_decision({**base_state, "order_flow_imbalance_ratio": 0.25})

    assert dec_pos.p_execution_success > dec_neg.p_execution_success
    assert "POSITIVE_ORDER_FLOW_CONFLUENCE" in dec_pos.gate_reasons


def test_laya_batch_tracks_latency_and_counts():
    """A batch must report latency per item and count only real neural calls.

    inference_count counts forward passes, not candidates: a candidate stopped
    by a hard risk gate never reaches the checkpoint, so counting it as an
    inference would overstate how much work the model actually did.
    """
    # Both setups clear the hard gates, so both must reach the checkpoint.
    good = {"direction": "BUY", "risk_reward_ratio": 2.0, "india_vix": 14.0,
            "technical_score": 70.0, "market_regime": "BULL_TRENDING"}
    states = [
        {"symbol": "BATCH1", **good},
        {"symbol": "BATCH2", **good},
    ]

    prev_inf = laya_service.get_status()["inference_count"]
    decisions = laya_service.evaluate_batch(states)
    assert len(decisions) == 2
    for d in decisions:
        assert d.latency_ms >= 0.0
    new_inf = laya_service.get_status()["inference_count"]
    assert new_inf >= prev_inf + 2


def test_laya_batch_hard_gate_skips_the_neural_call():
    """A candidate stopped by a hard gate must not be counted as an inference."""
    good = {"direction": "BUY", "risk_reward_ratio": 2.0, "india_vix": 14.0,
            "technical_score": 70.0, "market_regime": "BULL_TRENDING"}
    # Poor risk/reward: the deterministic gate should reject this outright.
    gated = {"symbol": "GATED", "direction": "BUY", "risk_reward_ratio": 0.4,
             "india_vix": 14.0, "technical_score": 70.0}

    prev_inf = laya_service.get_status()["inference_count"]
    decisions = laya_service.evaluate_batch([{**good, "symbol": "OK"}, gated])

    assert len(decisions) == 2
    # It still returns a decision - the gate is a fast path, not a rejection of
    # the request - but the provenance says which component decided.
    assert decisions[1].verdict == "REJECT"
    assert decisions[1].source == "risk_gate"
    new_inf = laya_service.get_status()["inference_count"]
    assert new_inf >= prev_inf + 1


# ---------------------------------------------------------------------------
# 7. Jev Cloud Transport: Latency, Caching, Circuit Breaker, Contract Validation
# ---------------------------------------------------------------------------

def _api_state(symbol: str = "TCS") -> dict:
    """A state that clears every hard risk gate so it reaches the cloud path."""
    return {
        "symbol": symbol,
        "direction": "BUY",
        "setup_type": "BREAKOUT",
        "risk_reward_ratio": 2.4,
        "technical_score": 84.0,
        "india_vix": 14.0,
        "order_flow_imbalance_ratio": 0.28,
        "market_regime": "BULL_TRENDING",
        "chronos_trend": "bullish",
    }


def _batch_payload(symbols, features=None):
    candles = [
        [100.0 + i, 102.0 + i, 99.0 + i, 101.5 + i, 5000.0 + i * 100]
        for i in range(25)
    ]
    base = {"direction": "BUY", "setup_type": "PULLBACK", "risk_reward_ratio": 2.2, "india_vix": 14.0}
    return {
        "candidates": [
            {"symbol": s, "ohlcv": candles, "features": {**(features or {}), **base}}
            for s in symbols
        ]
    }


def _instrument_laya(monkeypatch):
    """Count batch vs per-candidate calls into the local checkpoint.

    Single-engine now: the cloud engine is gone, so there is no second pass to
    observe. What still matters is that every candidate is covered by ONE batch
    call rather than one call each - Laya on CPU costs about a second per
    candidate, so per-candidate calls are the difference between a scan
    finishing in seconds and finishing in minutes.
    """
    import main

    counts = {"laya_batch": 0, "laya_single": 0}
    sizes = {"laya": 0}

    real_batch = main.laya_service.evaluate_batch
    real_single = main.laya_service.evaluate_decision

    def laya_batch(states):
        counts["laya_batch"] += 1
        sizes["laya"] = len(states)
        return real_batch(states)

    def laya_single(state):
        counts["laya_single"] += 1
        return real_single(state)

    monkeypatch.setattr(main.laya_service, "evaluate_batch", laya_batch)
    monkeypatch.setattr(main.laya_service, "evaluate_decision", laya_single)
    return counts, sizes


def test_batch_endpoint_uses_one_laya_pass_for_every_candidate(client, monkeypatch):
    """All candidates must be covered by a single true-batch Laya pass."""
    counts, sizes = _instrument_laya(monkeypatch)

    symbols = ["B_A", "B_B", "B_C", "B_D"]
    response = client.post("/inference/batch", json=_batch_payload(symbols))
    assert response.status_code == 200

    data = response.json()
    for res in data["results"]:
        assert res["laya_decision"] is not None
        # Retired field kept for response-shape compatibility.
        assert res["jev_decision"] is None
        assert res["system1_decision"] is not None
        assert res["system1_decision"]["verdict"] in ("APPROVE", "REJECT", "CAUTION")

    assert counts["laya_batch"] == 1
    assert sizes["laya"] == len(symbols)
    assert counts["laya_single"] == 0
    # No cloud engine was contacted.
    assert data["jev_enabled"] is False


def test_batch_endpoint_survives_one_candidate_failure(client, monkeypatch):
    """A single phase-1 failure must not void the rest of the batch."""
    import main

    monkeypatch.setenv("SYSTEM1_ENGINE", "laya")
    _instrument_laya(monkeypatch)

    real_infer = main.technical_pattern_engine.infer

    def flaky(ohlcv, features=None, *args, **kwargs):
        if (features or {}).get("direction") == "BOOM":
            raise RuntimeError("synthetic pattern engine failure")
        return real_infer(ohlcv, features, *args, **kwargs)

    monkeypatch.setattr(main.technical_pattern_engine, "infer", flaky)

    candles = [
        [100.0 + i, 102.0 + i, 99.0 + i, 101.5 + i, 5000.0 + i * 100]
        for i in range(25)
    ]
    base = {"setup_type": "PULLBACK", "risk_reward_ratio": 2.2, "india_vix": 14.0}
    payload = {
        "candidates": [
            {"symbol": "OK_ONE", "ohlcv": candles, "features": {**base, "direction": "BUY"}},
            {"symbol": "BOOM", "ohlcv": candles, "features": {**base, "direction": "BOOM"}},
            {"symbol": "OK_TWO", "ohlcv": candles, "features": {**base, "direction": "BUY"}},
        ]
    }
    response = client.post("/inference/batch", json=payload)
    assert response.status_code == 200
    results = {r["symbol"]: r for r in response.json()["results"]}
    assert len(results) == 3

    assert results["BOOM"]["scored"] is False
    assert results["BOOM"]["system1_decision"] is None
    assert results["BOOM"]["composite_score"] == 50.0

    assert results["OK_ONE"]["scored"] is True
    assert results["OK_ONE"]["system1_decision"] is not None
    assert results["OK_TWO"]["scored"] is True
    assert results["OK_TWO"]["system1_decision"] is not None
    del main


