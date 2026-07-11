"""
TechnicalPatternEngine model wrapper — financial pattern recognition on OHLCV data.

Loads a sophisticated rule-based fallback that analyses candlestick patterns and
returns *bullish_probability* + *confidence*.
"""

from __future__ import annotations

import logging
import math
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import numpy as np

logger = logging.getLogger("ai_service.technical_pattern_engine")

# ---------------------------------------------------------------------------
# Singleton holder
# ---------------------------------------------------------------------------
_model: Optional[Any] = None
_tokenizer: Optional[Any] = None
_model_loaded: bool = False
_load_error: Optional[str] = None
_model_load_time_ms: Optional[float] = None
_last_inference_latency_ms: Optional[float] = None
_last_successful_inference_ts: Optional[str] = None
_healthy: bool = False


def _smoke_test() -> None:
    sample = np.array(
        [
            [100.0, 101.2, 99.4, 100.8, 120000.0],
            [100.8, 102.0, 100.2, 101.4, 128500.0],
            [101.4, 102.7, 100.9, 102.1, 131000.0],
            [102.1, 103.0, 101.6, 102.8, 140500.0],
        ],
        dtype=np.float64,
    )
    _infer_with_model(sample, {})


def load_model() -> None:
    """Initialize the advanced rule-based engine. We no longer use FinBERT for OHLCV data."""
    global _model_loaded, _healthy, _model_load_time_ms
    
    if _model_loaded:
        return

    started_at = time.time()
    logger.info("Initializing TechnicalPatternEngine Rule-Based Engine...")
    _model_loaded = True
    _healthy = True
    _model_load_time_ms = round((time.time() - started_at) * 1000, 2)
    logger.info("TechnicalPatternEngine Rule-Based Engine loaded successfully.")


def is_loaded() -> bool:
    return _model_loaded


def get_status() -> Dict[str, Any]:
    return {
        "engine": "Technical Pattern Engine",
        "loaded": _model_loaded,
        "healthy": _healthy,
        "fallback_active": not _model_loaded,
        "error": _load_error,
        "load_time_ms": _model_load_time_ms,
        "last_inference_latency_ms": _last_inference_latency_ms,
        "last_successful_inference_ts": _last_successful_inference_ts,
    }


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------
@dataclass
class TechnicalPatternResult:
    bullish_probability: float
    confidence: float
    detected_patterns: List[str] = field(default_factory=list)
    source: str = "model"  # "model" | "fallback"
    raw_scores: Optional[Dict[str, float]] = None


# ---------------------------------------------------------------------------
# Model-based inference
# ---------------------------------------------------------------------------
def _infer_with_model(ohlcv: np.ndarray, features: Dict[str, Any]) -> TechnicalPatternResult:
    """Pass-through to the advanced rule-based engine."""
    return _infer_engine(ohlcv, features)


# ---------------------------------------------------------------------------
# Rule-based fallback — candlestick pattern analysis
# ---------------------------------------------------------------------------

def _body(o: float, c: float) -> float:
    return abs(c - o)


def _upper_shadow(h: float, o: float, c: float) -> float:
    return h - max(o, c)


def _lower_shadow(l: float, o: float, c: float) -> float:
    return min(o, c) - l


def _candle_range(h: float, l: float) -> float:
    return h - l if h != l else 1e-9


