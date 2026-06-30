"""
Chronos-Bolt wrapper — probabilistic time-series forecasting on close prices.

Loads amazon/chronos-bolt-tiny from HuggingFace at startup.
If the model is unavailable, a momentum + mean-reversion fallback generates
5-step probabilistic forecasts with synthetic quantiles.
"""

from __future__ import annotations

import logging
import math
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import numpy as np

logger = logging.getLogger("ai_service.chronos")

# ---------------------------------------------------------------------------
# Singleton holder
# ---------------------------------------------------------------------------
_pipeline: Optional[Any] = None
_model_loaded: bool = False
_load_error: Optional[str] = None
_model_load_time_ms: Optional[float] = None
_last_inference_latency_ms: Optional[float] = None
_last_successful_inference_ts: Optional[str] = None
_healthy: bool = False

FORECAST_STEPS = 5
QUANTILE_LEVELS = [0.1, 0.25, 0.5, 0.75, 0.9]


def load_model() -> None:
    """Attempt to load Chronos-Bolt-Tiny once.  Safe to call repeatedly."""
    global _pipeline, _model_loaded, _load_error, _model_load_time_ms, _healthy

    if _model_loaded or _load_error is not None:
        return

    try:
        started_at = time.time()
        logger.info("Loading amazon/chronos-bolt-tiny …")
        import torch
        from chronos import BaseChronosPipeline

        # Prefer GPU when available; fall back to CPU otherwise. Using "auto"
        # lets the underlying library place weights on CUDA if possible.
        device_map = "auto" if torch.cuda.is_available() else "cpu"

        torch_dtype = torch.float16 if torch.cuda.is_available() else torch.float32
        _pipeline = BaseChronosPipeline.from_pretrained(
            "amazon/chronos-bolt-tiny",
            device_map=device_map,
            torch_dtype=torch_dtype,
        )
        _infer_with_model(np.array([100.0, 100.5, 100.9, 101.2, 101.7], dtype=np.float64), 3)
        _model_loaded = True
        _healthy = True
        _model_load_time_ms = round((time.time() - started_at) * 1000, 2)
        logger.info("Chronos-Bolt-Tiny loaded successfully.")
    except Exception as exc:
        _load_error = str(exc)
        _healthy = False
        logger.warning(
            "Chronos model unavailable – using momentum fallback.  Error: %s",
            _load_error,
        )


def is_loaded() -> bool:
    return _model_loaded


def get_status() -> Dict[str, Any]:
    return {
        "model": "amazon/chronos-bolt-tiny",
        "loaded": _model_loaded,
        "healthy": _healthy,
        "fallback_active": not _model_loaded,
        "error": _load_error,
        "load_time_ms": _model_load_time_ms,
        "last_inference_latency_ms": _last_inference_latency_ms,
        "last_successful_inference_ts": _last_successful_inference_ts,
    }


# ---------------------------------------------------------------------------
# Data class
# ---------------------------------------------------------------------------
@dataclass
class ChronosResult:
    """Probabilistic forecast result."""
    median_forecast: List[float]
    quantile_forecasts: Dict[str, List[float]]  # "q10", "q25", …
    trend: str  # "bullish" | "bearish" | "neutral"
    forecast_return_pct: float  # median return % over the forecast horizon
    source: str = "model"


# ---------------------------------------------------------------------------
# Model-based inference
# ---------------------------------------------------------------------------
def _infer_with_model(closes: np.ndarray, steps: int) -> ChronosResult:
    import torch

    global _last_inference_latency_ms, _last_successful_inference_ts, _healthy

    started_at = time.time()

    device = next(_pipeline.model.parameters()).device if hasattr(_pipeline, "model") else torch.device("cpu")
    context = torch.tensor(closes, dtype=torch.float32).unsqueeze(0).to(device)
    
    with torch.inference_mode():
        forecast = _pipeline.predict_quantiles(
            context,
            prediction_length=steps,
            quantile_levels=QUANTILE_LEVELS,
        )
    if isinstance(forecast, tuple):
        forecast = forecast[0]
    # forecast shape: (1, steps, len(quantile_levels))
    forecast_np = forecast.squeeze(0).cpu().numpy()

    quantile_dict: Dict[str, List[float]] = {}
    for idx, q in enumerate(QUANTILE_LEVELS):
        key = f"q{int(q * 100)}"
        quantile_dict[key] = [round(float(v), 4) for v in forecast_np[:, idx]]

    median = quantile_dict["q50"]
    last_close = float(closes[-1])
    ret_pct = ((median[-1] - last_close) / last_close) * 100 if last_close else 0.0

    trend = "bullish" if ret_pct > 0.3 else ("bearish" if ret_pct < -0.3 else "neutral")

    result = ChronosResult(
        median_forecast=[round(v, 4) for v in median],
        quantile_forecasts=quantile_dict,
        trend=trend,
        forecast_return_pct=round(ret_pct, 4),
        source="model",
    )
    _last_inference_latency_ms = round((time.time() - started_at) * 1000, 2)
    _last_successful_inference_ts = time.strftime("%Y-%m-%d %H:%M:%S")
    _healthy = True
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    return result


