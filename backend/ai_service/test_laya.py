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
from models.jev_service import jev_service, JevDecision
from models.system1_service import system1_service, System1Decision
from main import app


@pytest.fixture
def client():
    return TestClient(app)


# ---------------------------------------------------------------------------
# 1. Laya Service & Surrogate Unit Tests
# ---------------------------------------------------------------------------

def test_laya_service_status():
    status = laya_service.get_status()
    assert "model" in status
    assert status["model"] == "convaiinnovations/laya"
    assert status["loaded"] is True
    assert status["healthy"] is True
    assert "mode" in status
    assert status["architecture"] == "ModernBERT-large-RLCD"


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

def test_jev_service_status():
    status = jev_service.get_status()
    assert "model" in status
    assert status["model"] == "typesafe-jev-systemone"
    assert status["loaded"] is True
    assert status["healthy"] is True
    assert "mode" in status


def test_jev_local_surrogate():
    state = {
        "symbol": "TATAMOTORS",
        "direction": "BUY",
        "setup_type": "PULLBACK",
        "risk_reward_ratio": 2.2,
        "technical_score": 82.0,
        "india_vix": 14.0,
        "order_flow_imbalance_ratio": 0.25,
    }
    dec = jev_service.evaluate_decision(state)
    assert isinstance(dec, JevDecision)
    assert dec.verdict == "APPROVE"
    assert dec.confidence >= 0.65
    assert dec.position_size_multiplier >= 1.0


# ---------------------------------------------------------------------------
# 3. Unified System-1 Router & Consensus Tests
# ---------------------------------------------------------------------------

def test_system1_resolve_decision():
    state = {"symbol": "TEST", "direction": "BUY", "risk_reward_ratio": 2.0}
    laya_dec = laya_service.evaluate_decision(state)
    jev_dec = jev_service.evaluate_decision(state)

    # Route to laya
    sys_laya = system1_service.resolve_decision(laya_dec, jev_dec, preferred_engine="laya")
    assert sys_laya.provider == "laya"
    assert sys_laya.verdict == laya_dec.verdict

    # Route to jev
    sys_jev = system1_service.resolve_decision(laya_dec, jev_dec, preferred_engine="jev")
    assert sys_jev.provider == "jev"
    assert sys_jev.verdict == jev_dec.verdict


def test_system1_router_routing():
    status = system1_service.get_status()
    assert "default_engine" in status
    assert "laya" in status
    assert "jev" in status
    assert status["healthy"] is True

    state = {
        "symbol": "TATASTEEL",
        "direction": "BUY",
        "risk_reward_ratio": 2.0,
        "technical_score": 75.0,
        "india_vix": 14.0,
    }

    # Test route to Laya
    dec_laya = system1_service.evaluate_decision(state, engine="laya")
    assert dec_laya.provider == "laya"
    assert dec_laya.verdict in ("APPROVE", "CAUTION")

    # Test route to Jev
    dec_jev = system1_service.evaluate_decision(state, engine="jev")
    assert dec_jev.provider == "jev"
    assert dec_jev.verdict in ("APPROVE", "CAUTION")


# ---------------------------------------------------------------------------
# 4. FastAPI Endpoint Tests
# ---------------------------------------------------------------------------

def test_api_health_includes_laya_and_system1(client):
    response = client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert "laya" in data["models"]
    assert "system1" in data["models"]
    assert "jev" in data["models"]
    assert "lara" not in data["models"]
    assert data["models"]["laya"]["healthy"] is True
    assert data["models"]["system1"]["healthy"] is True


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


def test_api_jev_endpoint(client):
    req_body = {
        "symbol": "WIPRO",
        "direction": "BUY",
        "setup_type": "PULLBACK",
        "risk_reward_ratio": 2.1,
        "technical_score": 78.0,
        "india_vix": 14.0,
    }
    response = client.post("/inference/jev", json=req_body)
    assert response.status_code == 200
    data = response.json()
    assert data["verdict"] in ("APPROVE", "CAUTION", "REJECT")
    assert data["provider"] == "jev"
    assert "position_size_multiplier" in data


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