def _detect_patterns(ohlcv: np.ndarray) -> List[str]:
    """Detect common candlestick patterns in the *last few candles*."""
    patterns: list[str] = []
    n = len(ohlcv)
    if n < 2:
        return patterns

    # Helper aliases for the last candles
    def c(i: int):  # noqa: E741 – short alias
        """Return (open, high, low, close, volume) for candle at index *i* (negative ok)."""
        row = ohlcv[i]
        return float(row[0]), float(row[1]), float(row[2]), float(row[3]), float(row[4]) if len(row) > 4 else 0.0

    o1, h1, l1, c1, v1 = c(-1)
    o2, h2, l2, c2, v2 = c(-2)
    rng1 = _candle_range(h1, l1)
    body1 = _body(o1, c1)
    body2 = _body(o2, c2)

    # --- Doji ---
    if body1 / rng1 < 0.1:
        patterns.append("doji")

    # --- Hammer (bullish) ---
    lower1 = _lower_shadow(l1, o1, c1)
    upper1 = _upper_shadow(h1, o1, c1)
    if lower1 > 2 * body1 and upper1 < body1 * 0.5 and c1 > o1:
        patterns.append("hammer")

    # --- Inverted hammer ---
    if upper1 > 2 * body1 and lower1 < body1 * 0.5 and c1 > o1:
        patterns.append("inverted_hammer")

    # --- Shooting star (bearish) ---
    if upper1 > 2 * body1 and lower1 < body1 * 0.3 and c1 < o1:
        patterns.append("shooting_star")

    # --- Hanging man (bearish) ---
    if lower1 > 2 * body1 and upper1 < body1 * 0.3 and c1 < o1:
        patterns.append("hanging_man")

    # --- Bullish engulfing ---
    if c2 < o2 and c1 > o1 and o1 <= c2 and c1 >= o2:
        patterns.append("bullish_engulfing")

    # --- Bearish engulfing ---
    if c2 > o2 and c1 < o1 and o1 >= c2 and c1 <= o2:
        patterns.append("bearish_engulfing")

    # --- Morning star (bullish, requires 3 candles) ---
    if n >= 3:
        o3, h3, l3, c3, v3 = c(-3)
        body3 = _body(o3, c3)
        if c3 < o3 and body2 / _candle_range(h2, l2) < 0.2 and c1 > o1 and c1 > (o3 + c3) / 2:
            patterns.append("morning_star")

    # --- Evening star (bearish, requires 3 candles) ---
    if n >= 3:
        o3, h3, l3, c3, v3 = c(-3)
        body3 = _body(o3, c3)
        if c3 > o3 and body2 / _candle_range(h2, l2) < 0.2 and c1 < o1 and c1 < (o3 + c3) / 2:
            patterns.append("evening_star")

    # --- Three white soldiers (bullish) ---
    if n >= 3:
        o3, h3, l3, c3, v3 = c(-3)
        if c3 > o3 and c2 > o2 and c1 > o1 and c1 > c2 > c3:
            patterns.append("three_white_soldiers")

    # --- Three black crows (bearish) ---
    if n >= 3:
        o3, h3, l3, c3, v3 = c(-3)
        if c3 < o3 and c2 < o2 and c1 < o1 and c1 < c2 < c3:
            patterns.append("three_black_crows")

    return patterns


# Pattern → (bullish_bias, confidence_weight)
_PATTERN_WEIGHTS: Dict[str, tuple[float, float]] = {
    "doji":                (0.0,   0.05),
    "hammer":              (0.20,  0.15),
    "inverted_hammer":     (0.10,  0.10),
    "shooting_star":       (-0.20, 0.15),
    "hanging_man":         (-0.15, 0.12),
    "bullish_engulfing":   (0.25,  0.20),
    "bearish_engulfing":   (-0.25, 0.20),
    "morning_star":        (0.30,  0.22),
    "evening_star":        (-0.30, 0.22),
    "three_white_soldiers": (0.35, 0.25),
    "three_black_crows":   (-0.35, 0.25),
}


def _trend_bias(ohlcv: np.ndarray) -> float:
    """Simple momentum: returns a value in [-0.3, 0.3] based on recent closes."""
    if len(ohlcv) < 5:
        return 0.0
    closes = ohlcv[-20:, 3].astype(float)
    if len(closes) < 2:
        return 0.0
    returns = np.diff(closes) / (closes[:-1] + 1e-9)
    avg_ret = float(np.mean(returns))
    # Clamp to [-0.3, 0.3]
    return max(-0.3, min(0.3, avg_ret * 50))


def _volume_signal(ohlcv: np.ndarray) -> float:
    """Volume spike signal: positive if latest volume >> average. Much stronger impact."""
    if ohlcv.shape[1] < 5 or len(ohlcv) < 5:
        return 0.0
    volumes = ohlcv[-20:, 4].astype(float)
    avg_vol = float(np.mean(volumes[:-1])) if len(volumes) > 1 else float(volumes[0])
    latest_vol = float(volumes[-1])
    if avg_vol < 1:
        return 0.0
    ratio = latest_vol / avg_vol
    # High volume confirms direction of last candle
    last_close = float(ohlcv[-1, 3])
    last_open = float(ohlcv[-1, 0])
    direction = 1.0 if last_close >= last_open else -1.0
    
    if ratio < 1.0:
        return 0.0
    
    # Cap ratio at 5x to prevent extreme distortion
    capped_ratio = min(ratio, 5.0)
    # Stronger impact on bias: 0.15 bias per 1x avg volume above normal
    spike_impact = (capped_ratio - 1.0) * 0.15 
    
    return spike_impact * direction


