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


def _scaled(value: Any, divisor: float, default: float) -> float:
    """
    Divide by `divisor`, substituting `default` for anything non-finite.

    `bool(nan)` is True, so the previous `x / d if x else default` guards were
    ineffective for NaN. A non-finite observation makes the PPO policy emit a
    confident STRONG_SELL (argmax of an all-NaN logit vector is index 0) and
    returns confidence=NaN, which crashes response serialization because FastAPI
    renders with allow_nan=False.
    """
    try:
        f = float(value)
    except (TypeError, ValueError):
        return default
    if not np.isfinite(f):
        return default
    return f / divisor


class RLAgentService:
    def __init__(self):
        self.model = None
        self.is_loaded = False
        # Distinguishes "no model trained yet" (expected on a fresh install -
        # RL trains on closed paper trades, of which there are none) from
        # "the model exists but failed to load" (a real fault). Set in the
        # except branch below.
        self.cold_start = True

        if not _SB3_AVAILABLE:
            return

        model_path = os.getenv("RL_MODEL_PATH", os.path.join(os.path.dirname(__file__), "..", "rl_model.zip"))

        if os.path.exists(model_path):
            try:
                self.model = PPO.load(model_path)
                self.is_loaded = True
                self.cold_start = False
                logger.info(f"Successfully loaded RL model from {model_path}")
            except Exception as e:
                # The artifact is present but unusable: a genuine failure, so it
                # must not be excused as a cold start.
                self.cold_start = False
                logger.error(f"Failed to load RL model: {e}")
        else:
            logger.info(f"RL model not found at {model_path}. Using fallback/mock mode until trained.")

    def get_status(self) -> Dict[str, Any]:
        """Return runtime status without exposing the model object."""
        model_path = os.getenv("RL_MODEL_PATH", os.path.join(os.path.dirname(__file__), "..", "rl_model.zip"))
        return {
            "model": "stable-baselines3-ppo",
            "policy": "MlpPolicy",
            "artifact_path": model_path,
            "artifact_present": os.path.exists(model_path),
            "loaded": self.is_loaded,
            "healthy": self.is_loaded,
            "fallback_active": not self.is_loaded,
        }

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
        # PCR is frozen to the training constant: train_rl.py has no historical
        # options data and hardcodes pcr=1.0 for every sample, so the policy
        # never learned this axis. Feeding live PCR here would push the
        # observation into an untrained input region and inject noise.
        # Revisit when training data carries real PCR variation.
        pcr = 1.0
        
        # In a real scenario, these must be normalized using the exact same scaler used during training.
        # This is a naive normalization for demonstration.
        #
        # EVERY component is coerced to a finite float. `if close` is True for NaN
        # (bool(nan) is True), so the previous guards let NaN through; the policy
        # then received an all-NaN observation, `np.argmax` returned 0, and the
        # service emitted a confident "STRONG_SELL" with confidence=NaN — which
        # additionally crashed response serialization, because FastAPI renders
        # with allow_nan=False and this endpoint declares no response_model.
        state = np.array([
            _scaled(close, 10000.0, 0.0),
            _scaled(volume, 1000000.0, 0.0),
            _scaled(rsi, 100.0, 0.5),
            _scaled(macd, 100.0, 0.0),
            _scaled(vix, 50.0, 0.3),
            _scaled(fii, 10000.0, 0.0),
            _scaled(pcr, 3.0, 0.33),
        ], dtype=np.float32)

        # Final guard: the policy must never see a non-finite observation.
        if not np.all(np.isfinite(state)):
            state = np.nan_to_num(state, nan=0.0, posinf=1.0, neginf=-1.0).astype(np.float32)

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
                p = float(probs[action_idx])
                # Clamp: a non-finite probability here would 500 the response,
                # since this endpoint declares no response_model and FastAPI
                # serializes with allow_nan=False.
                if not np.isfinite(p):
                    return 0.5
                return min(1.0, max(0.0, p))
            return 0.5
        except Exception as e:
            logger.debug(f"Could not derive RL action probability, using neutral: {e}")
            return 0.5

rl_agent_service = RLAgentService()