def test_jev_hard_risk_gates_precheck(monkeypatch):
    """Verify that JevService checks hard risk gates before attempting an API call."""
    api_called = False

    def mock_call_typesafe_api(state):
        nonlocal api_called
        api_called = True
        return None

    monkeypatch.setattr(jev_service, "_call_typesafe_api", mock_call_typesafe_api)
    monkeypatch.setattr(jev_service, "_api_key", "mock-key")
    monkeypatch.setattr(jev_service, "_enabled", True)

    toxic_vix_state = {
        "symbol": "VIX_REJECT",
        "direction": "BUY",
        "india_vix": 26.5,
        "risk_reward_ratio": 2.0,
    }
    decision = jev_service.evaluate_decision(toxic_vix_state)
    assert decision.verdict == "REJECT"
    assert decision.action == "CANCEL"
    assert any("VIX" in r for r in decision.gate_reasons)
    assert api_called is False  # API was bypassed by pre-trade circuit breaker!


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


def test_batch_inference_zero_overhead_default_engine(client, monkeypatch):
    """Verify that default engine (laya) avoids unnecessary calls to jev_service."""
    import main

    jev_called = False
    original_jev_eval = main.jev_service.evaluate_decision

    def instrumented_jev(state):
        nonlocal jev_called
        jev_called = True
        return original_jev_eval(state)

    monkeypatch.setattr(main.jev_service, "evaluate_decision", instrumented_jev)

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
                "symbol": "TCS",
                "ohlcv": candles,
                "features": {
                    "direction": "BUY",
                    "risk_reward_ratio": 2.2,
                    "india_vix": 14.0,
                },
            }
        ]
    }
    response = client.post("/inference/batch", json=batch_req)
    assert response.status_code == 200
    data = response.json()
    cand_res = data["results"][0]
    assert cand_res["laya_decision"] is not None
    assert cand_res["system1_decision"] is not None
    assert cand_res["jev_decision"] is None
    assert jev_called is False  # Zero overhead: JEV was not invoked


def test_laya_batch_tracks_latency_and_counts():
    """Verify that evaluate_batch records call counts and per-item latency."""
    prev_inf = laya_service.get_status()["inference_count"]
    states = [
        {"symbol": "BATCH1", "direction": "BUY", "risk_reward_ratio": 2.0, "india_vix": 14.0},
        {"symbol": "BATCH2", "direction": "BUY", "risk_reward_ratio": 0.8, "india_vix": 14.0},
    ]
    decisions = laya_service.evaluate_batch(states)
    assert len(decisions) == 2
    for d in decisions:
        assert d.latency_ms >= 0.0
    new_inf = laya_service.get_status()["inference_count"]
    assert new_inf >= prev_inf + 2


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


def _fake_api(responses, calls):
    """Build a stand-in for JevService._call_typesafe_api with a scripted reply."""
    def _call(state):
        calls.append(dict(state))
        results = responses[min(len(calls) - 1, len(responses) - 1)]
        if results is None:
            return None
        return jev_service._parse_response({"results": results}, state)
    return _call


def _force_cloud_mode(monkeypatch):
    """Pretend a TypeSafe key is configured and the cache/breaker are cold."""
    monkeypatch.setattr(jev_service, "_api_key", "test-key", raising=False)
    monkeypatch.setattr(jev_service, "_enabled", True, raising=False)
    monkeypatch.setattr(jev_service, "_cache_ttl_s", 0.0, raising=False)
    monkeypatch.setattr(jev_service, "_cache", {}, raising=False)
    monkeypatch.setattr(jev_service, "_fail_streak", 0, raising=False)
    monkeypatch.setattr(jev_service, "_breaker_open_until", 0.0, raising=False)


def test_jev_api_uses_returned_noul_not_verdict_constants(monkeypatch):
    """Noul probabilities must come from the model, not a verdict lookup table."""
    _force_cloud_mode(monkeypatch)
    calls: list = []
    monkeypatch.setattr(
        jev_service,
        "_call_typesafe_api",
        _fake_api(
            [
                {
                    "verdict": "APPROVE",
                    "action": "EXECUTE_IMMEDIATELY",
                    "confidence": 0.86,
                    "opportunity_score": 88.0,
                    "regime_alignment": 0.8,
                    "p_execution_success": 0.91,
                    "p_stop_hunt_risk": 0.06,
                    "p_adverse_regime_shift": 0.04,
                }
            ],
            calls,
        ),
    )

    dec = jev_service.evaluate_decision(_api_state())
    assert dec.source == "typesafe_api"
    assert dec.provider == "jev"
    assert dec.verdict == "APPROVE"
    assert dec.p_execution_success == 0.91
    assert dec.p_stop_hunt_risk == 0.06
    assert dec.p_adverse_regime_shift == 0.04
    assert dec.position_size_multiplier == 1.25