def _infer_engine(ohlcv: np.ndarray, features: Dict[str, Any]) -> TechnicalPatternResult:
    """Sophisticated rule-based engine scoring."""
    global _last_inference_latency_ms, _last_successful_inference_ts, _healthy
    started_at = time.time()
    
    patterns = _detect_patterns(ohlcv)

    # Start at neutral (0.5)
    bias = 0.0
    confidence_accum = 0.10  # base confidence

    for p in patterns:
        b, w = _PATTERN_WEIGHTS.get(p, (0.0, 0.0))
        bias += b
        confidence_accum += w

    # Add momentum & volume signals
    vol_sig = _volume_signal(ohlcv)
    bias += _trend_bias(ohlcv)
    bias += vol_sig
    
    # Boost confidence significantly if there's high volume confirmation
    if abs(vol_sig) > 0.15:
        confidence_accum += 0.20

    # RSI-like feature if provided
    rsi = features.get("rsi")
    if rsi is not None:
        rsi = float(rsi)
        if rsi < 30:
            bias += 0.15
            confidence_accum += 0.05
        elif rsi > 70:
            bias -= 0.15
            confidence_accum += 0.05

    # MACD signal if provided
    macd_hist = features.get("macd_histogram")
    if macd_hist is not None:
        macd_hist = float(macd_hist)
        bias += max(-0.1, min(0.1, macd_hist * 5))

    # POC distance: price above POC = institutional support for longs
    poc_dist = features.get("pocDistancePct")
    if poc_dist is not None:
        poc_dist = float(poc_dist)
        if poc_dist > 0:
            # Above POC = bullish support
            bias += min(0.08, poc_dist * 0.01)
            confidence_accum += 0.03
        elif poc_dist < -3:
            # Deep below POC = bearish, lacks institutional support
            bias -= 0.06
            confidence_accum += 0.02

    # BB Width: narrow = squeeze = potential explosive move
    bb_width = features.get("bbWidthPct")
    if bb_width is not None:
        bb_width = float(bb_width)
        if bb_width < 4.0:
            # Tight squeeze — direction depends on last candle
            last_close = float(ohlcv[-1, 3])
            last_open = float(ohlcv[-1, 0])
            squeeze_dir = 0.06 if last_close >= last_open else -0.06
            bias += squeeze_dir
            confidence_accum += 0.05

    # VCP Contraction: values < 0.7 = strong contraction (breakout imminent)
    vcp = features.get("vcpContraction")
    if vcp is not None:
        vcp = float(vcp)
        if vcp < 0.5:
            confidence_accum += 0.08  # Very tight VCP
            bias += 0.05  # Slight bullish bias (VCPs typically resolve upward)
        elif vcp < 0.7:
            confidence_accum += 0.04
            bias += 0.03

    # Convert bias → probability via sigmoid-like mapping
    bullish_prob = 1.0 / (1.0 + math.exp(-5 * bias))  # steeper sigmoid
    confidence = min(confidence_accum, 0.85)

    _last_inference_latency_ms = round((time.time() - started_at) * 1000, 2)
    _last_successful_inference_ts = time.strftime("%Y-%m-%d %H:%M:%S")
    _healthy = True

    return TechnicalPatternResult(
        bullish_probability=round(bullish_prob, 4),
        confidence=round(confidence, 4),
        detected_patterns=patterns,
        source="engine",
    )


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------
def infer(ohlcv_list: List[List[float]], features: Optional[Dict[str, Any]] = None) -> TechnicalPatternResult:
    """
    Run TechnicalPatternEngine inference on OHLCV data.

    Parameters
    ----------
    ohlcv_list : list of [open, high, low, close, volume]
    features   : optional dict of extra indicators (rsi, macd_histogram, …)

    Returns
    -------
    TechnicalPatternResult with bullish_probability, confidence, detected_patterns, source.
    """
    features = features or {}
    ohlcv = np.array(ohlcv_list, dtype=np.float64)

    if ohlcv.ndim != 2 or ohlcv.shape[1] < 4:
        raise ValueError("ohlcv must be a 2-D array with at least 4 columns (O, H, L, C)")

    # Pad volume column if missing
    if ohlcv.shape[1] == 4:
        ohlcv = np.column_stack([ohlcv, np.zeros(len(ohlcv))])

    return _infer_engine(ohlcv, features)
