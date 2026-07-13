import os
import logging
import numpy as np
import pandas as pd
from typing import Dict, Any

logger = logging.getLogger("rl_agent")

try:
    from stable_baselines3 import PPO
    import gymnasium as gym
    _SB3_AVAILABLE = True
except ImportError:
    _SB3_AVAILABLE = False
    logger.warning("stable-baselines3 or gymnasium not installed. RL features will be disabled.")

class RLAgentService:
    def __init__(self):
        self.model = None
        self.is_loaded = False
        
        if not _SB3_AVAILABLE:
            return

        model_path = os.getenv("RL_MODEL_PATH", os.path.join(os.path.dirname(__file__), "..", "rl_model.zip"))
        
        if os.path.exists(model_path):
            try:
                self.model = PPO.load(model_path)
                self.is_loaded = True
                logger.info(f"Successfully loaded RL model from {model_path}")
            except Exception as e:
                logger.error(f"Failed to load RL model: {e}")
        else:
            logger.info(f"RL model not found at {model_path}. Using fallback/mock mode until trained.")

    def reload_model(self):
        """Reloads the model from disk (used after training)."""
        model_path = os.getenv("RL_MODEL_PATH", os.path.join(os.path.dirname(__file__), "..", "rl_model.zip"))
        if os.path.exists(model_path) and _SB3_AVAILABLE:
            try:
                self.model = PPO.load(model_path)
                self.is_loaded = True
                logger.info(f"Successfully reloaded RL model from {model_path}")
            except Exception as e:
                logger.error(f"Failed to reload RL model: {e}")

    def prepare_state(self, df: pd.DataFrame, macro_data: Dict[str, float] = None) -> np.ndarray:
        """
        Converts OHLCV, indicators, and macro data into the observation vector expected by the RL model.
        Assumes the model was trained on: [Close, Volume, RSI, MACD, VIX, FII, PCR] normalized.
        """
        if len(df) == 0:
            return np.zeros(7, dtype=np.float32)
            
        latest = df.iloc[-1]
        
        # Example features
        close = latest.get("close", 0.0)
        volume = latest.get("volume", 0.0)
        rsi = latest.get("rsi", 50.0)
        macd = latest.get("macd", 0.0)
        
        if macro_data is None:
            macro_data = {}
            
        vix = macro_data.get("vix", 15.0)
        fii = macro_data.get("fiiNet", 0.0)
        pcr = macro_data.get("pcr", 1.0)
        
        # In a real scenario, these must be normalized using the exact same scaler used during training.
        # This is a naive normalization for demonstration.
        state = np.array([
            close / 10000.0 if close else 0.0,
            volume / 1000000.0 if volume else 0.0,
            rsi / 100.0 if not pd.isna(rsi) else 0.5,
            macd / 100.0 if not pd.isna(macd) else 0.0,
            vix / 50.0 if not pd.isna(vix) else 0.3,
            fii / 10000.0 if not pd.isna(fii) else 0.0,
            pcr / 3.0 if not pd.isna(pcr) else 0.33,
        ], dtype=np.float32)
        
        return state

    def predict(self, df: pd.DataFrame, macro_data: Dict[str, float] = None) -> Dict[str, Any]:
        """
        Runs the RL model prediction.
        Returns discrete action and confidence.
        Action mapping:
        0: Strong Sell
        1: Sell
        2: Hold
        3: Buy
        4: Strong Buy
        """
        if not self.is_loaded or self.model is None:
            # Fallback when no model is loaded (e.g. before user trains it)
            return {
                "action": "HOLD",
                "confidence": 0.5,
                "score_adjustment": 0.0
            }
            
        state = self.prepare_state(df, macro_data)
        
        try:
            # deterministic=True for inference
            action, _states = self.model.predict(state, deterministic=True)
            
            # Map action to discrete output
            action_idx = int(action)
            action_map = {0: "STRONG_SELL", 1: "SELL", 2: "HOLD", 3: "BUY", 4: "STRONG_BUY"}
            action_str = action_map.get(action_idx, "HOLD")
            
            # Map to a score adjustment [-0.5 to +0.5]
            score_map = {0: -0.5, 1: -0.25, 2: 0.0, 3: 0.25, 4: 0.5}
            score_adj = score_map.get(action_idx, 0.0)
            
            # PPO doesn't output probabilities natively via predict(), 
            # we can approximate confidence based on action extremeness
            confidence = abs(score_adj) * 2.0  # 1.0 for Strong, 0.5 for normal, 0 for hold
            
            return {
                "action": action_str,
                "confidence": confidence,
                "score_adjustment": score_adj
            }
        except Exception as e:
            logger.error(f"RL prediction failed: {e}")
            return {
                "action": "HOLD",
                "confidence": 0.0,
                "score_adjustment": 0.0
            }

rl_agent_service = RLAgentService()