def test_jev_api_noul_falls_back_to_calibrated_surrogate(monkeypatch):
    """When the API omits Noul, use the local RLCD calibration, not constants."""
    _force_cloud_mode(monkeypatch)
    calls: list = []
    adverse = {**_api_state(), "india_vix": 23.0, "order_flow_imbalance_ratio": -0.30}
    monkeypatch.setattr(
        jev_service,
        "_call_typesafe_api",
        _fake_api([{"verdict": "APPROVE", "confidence": 0.85}], calls),
    )

    dec = jev_service.evaluate_decision(adverse)
    prior = jev_service._evaluate_local_surrogate(adverse, check_gates=False)
    assert dec.p_stop_hunt_risk == prior.p_stop_hunt_risk
    assert dec.p_adverse_regime_shift == prior.p_adverse_regime_shift
    # A hostile VIX/OFI backdrop must not be scored as a clean 0.15 stop-hunt risk.
    assert dec.p_stop_hunt_risk > 0.15


def test_jev_api_response_schema_violation_falls_back(monkeypatch):
    """A garbled verdict must never be passed through to the signal router."""
    _force_cloud_mode(monkeypatch)
    state = _api_state("SCHEMA")
    malformed_bodies = [
        {},                                        # no results envelope
        {"results": "APPROVE"},                    # results is not an object
        {"results": {}},                           # no verdict key
        {"results": {"verdict": ""}},              # blank verdict
        {"results": {"verdict": "MAYBE_BUY"}},     # verdict outside the contract
        {"results": {"verdict": 7}},               # verdict is not a label at all
    ]
    for body in malformed_bodies:
        assert jev_service._parse_response(body, state) is None, body

    # And the service degrades to the local surrogate rather than guessing.
    calls: list = []
    monkeypatch.setattr(jev_service, "_call_typesafe_api", _fake_api([None], calls))
    dec = jev_service.evaluate_decision(state)
    assert dec.source == "local_surrogate"
    assert dec.verdict in ("APPROVE", "REJECT", "CAUTION")


def test_jev_api_rejects_incoherent_verdict_action_pair(monkeypatch):
    """REJECT + EXECUTE_IMMEDIATELY must be repaired to a fail-closed pair."""
    _force_cloud_mode(monkeypatch)
    calls: list = []
    monkeypatch.setattr(
        jev_service,
        "_call_typesafe_api",
        _fake_api(
            [
                {
                    "verdict": "REJECT",
                    "action": "EXECUTE_IMMEDIATELY",
                    "confidence": 0.9,
                    "p_stop_hunt_risk": 0.8,
                }
            ],
            calls,
        ),
    )
    dec = jev_service.evaluate_decision(_api_state())
    assert dec.verdict == "REJECT"
    assert dec.action == "CANCEL"
    assert dec.position_size_multiplier == 0.0


def test_jev_api_position_sizing_scales_down_on_risk(monkeypatch):
    """Elevated stop-hunt risk must reduce size even at high confidence."""
    _force_cloud_mode(monkeypatch)
    calls: list = []
    monkeypatch.setattr(
        jev_service,
        "_call_typesafe_api",
        _fake_api(
            [
                {
                    "verdict": "APPROVE",
                    "action": "EXECUTE_IMMEDIATELY",
                    "confidence": 0.83,
                    "p_execution_success": 0.62,
                    "p_stop_hunt_risk": 0.55,
                    "p_adverse_regime_shift": 0.12,
                }
            ],
            calls,
        ),
    )
    dec = jev_service.evaluate_decision(_api_state())
    assert dec.verdict == "APPROVE"
    assert dec.position_size_multiplier == 0.85
    assert any("SCALED_DOWN" in r for r in dec.gate_reasons)


