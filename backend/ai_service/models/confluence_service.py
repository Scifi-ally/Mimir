import os
import joblib
import logging
import threading

import numpy as np

from .numeric_utils import finite_clamp, is_finite_number, sanitize_float

logger = logging.getLogger("confluence_service")

FEATURE_KEYS = [
    "tech_score",
    "pattern_score",
    "chronos_score",
    "rs_score",
    "sector_score",
    "sentiment_score",
]

FALLBACK_WEIGHTS = {
    "tech_score": 0.35,
    "pattern_score": 0.20,
    "chronos_score": 0.15,
    "rs_score": 0.10,
    "sector_score": 0.10,
    "sentiment_score": 0.10,
}

# Only re-scan the artifacts directory this often at most. Previously a missing
# directory or an all-failing load meant every single request re-ran os.listdir
# plus N failing joblib.load calls from disk.
_RELOAD_THROTTLE_S = 60.0


class ConfluenceService:
    def __init__(self):
        # `self.models` is only ever REPLACED under the lock, never mutated in
        # place, so readers always observe a consistent snapshot. Previously
        # `self.models = {}` could land between a reader's `in` check and its
        # `[]` read, raising KeyError -> a confident-looking 50.0 for a regime
        # that had actually been scored.
        self._lock = threading.Lock()
        self.models = {}
        self.models_dir = os.path.join(os.path.dirname(__file__), "..", "models", "confluence")
        self._load_attempted = False
        self._last_load_ts = 0.0
        self.load_models()

    def load_models(self, force: bool = False) -> None:
        """Rebuild the model snapshot atomically."""
        import time

        now = time.monotonic()
        with self._lock:
            if (
                not force
                and self._load_attempted
                and (now - self._last_load_ts) < _RELOAD_THROTTLE_S
            ):
                return
            self._load_attempted = True
            self._last_load_ts = now

        loaded = {}
        if os.path.isdir(self.models_dir):
            for f in sorted(os.listdir(self.models_dir)):
                if f.startswith("confluence_") and f.endswith(".pkl"):
                    regime = f.replace("confluence_", "").replace(".pkl", "")
                    path = os.path.join(self.models_dir, f)
                    try:
                        loaded[regime] = joblib.load(path)
                    except Exception as e:
                        logger.error(f"Failed to load confluence model for {regime}: {e}")

        # Single atomic swap — readers see either the old or the new mapping.
        with self._lock:
            self.models = loaded

        logger.info(f"Loaded confluence models for regimes: {list(loaded.keys())}")

    def get_status(self) -> dict:
        """Return explicit artifact and fallback state for health diagnostics."""
        models = self.models
        return {
            "model": "regime-confluence-lightgbm",
            "loaded": bool(models),
            "healthy": True,
            "fallback_active": not bool(models),
            "loaded_regimes": sorted(models.keys()),
            "artifact_count": len(models),
        }

    def get_score(self, regime: str, features: dict) -> float:
        # Snapshot the mapping once. Coerce every feature to a finite float
        # FIRST: a NaN feature would make the weighted sum NaN, and
        # `max(0, min(100, nan))` evaluates to 100 — a perfect confluence score
        # for corrupt input.
        safe = {k: sanitize_float(features.get(k), default=50.0, low=0.0, high=100.0) for k in FEATURE_KEYS}

        models = self.models
        model = models.get(regime)
        if model is None:
            # Fallback to simple average or equal weight
            score = sum(safe[k] * w for k, w in FALLBACK_WEIGHTS.items())
            return round(finite_clamp(score, 0.0, 100.0, default=50.0), 2)

        # LightGBM requires 2D array
        x = np.array([safe[k] for k in FEATURE_KEYS], dtype=np.float64).reshape(1, -1)
        try:
            # P(Target Hit)
            prob = model.predict_proba(x)[0, 1]
            return round(finite_clamp(float(prob) * 100.0, 0.0, 100.0, default=50.0), 2)
        except Exception as e:
            logger.error(f"Failed to score confluence for {regime}: {e}")
            return 50.0


confluence_service = ConfluenceService()
