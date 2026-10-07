"""
Chronos-Bolt wrapper — probabilistic time-series forecasting on close prices.

Loads amazon/chronos-bolt-small from HuggingFace at startup.
If the model is unavailable, inference abstains and reports an unavailable
source. It never fabricates quantiles or a directional forecast.
"""

from __future__ import annotations

import logging
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
    """Attempt to load Chronos-Bolt-Small once.  Safe to call repeatedly."""
    global _pipeline, _model_loaded, _load_error, _model_load_time_ms, _healthy

    if _model_loaded or _load_error is not None:
        return

    try:
        started_at = time.time()
        logger.info("Loading amazon/chronos-bolt-small …")
        import torch
        from chronos import BaseChronosPipeline

        # Prefer GPU when available; fall back to CPU otherwise. Using "auto"
        # lets the underlying library place weights on CUDA if possible.
        device_map = "auto" if torch.cuda.is_available() else "cpu"

        torch_dtype = torch.float16 if torch.cuda.is_available() else torch.float32
        _pipeline = BaseChronosPipeline.from_pretrained(
            "amazon/chronos-bolt-small",
            device_map=device_map,
            torch_dtype=torch_dtype,
        )
        _infer_with_model(np.array([100.0, 100.5, 100.9, 101.2, 101.7], dtype=np.float64), 3)
        _model_loaded = True
        _healthy = True
        _model_load_time_ms = round((time.time() - started_at) * 1000, 2)
        logger.info("Chronos-Bolt-Small loaded successfully.")
    except Exception as exc:
        _load_error = str(exc)
        _healthy = False
        logger.warning(
            "Chronos model unavailable; forecast inference will abstain. Error: %s",
            _load_error,
        )


def is_loaded() -> bool:
    return _model_loaded