def test_jev_api_pools_confidence_with_ranker(monkeypatch):
    """Log-odds pooling pulls cloud confidence toward the learned ranker."""
    _force_cloud_mode(monkeypatch)
    calls: list = []
    monkeypatch.setattr(
        jev_service,
        "_call_typesafe_api",
        _fake_api([{"verdict": "APPROVE", "confidence": 0.95}], calls),
    )
    dec = jev_service.evaluate_decision({**_api_state(), "win_probability": 0.55})
    assert dec.confidence < 0.95
    assert dec.confidence > 0.55
    assert any("RANKER_JEV_CONFIDENCE_POOLED" in r for r in dec.gate_reasons)


def test_jev_decision_cache_avoids_repeat_api_calls(monkeypatch):
    """An unchanged market state is served locally on the second tick."""
    _force_cloud_mode(monkeypatch)
    monkeypatch.setattr(jev_service, "_cache_ttl_s", 30.0, raising=False)
    calls: list = []
    monkeypatch.setattr(
        jev_service,
        "_call_typesafe_api",
        _fake_api([{"verdict": "APPROVE", "confidence": 0.82}], calls),
    )

    state = _api_state("CACHE_HIT")
    first = jev_service.evaluate_decision(state)
    assert first.source == "typesafe_api"
    second = jev_service.evaluate_decision(state)
    assert second.source == "typesafe_api"
    assert len(calls) == 1  # Second call short-circuited on the cached decision
    assert second.confidence == first.confidence


def test_jev_circuit_breaker_opens_and_short_circuits(monkeypatch):
    """Consecutive cloud failures must stop costing a timeout per candidate."""
    _force_cloud_mode(monkeypatch)
    monkeypatch.setattr(jev_service, "_breaker_failures", 3, raising=False)

    def _boom(state):
        jev_service._record_api_failure("synthetic")
        return None

    monkeypatch.setattr(jev_service, "_call_typesafe_api", _boom)
    jev_service._fail_streak = 0
    jev_service._breaker_open_until = 0.0

    for _ in range(3):
        assert jev_service.evaluate_decision(_api_state("BRK")).source == "local_surrogate"

    assert jev_service.get_status()["circuit_state"] == "open"
    assert jev_service.get_status()["healthy"] is False

    # Now every further candidate resolves locally with no cloud attempt at all.
    attempts = {"n": 0}

    def _counted(state):
        attempts["n"] += 1
        return None

    monkeypatch.setattr(jev_service, "_call_typesafe_api", _counted)
    dec = jev_service.evaluate_decision(_api_state("BRK2"))
    assert dec.source == "local_surrogate"
    assert attempts["n"] == 0
    assert jev_service.get_status()["short_circuit_count"] > 0

    # After the cooldown the breaker half-opens and probes again.
    jev_service._breaker_open_until = 0.0
    jev_service.evaluate_decision(_api_state("BRK3"))
    assert attempts["n"] == 1


def test_jev_batch_resolves_all_items_and_skips_gated(monkeypatch):
    """Batch must return one decision per state, with toxic states gated locally."""
    _force_cloud_mode(monkeypatch)
    calls: list = []
    monkeypatch.setattr(
        jev_service,
        "_call_typesafe_api",
        _fake_api([{"verdict": "APPROVE", "confidence": 0.81}], calls),
    )

    states = [
        _api_state("B_A"),
        _api_state("B_B"),
        {**_api_state("B_TOXIC"), "india_vix": 27.0},  # hard-gated, no cloud call
        {**_api_state("B_BADRR"), "risk_reward_ratio": 0.5},
    ]
    decisions = jev_service.evaluate_batch(states)

    assert len(decisions) == 4
    assert decisions[2].verdict == "REJECT" and decisions[2].action == "CANCEL"
    assert decisions[3].verdict == "REJECT"
    assert all(d.source == "typesafe_api" for d in decisions[:2])
    assert len(calls) == 2  # Only the two clean states reached the network
    assert all(d.latency_ms >= 0.0 for d in decisions)


