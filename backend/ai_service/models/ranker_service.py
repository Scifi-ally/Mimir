"""
Learned ranker — LightGBM win-probability model over the shared candle-derived
feature contract (RANKER_FEATURE_KEYS in feature_engine.ts).

Given a signal's feature array, returns P(trade hits target1 before stop),
calibrated to a real probability via an isotonic map fitted on a held-out slice.

Graceful degradation is a hard requirement: if LightGBM is not installed or no
trained model file exists, is_loaded() stays False and callers fall back to the
existing composite formula. The zero-dependency Windows install must still run.

Artifacts (in ai_service/, matching rl_agent.py's convention):
  ranker_model.txt   — LightGBM Booster (text format, portable)
  ranker_meta.json   — { feature_keys, isotonic: {x:[...], y:[...]}, metrics, trained_at }
"""

from __future__ import annotations

import json
import logging
import os
import threading
from typing import Any, Dict, List, Optional

import numpy as np

logger = logging.getLogger("ai_service.ranker")

# Latch so the feature-width mismatch warning fires once, not per batch.
_width_warned = False

try:
    import lightgbm as lgb  # noqa: F401
    _LGB_AVAILABLE = True
except ImportError:
    _LGB_AVAILABLE = False
    logger.warning("lightgbm not installed — learned ranker disabled, callers use composite fallback.")

_MODEL_PATH = os.getenv(
    "RANKER_MODEL_PATH", os.path.join(os.path.dirname(__file__), "..", "ranker_model.txt")
)
_META_PATH = os.getenv(
    "RANKER_META_PATH", os.path.join(os.path.dirname(__file__), "..", "ranker_meta.json")
)

_lock = threading.Lock()
_booster: Optional[Any] = None
_feature_keys: List[str] = []
_iso_x: Optional[np.ndarray] = None
_iso_y: Optional[np.ndarray] = None
_metrics: Dict[str, Any] = {}
_trained_at: Optional[str] = None
_recommended_threshold: Optional[float] = None
_loaded: bool = False
_load_error: Optional[str] = None


def load_model() -> None:
    """Load the booster + calibration meta once. Safe to call repeatedly."""
    global _booster, _feature_keys, _iso_x, _iso_y, _metrics, _trained_at, _loaded, _load_error, _recommended_threshold

    with _lock:
        if _loaded or not _LGB_AVAILABLE:
            return
        if not os.path.exists(_MODEL_PATH) or not os.path.exists(_META_PATH):
            _load_error = "no trained ranker artifacts on disk"
            return
        try:
            import lightgbm as lgb

            booster = lgb.Booster(model_file=_MODEL_PATH)
            with open(_META_PATH, "r", encoding="utf-8") as fh:
                meta = json.load(fh)

            iso = meta.get("isotonic") or {}
            _iso_x = np.asarray(iso.get("x", []), dtype=np.float64) if iso.get("x") else None
            _iso_y = np.asarray(iso.get("y", []), dtype=np.float64) if iso.get("y") else None

            _booster = booster
            _feature_keys = list(meta.get("feature_keys", []))
            _metrics = meta.get("metrics", {})
            _trained_at = meta.get("trained_at")
            thr = meta.get("recommended_threshold")
            _recommended_threshold = float(thr) if isinstance(thr, (int, float)) else None
            _loaded = True
            logger.info(
                "Learned ranker loaded (features=%d, trained_at=%s, val_auc=%s)",
                len(_feature_keys), _trained_at, _metrics.get("val_auc"),
            )
        except Exception as exc:  # corrupt artifact — stay in fallback, never crash the service
            _load_error = str(exc)
            logger.error("Failed to load learned ranker: %s", exc)


def reload_model() -> None:
    """Force a reload after (re)training."""
    global _loaded, _load_error
    with _lock:
        _loaded = False
        _load_error = None
    load_model()


def is_loaded() -> bool:
    return _loaded


def recommended_threshold() -> Optional[float]:
    """The P(win) cutoff that maximised out-of-sample expectancy at train time.
    None when no model is loaded — callers then apply no ranker gate."""
    return _recommended_threshold


def get_status() -> Dict[str, Any]:
    return {
        "model": "lightgbm-ranker",
        "available": _LGB_AVAILABLE,
        "loaded": _loaded,
        "error": _load_error,
        "feature_count": len(_feature_keys),
        "trained_at": _trained_at,
        "recommended_threshold": _recommended_threshold,
        "metrics": _metrics,
    }


def _apply_isotonic(p: np.ndarray) -> np.ndarray:
    """Map raw model scores to calibrated probabilities via the fitted isotonic
    step function (piecewise-linear interpolation between calibration knots)."""
    if _iso_x is None or _iso_y is None or len(_iso_x) < 2:
        return p
    return np.interp(p, _iso_x, _iso_y)


def predict_batch(feature_rows: List[List[float]]) -> List[Optional[float]]:
    """
    Calibrated P(win) for each feature row, in input order.

    Returns None per row only when the ranker is unavailable, so the caller can
    cleanly fall back to the composite score for that candidate.
    """
    n = len(feature_rows)
    if not _loaded or _booster is None or n == 0:
        return [None] * n

    global _width_warned
    expected = len(_feature_keys)
    try:
        # A row whose width != expected is train/serve skew (someone changed
        # RANKER_FEATURE_KEYS on one side only) or a candidate that never had its
        # ranker features populated. Either way the row's contents do NOT map to
        # the columns the booster trained on, so predicting on it (even after
        # zero-padding) yields a real-looking-but-meaningless calibrated
        # probability — a fabricated signal that can gate real trades. Per the
        # contract in this function's docstring, such rows return None so the
        # caller falls back to the composite score. Only well-formed rows are
        # predicted. Warn once when we see a mismatch.
        valid_idx = [i for i, r in enumerate(feature_rows) if len(r) == expected]
        if len(valid_idx) != n and not _width_warned:
            bad = next(len(r) for r in feature_rows if len(r) != expected)
            logger.warning(
                "Ranker feature width mismatch: got %d, expected %d. This means the "
                "TS feature contract and the trained model disagree, or a candidate "
                "arrived without ranker features — those rows return None (composite "
                "fallback) rather than a fabricated probability. Retrain or realign "
                "RANKER_FEATURE_KEYS.",
                bad, expected,
            )
            _width_warned = True

        out: List[Optional[float]] = [None] * n
        if not valid_idx:
            return out

        mat = np.zeros((len(valid_idx), expected), dtype=np.float64)
        for mi, i in enumerate(valid_idx):
            row = feature_rows[i]
            for j in range(expected):
                v = row[j]
                mat[mi, j] = v if isinstance(v, (int, float)) and np.isfinite(v) else 0.0

        raw = _booster.predict(mat)
        cal = _apply_isotonic(np.asarray(raw, dtype=np.float64))
        cal = np.clip(cal, 0.0, 1.0)
        for mi, i in enumerate(valid_idx):
            out[i] = float(round(cal[mi], 4))
        return out
    except Exception as exc:
        logger.error("Ranker prediction failed, falling back: %s", exc)
        return [None] * n