# ---------------------------------------------------------------------------
# Momentum + mean-reversion fallback
# ---------------------------------------------------------------------------
def _infer_fallback(closes: np.ndarray, steps: int) -> ChronosResult:
    """Generate a plausible forecast using momentum, mean-reversion, and
    expanding uncertainty bands."""

    n = len(closes)
    last = float(closes[-1])

    # Short-term momentum (last 5 candles)
    short_window = min(5, n)
    short_returns = np.diff(closes[-short_window:]) / (closes[-short_window:-1] + 1e-9)
    momentum = float(np.mean(short_returns)) if len(short_returns) > 0 else 0.0

    # Longer-term mean for mean-reversion pull
    long_window = min(20, n)
    long_mean = float(np.mean(closes[-long_window:]))
    reversion_pull = (long_mean - last) / (last + 1e-9) * 0.05  # gentle pull

    # Recent volatility (std of returns)
    if n >= 5:
        all_rets = np.diff(closes[-20:]) / (closes[-20:-1] + 1e-9)
        vol = float(np.std(all_rets)) if len(all_rets) > 1 else 0.005
    else:
        vol = 0.005

    vol = max(vol, 0.001)  # floor

    median: list[float] = []
    quantiles: Dict[str, list[float]] = {f"q{int(q * 100)}": [] for q in QUANTILE_LEVELS}

    price = last
    for step in range(1, steps + 1):
        # Blend momentum (decaying) with mean-reversion
        decay = 0.7 ** step
        step_return = momentum * decay + reversion_pull
        price = price * (1 + step_return)
        median.append(round(price, 4))

        # Fan-out uncertainty
        spread = vol * math.sqrt(step)
        for q in QUANTILE_LEVELS:
            z = _norm_ppf(q)
            q_price = price * (1 + z * spread)
            quantiles[f"q{int(q * 100)}"].append(round(q_price, 4))

    ret_pct = ((median[-1] - last) / last) * 100 if last else 0.0
    trend = "bullish" if ret_pct > 0.3 else ("bearish" if ret_pct < -0.3 else "neutral")

    return ChronosResult(
        median_forecast=median,
        quantile_forecasts=quantiles,
        trend=trend,
        forecast_return_pct=round(ret_pct, 4),
        source="fallback",
    )


def _norm_ppf(q: float) -> float:
    """Approximate inverse-normal (percent-point function) without scipy."""
    # Rational approximation (Abramowitz & Stegun 26.2.23)
    if q <= 0 or q >= 1:
        return 0.0
    if q == 0.5:
        return 0.0
    if q > 0.5:
        return -_norm_ppf(1 - q)
    t = math.sqrt(-2 * math.log(q))
    c0, c1, c2 = 2.515517, 0.802853, 0.010328
    d1, d2, d3 = 1.432788, 0.189269, 0.001308
    return -(t - (c0 + c1 * t + c2 * t * t) / (1 + d1 * t + d2 * t * t + d3 * t * t * t))


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------
def infer(closes_list: List[float], steps: int = FORECAST_STEPS) -> ChronosResult:
    """
    Run Chronos inference on an array of close prices.

    Parameters
    ----------
    closes_list : list[float]  — recent close prices (at least 5 recommended)
    steps       : int          — number of forecast steps (default 5)

    Returns
    -------
    ChronosResult with median, quantile forecasts, trend, and return %.
    """
    closes = np.array(closes_list, dtype=np.float64)
    if closes.ndim != 1 or len(closes) < 2:
        raise ValueError("closes must be a 1-D array with at least 2 elements")

    steps = max(1, min(steps, 30))  # safety clamp

    # Noise reduction for highly volatile assets
    if len(closes) >= 5:
        rets = np.diff(closes[-20:]) / (closes[-20:-1] + 1e-9)
        vol = float(np.std(rets))
        # If highly volatile, apply a light EMA smoothing (EMA-3) to reduce noise fan-outs
        if vol > 0.02:
            alpha = 2.0 / (3 + 1)
            smoothed = np.zeros_like(closes)
            smoothed[0] = closes[0]
            for i in range(1, len(closes)):
                smoothed[i] = closes[i] * alpha + smoothed[i-1] * (1 - alpha)
            closes = smoothed

    if _model_loaded:
        try:
            return _infer_with_model(closes, steps)
        except Exception as exc:
            logger.error("Chronos model inference failed, falling back: %s", exc)

    return _infer_fallback(closes, steps)