def test_jev_batch_empty_and_single_item(monkeypatch):
    _force_cloud_mode(monkeypatch)
    assert jev_service.evaluate_batch([]) == []
    single = jev_service.evaluate_batch([_api_state("B_SINGLE")])
    assert len(single) == 1
    assert single[0].verdict in ("APPROVE", "REJECT", "CAUTION")


def test_jev_surrogate_decisions_are_memoized(monkeypatch):
    """
    With no API key the surrogate answers every call — it must still be cached.

    The surrogate is a pure function of the state, so the scanner's repeated
    evaluation of an unchanged symbol should not recompute it each tick.
    """
    _force_cloud_mode(monkeypatch)
    monkeypatch.setattr(jev_service, "_api_key", None, raising=False)
    monkeypatch.setattr(jev_service, "_cache_ttl_s", 30.0, raising=False)

    state = _api_state("SURROGATE_MEMO")
    first = jev_service.evaluate_decision(state)
    assert first.source == "local_surrogate"

    before = jev_service.get_status()["surrogate_call_count"]
    second = jev_service.evaluate_decision(state)
    after = jev_service.get_status()["surrogate_call_count"]

    assert second.source == "local_surrogate"
    assert second.verdict == first.verdict
    assert second.p_stop_hunt_risk == first.p_stop_hunt_risk
    # The second call was served from cache, so no new surrogate work happened.
    assert after == before
    assert jev_service.get_status()["cache_hit_count"] > 0


def test_jev_batch_memoizes_surrogate_and_does_not_pollute_breaker_telemetry(monkeypatch):
    """
    Unconfigured API must not be counted as a circuit-breaker short circuit.

    Those are different conditions: "no key" is a steady state, while a short
    circuit means the cloud is configured but known-down. Conflating them makes
    the health telemetry lie during normal operation.
    """
    _force_cloud_mode(monkeypatch)
    monkeypatch.setattr(jev_service, "_api_key", None, raising=False)
    monkeypatch.setattr(jev_service, "_cache_ttl_s", 0.0, raising=False)

    # These counters are process-global on the singleton, so assert on deltas.
    before_sc = jev_service.get_status()["short_circuit_count"]
    before_sur = jev_service.get_status()["surrogate_call_count"]

    states = [_api_state(f"UNCONN{i}") for i in range(4)]
    decisions = jev_service.evaluate_batch(states)
    assert len(decisions) == 4

    status = jev_service.get_status()
    assert status["api_key_configured"] is False
    assert status["short_circuit_count"] == before_sc
    assert status["circuit_state"] == "closed"
    assert status["surrogate_call_count"] == before_sur + 4



# ---------------------------------------------------------------------------
# 8. Batch Endpoint: System-1 must run as ONE true-batch pass, not per candidate
# ---------------------------------------------------------------------------

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


def _instrument_both_engines(monkeypatch):
    """Count batch vs per-candidate calls into Laya and Jev."""
    import main

    counts = {"laya_batch": 0, "jev_batch": 0, "laya_single": 0, "jev_single": 0}
    sizes = {"laya": 0, "jev": 0}

    real = {
        "laya_batch": main.laya_service.evaluate_batch,
        "jev_batch": main.jev_service.evaluate_batch,
        "laya_single": main.laya_service.evaluate_decision,
        "jev_single": main.jev_service.evaluate_decision,
    }

    def laya_batch(states):
        counts["laya_batch"] += 1
        sizes["laya"] = len(states)
        return real["laya_batch"](states)

    def jev_batch(states):
        counts["jev_batch"] += 1
        sizes["jev"] = len(states)
        return real["jev_batch"](states)

    def laya_single(state):
        counts["laya_single"] += 1
        return real["laya_single"](state)

    def jev_single(state):
        counts["jev_single"] += 1
        return real["jev_single"](state)

    monkeypatch.setattr(main.laya_service, "evaluate_batch", laya_batch)
    monkeypatch.setattr(main.jev_service, "evaluate_batch", jev_batch)
    monkeypatch.setattr(main.laya_service, "evaluate_decision", laya_single)
    monkeypatch.setattr(main.jev_service, "evaluate_decision", jev_single)

    async def mock_sentiment(symbol):
        return {"symbol_specific_score": 0.5, "market_wide_score": 0.0, "world_score": 0.0, "composite": 0.5}

    monkeypatch.setattr(main, "analyze_sentiment", mock_sentiment)
    return counts, sizes