def get_status() -> Dict[str, Any]:
    return {
        "model": "amazon/chronos-bolt-small",
        "loaded": _model_loaded,
        "healthy": _healthy,
        "fallback_active": False,
        "forecast_available": _model_loaded,
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
    forecast_return_pct: Optional[float]  # null when no model forecast is available
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
    # NOTE: intentionally NOT calling torch.cuda.empty_cache() here. On a
    # dedicated 6GB card with only Chronos-Bolt-small resident, releasing the
    # cache after every call forces the allocator to re-request VRAM on the next
    # inference — pure overhead. Keeping the cache warm is faster and safe within
    # the memory budget. (empty_cache is reserved for explicit unload paths.)
    return result


def _infer_with_model_batch(closes_batch: List[np.ndarray], steps: int) -> List[ChronosResult]:
    """Run one batched forward pass over many context series.

    Chronos-Bolt's predict_quantiles accepts a list of 1-D tensors of differing
    lengths and returns a (batch, steps, quantiles) tensor. This is a single GPU
    dispatch instead of len(batch) separate ones.
    """
    import torch

    global _last_inference_latency_ms, _last_successful_inference_ts, _healthy

    started_at = time.time()

    device = next(_pipeline.model.parameters()).device if hasattr(_pipeline, "model") else torch.device("cpu")
    contexts = [torch.tensor(c, dtype=torch.float32).to(device) for c in closes_batch]

    with torch.inference_mode():
        forecast = _pipeline.predict_quantiles(
            contexts,
            prediction_length=steps,
            quantile_levels=QUANTILE_LEVELS,
        )
    if isinstance(forecast, tuple):
        forecast = forecast[0]
    # forecast shape: (batch, steps, len(quantile_levels))
    forecast_np = forecast.cpu().numpy()

    results: List[ChronosResult] = []
    for b, closes in enumerate(closes_batch):
        quantile_dict: Dict[str, List[float]] = {}
        for idx, q in enumerate(QUANTILE_LEVELS):
            key = f"q{int(q * 100)}"
            quantile_dict[key] = [round(float(v), 4) for v in forecast_np[b, :, idx]]

        median = quantile_dict["q50"]
        last_close = float(closes[-1])
        ret_pct = ((median[-1] - last_close) / last_close) * 100 if last_close else 0.0
        trend = "bullish" if ret_pct > 0.3 else ("bearish" if ret_pct < -0.3 else "neutral")

        results.append(ChronosResult(
            median_forecast=[round(v, 4) for v in median],
            quantile_forecasts=quantile_dict,
            trend=trend,
            forecast_return_pct=round(ret_pct, 4),
            source="model",
        ))

    _last_inference_latency_ms = round((time.time() - started_at) * 1000, 2)
    _last_successful_inference_ts = time.strftime("%Y-%m-%d %H:%M:%S")
    _healthy = True
    return results


# ---------------------------------------------------------------------------
# Unavailable-model abstention
# ---------------------------------------------------------------------------
def _infer_fallback(closes: np.ndarray, steps: int) -> ChronosResult:
    """Return an explicit abstention when the forecasting model is unavailable."""
    del closes, steps
    return ChronosResult(
        median_forecast=[],
        quantile_forecasts={},
        trend="neutral",
        forecast_return_pct=None,
        source="unavailable",
    )


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------
def _preprocess(closes_list: List[float]) -> tuple[np.ndarray, float]:
    """Validate + optionally EMA-smooth an input series.

    Returns (closes_for_model, actual_last_close). The smoothing is applied to
    the MODEL INPUT only; forecast_return_pct is always measured against the
    unsmoothed actual last close (see _postprocess).
    """
    closes = np.array(closes_list, dtype=np.float64)
    if closes.ndim != 1 or len(closes) < 2:
        raise ValueError("closes must be a 1-D array with at least 2 elements")

    actual_last = float(closes[-1])

    # Noise reduction for highly volatile assets (model INPUT only)
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

    return closes, actual_last


def _postprocess(result: ChronosResult, closes: np.ndarray, actual_last: float) -> ChronosResult:
    """Recompute return% against the true last close and rebase forecast levels
    from smoothed space back to the actual last close. Shared by single + batch."""
    # Return % must be computed from the pre-rebase (smoothed-space) forecast
    # level against the actual last traded close: recomputing it after the
    # rebase algebraically cancels back to the smoothed-space return
    # (m·a/s − a)/a = m/s − 1, reintroducing the volatile-stock ranking bias.
    if result.median_forecast and actual_last:
        ret_pct = ((result.median_forecast[-1] - actual_last) / actual_last) * 100
        result.forecast_return_pct = round(ret_pct, 4)
        result.trend = "bullish" if ret_pct > 0.3 else ("bearish" if ret_pct < -0.3 else "neutral")

    # Rebase forecasts from smoothed space to the actual last traded close so
    # median/quantile prices are consistent with the caller's data.
    smoothed_last = float(closes[-1])
    if smoothed_last and actual_last and smoothed_last != actual_last:
        rebase = actual_last / smoothed_last
        result.median_forecast = [round(v * rebase, 4) for v in result.median_forecast]
        result.quantile_forecasts = {
            k: [round(v * rebase, 4) for v in vals]
            for k, vals in result.quantile_forecasts.items()
        }

    return result


def infer(closes_list: List[float], steps: int = FORECAST_STEPS) -> ChronosResult:
    """
    Run Chronos inference on an array of close prices.

    Parameters
    ----------
    closes_list : list[float]  — recent close prices (at least 5 recommended)
    steps       : int          — number of forecast steps (default 5)

    Returns
    -------
    ChronosResult with a model forecast or an explicit unavailable abstention.
    """
    steps = max(1, min(steps, 30))  # safety clamp
    closes, actual_last = _preprocess(closes_list)

    result: Optional[ChronosResult] = None
    if _model_loaded:
        try:
            result = _infer_with_model(closes, steps)
        except Exception as exc:
            logger.error("Chronos model inference failed; abstaining: %s", exc)

    if result is None:
        result = _infer_fallback(closes, steps)

    return _postprocess(result, closes, actual_last)


def infer_batch(closes_batch: List[List[float]], steps: int = FORECAST_STEPS) -> List[ChronosResult]:
    """
    Forecast many series in a SINGLE batched GPU call.

    Chronos-Bolt accepts a list of variable-length context tensors and returns a
    (batch, steps, quantiles) tensor from one forward pass — far cheaper than N
    serial calls, and the right way to use the RTX 3050 for this workload.

    Abstains with empty forecasts for unavailable model results. Preserves input
    order 1:1.
    """
    steps = max(1, min(steps, 30))
    n = len(closes_batch)
    if n == 0:
        return []

    # Preprocess every series; keep the smoothed arrays + actual last closes so
    # each result can be post-processed independently.
    prepped: List[tuple[Optional[np.ndarray], Optional[float], Optional[str]]] = []
    for raw in closes_batch:
        try:
            closes, actual_last = _preprocess(raw)
            prepped.append((closes, actual_last, None))
        except Exception as exc:  # invalid series — mark for neutral abstention
            prepped.append((None, None, str(exc)))

    results: List[Optional[ChronosResult]] = [None] * n

    # Batched model path
    if _model_loaded:
        valid_idx = [i for i, (c, _, err) in enumerate(prepped) if c is not None and err is None]
        if valid_idx:
            try:
                batch_results = _infer_with_model_batch([prepped[i][0] for i in valid_idx], steps)
                for slot, res in zip(valid_idx, batch_results):
                    results[slot] = res
            except Exception as exc:
                logger.error("Chronos batched inference failed, falling back per-series: %s", exc)

    # Fill any gaps (model unavailable or batch failed) with an unavailable result.
    for i, (closes, actual_last, err) in enumerate(prepped):
        if results[i] is not None:
            results[i] = _postprocess(results[i], closes, actual_last)  # type: ignore[arg-type]
            continue
        if closes is None:
            # Invalid input — return a neutral, empty forecast rather than raising.
            results[i] = ChronosResult(
                median_forecast=[], quantile_forecasts={}, trend="neutral",
                forecast_return_pct=None, source="error",
            )
            continue
        results[i] = _infer_fallback(closes, steps)

    return results  # type: ignore[return-value]
