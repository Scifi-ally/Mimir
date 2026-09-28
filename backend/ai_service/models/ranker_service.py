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
# Continuous visibility into whether the ranker is actually participating.
# A None result makes the caller skip the hard P(win) < threshold veto, so a
# contract/model mismatch silently disarms the only calibrated risk gate.
_rows_predicted_count = 0
_width_mismatch_count = 0
_rows_without_features = 0

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


def _load_booster(model_path: str) -> Any:
    """
    Construct the LightGBM booster, tolerating CRLF-converted model files.

    LightGBM's text model parser is line-based and rejects CRLF endings. Worse,
    the failure surfaces as a native `abort()` (STATUS_STACK_BUFFER_OVERRUN),
    which terminates the whole process rather than raising a catchable Python
    exception — so the CRLF case MUST be detected before the C++ loader is
    invoked, not handled by a try/except around it.

    A Windows checkout with core.autocrlf=true rewrites the model file to CRLF,
    which would otherwise crash the AI service on startup. `.gitattributes` marks
    these artifacts `-text` to prevent that; this is the runtime backstop.
    """
    import lightgbm as lgb

    # newline="" preserves original line endings so the CR check is exact.
    with open(model_path, "r", encoding="utf-8", errors="replace", newline="") as fh:
        text = fh.read()

    if "\r" in text:
        normalized = text.replace("\r\n", "\n").replace("\r", "\n")
        booster = lgb.Booster(model_str=normalized)
        logger.warning(
            "Loaded ranker model after LF normalization — %s has CRLF line endings, which "
            "LightGBM's model parser aborts on. See .gitattributes / core.autocrlf.",
            os.path.basename(model_path),
        )
        return booster

    return lgb.Booster(model_file=model_path)


def load_model() -> None:
    """Load the booster + calibration meta once. Safe to call repeatedly."""
    global _booster, _feature_keys, _iso_x, _iso_y, _metrics, _trained_at, _loaded, _load_error, _recommended_threshold

    with _lock:
        if _loaded or not _LGB_AVAILABLE:
            return
        model_path = os.getenv("RANKER_MODEL_PATH", _MODEL_PATH)
        meta_path = os.getenv("RANKER_META_PATH", _META_PATH)
        if not os.path.exists(model_path) or not os.path.exists(meta_path):
            _load_error = "no trained ranker artifacts on disk"
            return
        try:
            booster = _load_booster(model_path)
            with open(meta_path, "r", encoding="utf-8") as fh:
                meta = json.load(fh)

            iso = meta.get("isotonic") or {}
            # Build the complete snapshot OFF to the side, then publish it as ONE
            # tuple assignment. Assigning the globals one at a time let a
            # concurrent predict_batch observe a MIXED state — most damagingly the
            # old booster scored against the NEW isotonic calibration (a
            # genuinely miscalibrated P(win), which is a hard trade gate), or the
            # new booster against stale feature keys (LightGBM raises, and the
            # handler returns [None]*n, silently disabling the ranker for the
            # whole batch).
            snapshot = (
                booster,                                              # _booster
                list(meta.get("feature_keys", [])),                   # _feature_keys
                (np.asarray(iso.get("x", []), dtype=np.float64) if iso.get("x") else None),
                (np.asarray(iso.get("y", []), dtype=np.float64) if iso.get("y") else None),
                meta.get("metrics", {}),                              # _metrics
                meta.get("trained_at"),                               # _trained_at
            )
            thr = meta.get("recommended_threshold")
            threshold = float(thr) if isinstance(thr, (int, float)) and np.isfinite(thr) else None

            _booster, _feature_keys, _iso_x, _iso_y, _metrics, _trained_at = snapshot
            _recommended_threshold = threshold
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
    """
    Status, plus whether the ranker is actually participating in decisions.

    `gate_active` is the field that matters operationally. A None `win_probability`
    makes the caller skip the hard P(win) < threshold veto, so a contract/model
    mismatch does not degrade quality - it removes the only calibrated risk gate
    the system has. Surfacing that explicitly prevents a silent disarm.
    """
    # Read all three counters atomically, otherwise gate_coverage can be
    # computed from a torn snapshot (predicted updated, mismatch not yet) and
    # report a coverage that never actually occurred.
    with _lock:
        predicted = _rows_predicted_count
        mismatched = _width_mismatch_count
        no_features = _rows_without_features
    total = predicted + mismatched + no_features
    coverage = (predicted / total) if total else None
    return {
        "model": "lightgbm-ranker",
        "available": _LGB_AVAILABLE,
        "loaded": _loaded,
        "error": _load_error,
        "feature_count": len(_feature_keys),
        "trained_at": _trained_at,
        "recommended_threshold": _recommended_threshold,
        "metrics": _metrics,
        "gate_active": _loaded,
        "rows_predicted": predicted,
        "width_mismatch_rows": mismatched,
        "without_features_rows": no_features,
        # Fraction of candidate rows that received a real calibrated P(win).
        # Below 1.0 means some candidates bypassed the veto entirely.
        "gate_coverage": round(coverage, 4) if coverage is not None else None,
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

    global _width_warned, _rows_predicted_count, _width_mismatch_count, _rows_without_features
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
        # predicted. Warn once when we see a mismatch, but keep counting.
        # Classify every row into exactly one bucket so the counters stay exact.
        # An empty row is "no features", NOT a "width mismatch": it is a missing
        # upstream feature vector, not train/serve contract drift. Counting it
        # as both would inflate the mismatch count and make gate_coverage
        # meaningless.
        valid_idx = [i for i, r in enumerate(feature_rows) if len(r) == expected]
        no_features_idx = [i for i, r in enumerate(feature_rows) if len(r) == 0]
        mismatched_idx = [
            i for i, r in enumerate(feature_rows)
            if len(r) not in (0, expected)
        ]

        # Every row falls into exactly one of these three buckets, so the
        # counts always sum to n. Count unconditionally; there is nothing to
        # condition on.
        with _lock:
            _width_mismatch_count += len(mismatched_idx)
            _rows_without_features += len(no_features_idx)
        if mismatched_idx and not _width_warned:
            logger.warning(
                "Ranker feature width mismatch: got %d, expected %d. This means the "
                "TS feature contract and the trained model disagree — those rows return "
                "None (composite fallback) rather than a fabricated probability. Retrain "
                "or realign RANKER_FEATURE_KEYS.",
                len(feature_rows[mismatched_idx[0]]), expected,
            )
            _width_warned = True

        out: List[Optional[float]] = [None] * n
        if not valid_idx:
            return out

        with _lock:
            _rows_predicted_count += len(valid_idx)

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