def test_batch_endpoint_batches_jev_in_one_call(client, monkeypatch):
    """SYSTEM1_ENGINE=jev must issue exactly ONE batched call for N candidates."""
    import main

    monkeypatch.setenv("SYSTEM1_ENGINE", "jev")
    counts, sizes = _instrument_both_engines(monkeypatch)

    symbols = ["BATCH_A", "BATCH_B", "BATCH_C", "BATCH_D"]
    response = client.post("/inference/batch", json=_batch_payload(symbols))
    assert response.status_code == 200

    data = response.json()
    assert len(data["results"]) == 4
    for res in data["results"]:
        assert res["system1_decision"] is not None
        assert res["jev_decision"] is not None
        assert res["laya_decision"] is None  # zero overhead for the unused engine

    assert counts["jev_batch"] == 1, "Jev was not batched"
    assert sizes["jev"] == 4
    assert counts["jev_single"] == 0, "per-candidate Jev calls must not happen"
    assert counts["laya_batch"] == 0 and counts["laya_single"] == 0
    del main


def test_batch_endpoint_batches_both_engines_for_consensus(client, monkeypatch):
    """Consensus must run one Laya pass and one Jev pass, then resolve."""
    monkeypatch.setenv("SYSTEM1_ENGINE", "consensus")
    counts, sizes = _instrument_both_engines(monkeypatch)

    symbols = ["CONS_A", "CONS_B", "CONS_C"]
    response = client.post("/inference/batch", json=_batch_payload(symbols))
    assert response.status_code == 200

    data = response.json()
    for res in data["results"]:
        assert res["laya_decision"] is not None
        assert res["jev_decision"] is not None
        assert res["system1_decision"] is not None
        assert res["system1_decision"]["verdict"] in ("APPROVE", "REJECT", "CAUTION")

    assert counts["laya_batch"] == 1 and sizes["laya"] == 3
    assert counts["jev_batch"] == 1 and sizes["jev"] == 3
    assert counts["laya_single"] == 0 and counts["jev_single"] == 0


def test_batch_endpoint_routes_per_candidate_preferred_engine(client, monkeypatch):
    """A mixed-engine batch must still give each candidate the engine it asked for."""
    import main

    monkeypatch.setenv("SYSTEM1_ENGINE", "laya")
    counts, _ = _instrument_both_engines(monkeypatch)

    candles = [
        [100.0 + i, 102.0 + i, 99.0 + i, 101.5 + i, 5000.0 + i * 100]
        for i in range(25)
    ]
    base = {"direction": "BUY", "setup_type": "PULLBACK", "risk_reward_ratio": 2.2, "india_vix": 14.0}
    payload = {
        "candidates": [
            {"symbol": "MIX_LAYA", "ohlcv": candles, "features": {**base, "preferred_engine": "laya"}},
            {"symbol": "MIX_JEV", "ohlcv": candles, "features": {**base, "preferred_engine": "jev"}},
            {"symbol": "MIX_CONS", "ohlcv": candles, "features": {**base, "preferred_engine": "consensus"}},
        ]
    }
    response = client.post("/inference/batch", json=payload)
    assert response.status_code == 200
    results = {r["symbol"]: r for r in response.json()["results"]}

    assert results["MIX_LAYA"]["laya_decision"] is not None
    assert results["MIX_LAYA"]["jev_decision"] is None

    assert results["MIX_JEV"]["jev_decision"] is not None
    assert results["MIX_JEV"]["laya_decision"] is None

    assert results["MIX_CONS"]["laya_decision"] is not None
    assert results["MIX_CONS"]["jev_decision"] is not None

    # 2 laya-routed + 1 consensus, and 1 jev-routed + 1 consensus.
    assert counts["laya_batch"] == 1 and counts["jev_batch"] == 1
    assert counts["laya_single"] == 0 and counts["jev_single"] == 0
    del main


def test_batch_endpoint_survives_one_candidate_failure(client, monkeypatch):
    """A single phase-1 failure must not void the rest of the batch."""
    import main

    monkeypatch.setenv("SYSTEM1_ENGINE", "laya")
    _instrument_both_engines(monkeypatch)

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



