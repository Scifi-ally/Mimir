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

try:
    # Same indicator library/params used at training time (train_rl.py) so the
    # serving observation vector matches the training distribution exactly.
    from ta.momentum import RSIIndicator
    from ta.trend import MACD
    _TA_AVAILABLE = True
except ImportError:
    _TA_AVAILABLE = False
    logger.warning("`ta` not installed. RL RSI/MACD features cannot be reconstructed at serve time.")


def _ensure_rsi_macd(df: pd.DataFrame) -> pd.DataFrame:
    """Compute RSI(14) and MACD-diff into df if absent, using the identical
    `ta` calls train_rl.py uses. Without this the serving state would freeze
    RSI at 50 and MACD at 0 — an off-distribution input the policy never saw
    in training (train/serve skew)."""
    if "close" not in df.columns or len(df) == 0:
        return df
    if not _TA_AVAILABLE:
        return df
    if "rsi" not in df.columns:
        df = df.copy()
        df["rsi"] = RSIIndicator(close=df["close"], window=14).rsi()
    if "macd" not in df.columns:
        df["macd"] = MACD(close=df["close"]).macd_diff()
    return df

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

        # Reconstruct RSI/MACD from the candle series if the caller didn't
        # supply them, matching the training feature computation.
        df = _ensure_rsi_macd(df)
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
            # No model loaded (e.g. before user trains it) — return neutral
            # with zero confidence and a flag; never invent conviction.
            return {
                "action": "HOLD",
                "confidence": 0.0,
                "score_adjustment": 0.0,
                "isFallback": True,
                "source": "no_model"
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

            # Confidence = the policy's actual probability mass on the chosen
            # action, read from the PPO action distribution. This is the true
            # model conviction, not a constant derived from action extremeness
            # (which would report 1.0 even when the policy was nearly indifferent).
            confidence = self._action_probability(state, action_idx)

            return {
                "action": action_str,
                "confidence": confidence,
                "score_adjustment": score_adj,
                "source": "model"
            }
        except Exception as e:
            logger.error(f"RL prediction failed: {e}")
            return {
                "action": "HOLD",
                "confidence": 0.0,
                "score_adjustment": 0.0,
                "isFallback": True,
                "source": "error"
            }

    def _action_probability(self, state: np.ndarray, action_idx: int) -> float:
        """Return the policy's probability mass on `action_idx` from the PPO
        action distribution. Falls back to a neutral 0.5 if the SB3 internals
        aren't reachable, rather than fabricating conviction."""
        try:
            import torch
            obs_t, _ = self.model.policy.obs_to_tensor(state)
            with torch.no_grad():
                dist = self.model.policy.get_distribution(obs_t)
                probs = dist.distribution.probs.detach().cpu().numpy().ravel()
            if 0 <= action_idx < len(probs):
                return float(probs[action_idx])
            return 0.5
        except Exception as e:
            logger.debug(f"Could not derive RL action probability, using neutral: {e}")
            return 0.5

rl_agent_service = RLAgentService()
