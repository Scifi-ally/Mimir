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
import hashlib
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
_REQUIRED_STRATEGY_SCOPE = {
    "version": "cash-long-5bar-20d-turnover-v1",
    "horizon_bars": 5,
    "direction": "BUY",
    "notional_inr": 100_000,
    "minimum_average_turnover_20d_inr": 50_000_000,
    "maximum_notional_to_average_turnover_20d": 0.001,
    "fee_model": "upstox-cash-delivery-2026-10",
    "minimum_slippage_bps_per_side": 5,
}


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
            with open(meta_path, "r", encoding="utf-8") as fh:
                meta = json.load(fh)

            validation = meta.get("validation") or {}
            stress = validation.get("cost_stress") or {}
            ci = stress.get("expectancy_cluster_95_ci")
            if (validation.get("validation_version") != 2 or validation.get("passed") is not True or
                    validation.get("replay_verified") is not True or
                    validation.get("strategy_scope_verified") is not True or
                    validation.get("strategy_scope") != _REQUIRED_STRATEGY_SCOPE or
                    validation.get("point_in_time_universe_verified") is not True or
                    len(validation.get("folds", [])) < 3 or stress.get("trades", 0) < 100 or
                    not isinstance(ci, list) or len(ci) != 2 or
                    not all(isinstance(v, (int, float)) and np.isfinite(v) for v in ci) or ci[0] <= 0):
                raise ValueError("ranker lacks positive, cost-stressed, purged walk-forward evidence with point-in-time universe provenance")
            expected_digest = meta.get("model_sha256")
            if not isinstance(expected_digest, str) or len(expected_digest) != 64:
                raise ValueError("ranker metadata is missing its model integrity digest")
            digest = hashlib.sha256()
            with open(model_path, "rb") as model_fh:
                for chunk in iter(lambda: model_fh.read(1024 * 1024), b""):
                    digest.update(chunk)
            if digest.hexdigest() != expected_digest:
                raise ValueError("ranker model does not match its metadata integrity digest")
            booster = _load_booster(model_path)

            iso = meta.get("isotonic") or {}
            keys = list(meta.get("feature_keys", []))
            with open(os.path.join(os.path.dirname(__file__), "..", "..", "config", "ranker_features_manifest.json"), encoding="utf-8") as fh:
                manifest = json.load(fh)
            if keys != manifest or booster.num_feature() != len(keys):
                raise ValueError("ranker feature order/width does not match the serving manifest")
            xs, ys = iso.get("x", []), iso.get("y", [])
            if (len(xs) < 2 or len(xs) != len(ys) or
                    not np.isfinite(xs).all() or not np.isfinite(ys).all() or
                    np.any(np.diff(xs) <= 0) or np.any(np.diff(ys) < 0) or
                    min(ys) < 0 or max(ys) > 1):
                raise ValueError("invalid ranker calibration map")
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


def _looks_stale() -> bool:
    """True when the served artifact predates the available training data.

    The shipped artifact reports a +1.25% greenlight expectancy from a 500-row
    corpus with a 52.6% base win rate. The real corpus has 17,407 rows at a 6%
    base rate, and a retrain on it measured NEGATIVE expectancy and was refused.
    Comparing the two is the only way an operator can see that the served
    model's headline number describes a market that does not exist.
    """
    m = _metrics or {}
    base = m.get("greenlight_expectancy_pct")
    trained = m.get("test_n")
    if base is None or trained is None:
        return False
    try:
        return float(trained) < 1000
    except (TypeError, ValueError):
        return False


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
        # A loaded artifact is not an armed gate. It is armed only once it has
        # actually produced a calibrated probability for at least one candidate;
        # before that, every candidate bypasses the veto, so reporting
        # gate_active=True on a freshly loaded model overstated what was
        # happening.
        "gate_active": _loaded and predicted > 0,
        "rows_predicted": predicted,
        "width_mismatch_rows": mismatched,
        "without_features_rows": no_features,
        # Fraction of candidate rows that received a real calibrated P(win).
        # Below 1.0 means some candidates bypassed the veto entirely.
        "gate_coverage": round(coverage, 4) if coverage is not None else None,
        # True until the model has been shown to serve predictions. Distinct
        # from "cold start": the artifact exists, it just has not been used yet.
        "gate_never_exercised": _loaded and predicted == 0,
        # The metrics on the served artifact describe the data it was trained
        # on, which is not necessarily the data available now.
        #
        # The currently shipped artifact reports greenlight_expectancy_pct of
        # +1.25 from a 500-row corpus with a 52.6% base win rate. Retraining on
        # the real corpus (17,407 rows, 6% base rate, purged, 24h embargo)
        # measured take-all at -0.45%/trade and greenlight at -0.42%/trade, and
        # the trainer correctly refused to write a replacement. So the served
        # model is not merely stale: its headline number describes a dataset that
        # does not represent this market, while a live veto uses it.
        #
        # Surfaced rather than left in /health as a plain metric, because
        # "test_auc 0.723" reads as current when it is not.
        "metrics_stale": _loaded and _looks_stale(),
        "served_threshold": _recommended_threshold,
        "metrics_note": (
            "metrics describe the training corpus at trained_at, not current data; "
            "a retrain on the real corpus was refused for failing to beat take-all"
        ),
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
    if n == 0:
        return [None] * n

    # A concurrent reload publishes all globals as one tuple, but prediction
    # must also read the tuple once: LightGBM releases the GIL in predict(), so
    # a later calibration lookup of module globals could otherwise come from a
    # different artifact than the booster that produced these scores.
    with _lock:
        loaded = _loaded
        booster = _booster
        feature_keys = tuple(_feature_keys)
        iso_x = _iso_x
        iso_y = _iso_y
    if not loaded or booster is None:
        return [None] * n

    global _width_warned, _rows_predicted_count, _width_mismatch_count, _rows_without_features
    expected = len(feature_keys)
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
        valid_idx = [i for i, r in enumerate(feature_rows) if len(r) == expected and
                     all((not isinstance(v, bool) and isinstance(v, (int, float)) and np.isfinite(v)) or
                         (feature_keys[j] == "fiiDiiNetFlowLag" and v is None)
                         for j, v in enumerate(r))]
        no_features_idx = [i for i, r in enumerate(feature_rows) if len(r) == 0]
        mismatched_idx = [
            i for i, r in enumerate(feature_rows)
            if len(r) != 0 and i not in valid_idx
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

        mat = np.zeros((len(valid_idx), expected), dtype=np.float64)
        for mi, i in enumerate(valid_idx):
            row = feature_rows[i]

            for j in range(expected):
                v = row[j]
                mat[mi, j] = np.nan if v is None else v

        raw = booster.predict(mat)
        raw = np.asarray(raw, dtype=np.float64)
        cal = (np.interp(raw, iso_x, iso_y)
               if iso_x is not None and iso_y is not None and len(iso_x) >= 2
               else raw)
        if cal.shape != (len(valid_idx),) or not np.isfinite(cal).all():
            raise ValueError("ranker returned invalid probabilities")
        cal = np.clip(cal, 0.0, 1.0)
        with _lock:
            _rows_predicted_count += len(valid_idx)
        for mi, i in enumerate(valid_idx):
            out[i] = float(round(cal[mi], 4))
        return out
    except Exception as exc:
        logger.error("Ranker prediction failed, falling back: %s", exc)
        return [None] * n
