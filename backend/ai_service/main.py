"""
AI Inference Microservice — FastAPI on port 8001.

• Loads Technical Pattern Engine and Chronos-Bolt-Tiny **once** at startup.
• Provides batch and single-model inference endpoints.
• Graceful degradation: if a model fails to load the service still starts
  and returns rule-based fallback scores.
• Full CORS support, structured logging, health-check endpoint.
"""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
import subprocess
import time
from contextlib import asynccontextmanager, suppress
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import importlib
from typing import Any, Dict, List, Optional

import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, field_validator

from models import technical_pattern_engine, chronos_service
from sentiment import analyze_sentiment

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-7s | %(name)s | %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("ai_service")

_HEALTH_REFRESH_INTERVAL_SEC = 60.0
_HEALTH_MONITOR_TASK: Optional[asyncio.Task[None]] = None
_LAST_HEALTH_SNAPSHOT: Optional[Dict[str, Any]] = None
_LAST_HEALTH_REFRESH_TS: float = 0.0


class RuntimeDiagnostics:
    """Collect live runtime diagnostics from torch, ONNX Runtime, and the OS."""

    @staticmethod
    def _read_gpu_utilization_pct() -> Optional[float]:
        if shutil.which("nvidia-smi") is None:
            return None

        try:
            proc = subprocess.run(
                [
                    "nvidia-smi",
                    "--query-gpu=utilization.gpu",
                    "--format=csv,noheader,nounits",
                ],
                capture_output=True,
                text=True,
                timeout=2,
                check=False,
            )
            output = proc.stdout.strip().splitlines()
            if not output:
                return None
            return float(output[0].strip())
        except Exception:
            return None

    @classmethod
    def collect(cls) -> Dict[str, Any]:
        import torch

        cuda_available = torch.cuda.is_available()
        device_count = torch.cuda.device_count() if cuda_available else 0
        cuda_version = torch.version.cuda or None
        gpu_model = torch.cuda.get_device_name(0) if cuda_available and device_count > 0 else None

        vram_total_gb = 0.0
        vram_used_gb = 0.0
        vram_free_gb = 0.0
        gpu_utilization_pct = None
        inference_device = "CPU"

        if cuda_available and device_count > 0:
            inference_device = "GPU"
            try:
                free_bytes, total_bytes = torch.cuda.mem_get_info(0)
                used_bytes = total_bytes - free_bytes
            except Exception:
                props = torch.cuda.get_device_properties(0)
                total_bytes = props.total_memory
                used_bytes = torch.cuda.memory_allocated(0)
                free_bytes = max(total_bytes - used_bytes, 0)

            vram_total_gb = round(total_bytes / (1024 ** 3), 2)
            vram_used_gb = round(used_bytes / (1024 ** 3), 2)
            vram_free_gb = round(free_bytes / (1024 ** 3), 2)
            gpu_utilization_pct = cls._read_gpu_utilization_pct()

        onnx_providers: List[str] = []
        onnx_gpu_available = False
        try:
            import onnxruntime as ort

            onnx_providers = ort.get_available_providers()
            onnx_gpu_available = "CUDAExecutionProvider" in onnx_providers
            if onnx_gpu_available:
                inference_device = "GPU"
        except Exception:
            onnx_providers = []

        tensorrt_ready = False
        try:
            import tensorrt  # noqa: F401

            tensorrt_ready = True
        except Exception:
            tensorrt_ready = False

        system_memory_used_mb = 0
        try:
            import psutil

            system_memory_used_mb = int(psutil.Process(os.getpid()).memory_info().rss / (1024 * 1024))
        except Exception:
            system_memory_used_mb = 0

        return {
            "checked_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "cuda_available": cuda_available,
            "device_count": device_count,
            "gpu_model": gpu_model,
            "cuda_version": cuda_version,
            "vram_total_gb": vram_total_gb,
            "vram_used_gb": vram_used_gb,
            "vram_free_gb": vram_free_gb,
            "gpu_utilization_pct": gpu_utilization_pct,
            "onnx_providers": onnx_providers,
            "onnx_gpu_available": onnx_gpu_available,
            "tensorrt_ready": tensorrt_ready,
            "pytorch_cuda": cuda_available,
            "inference_device": inference_device,
            "system_memory_used_mb": system_memory_used_mb,
        }


def _build_health_snapshot() -> Dict[str, Any]:
    technical_engine_status = technical_pattern_engine.get_status()
    chronos_status = chronos_service.get_status()
    runtime = RuntimeDiagnostics.collect()

    ai_enabled = bool(
        technical_engine_status.get("loaded")
        and technical_engine_status.get("healthy")
        and chronos_status.get("loaded")
        and chronos_status.get("healthy")
    )
    ai_mode = "AI Mode" if ai_enabled else "Fallback Mode"
    ranking_provider = "AI Ranking" if ai_enabled else "Technical Ranking"
    status = "healthy" if ai_enabled else "degraded"

    model_load_times = [
        value
        for value in [technical_engine_status.get("load_time_ms"), chronos_status.get("load_time_ms")]
        if isinstance(value, (int, float))
    ]
    total_model_load_time_ms = round(sum(model_load_times), 2) if model_load_times else None

    diagnostics: Dict[str, Any] = {
        "last_inference_ts": InferenceStats.last_inference_ts,
        "avg_inference_time_ms": InferenceStats.get_avg_ms(),
        "system_memory_used_mb": runtime["system_memory_used_mb"],
        "model_load_time_ms": total_model_load_time_ms,
        "gpu_utilization_pct": runtime["gpu_utilization_pct"],
        "inference_device": runtime["inference_device"],
        "onnx_providers": runtime["onnx_providers"],
        "last_health_check_ts": runtime["checked_at"],
        "last_successful_inference_ts": technical_engine_status.get("last_successful_inference_ts")
        or chronos_status.get("last_successful_inference_ts"),
    }

    return {
        "status": status,
        "ai_mode": ai_mode,
        "ranking_provider": ranking_provider,
        "uptime_seconds": round(time.time() - _start_time, 2),
        "models": {
            "technical_engine": technical_engine_status,
            "chronos": chronos_status,
        },
        "hardware": runtime,
        "diagnostics": diagnostics,
    }


def _refresh_health_snapshot() -> Dict[str, Any]:
    global _LAST_HEALTH_SNAPSHOT, _LAST_HEALTH_REFRESH_TS

    snapshot = _build_health_snapshot()
    _LAST_HEALTH_SNAPSHOT = snapshot
    _LAST_HEALTH_REFRESH_TS = time.time()
    return snapshot


async def _monitor_health() -> None:
    while True:
        try:
            _refresh_health_snapshot()
        except Exception:
            logger.exception("AI health refresh failed")
        await asyncio.sleep(_HEALTH_REFRESH_INTERVAL_SEC)

# ---------------------------------------------------------------------------
# Inference Metrics Tracker (Critical Issue #3 & #12)
# ---------------------------------------------------------------------------
class InferenceStats:
    last_inference_ts: Optional[str] = None
    inference_count: int = 0
    total_latency_ms: float = 0.0

    @classmethod
    def record(cls, latency_ms: float):
        cls.last_inference_ts = time.strftime("%Y-%m-%d %H:%M:%S")
        cls.inference_count += 1
        cls.total_latency_ms += latency_ms

    @classmethod
    def get_avg_ms(cls) -> float:
        if cls.inference_count == 0:
            return 0.0
        return round(cls.total_latency_ms / cls.inference_count, 2)


# ---------------------------------------------------------------------------
# Startup / Shutdown
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    """Load models once at startup; clean up on shutdown."""
    logger.info("=== AI Service starting - loading models ===")

    def _load_all_models() -> None:
        """Heavy model loading — runs in a background thread so the server
        can start accepting health-check connections immediately."""
        t0 = time.time()
        try:
            from sentiment import init_models
            init_models()
        except Exception:
            logger.exception("Failed to load sentiment model")

        try:
            technical_pattern_engine.load_model()
        except Exception:
            logger.exception("Failed to load Technical Pattern Engine")

        try:
            chronos_service.load_model()
        except Exception:
            logger.exception("Failed to load Chronos model")

        _refresh_health_snapshot()
        logger.info("=== Model loading completed in %.2f s ===", time.time() - t0)

    # Start model loading in a background thread so Uvicorn binds to :8001
    # immediately.  The /health endpoint already handles degraded mode when
    # models aren't ready yet.
    import threading
    loader = threading.Thread(target=_load_all_models, name="model-loader", daemon=True)
    loader.start()
    logger.info("=== Loading models in background thread ===")

    global _HEALTH_MONITOR_TASK
    _HEALTH_MONITOR_TASK = asyncio.create_task(_monitor_health())
    yield
    if _HEALTH_MONITOR_TASK is not None:
        _HEALTH_MONITOR_TASK.cancel()
        with suppress(asyncio.CancelledError):
            await _HEALTH_MONITOR_TASK
    logger.info("=== AI Service shutting down ===")


app = FastAPI(
    title="UpstoxBot AI Inference Service",
    version="1.0.0",
    description="Financial AI inference using Kronos and Chronos-Bolt models.",
    lifespan=lifespan,
)

def _cors_origins() -> List[str]:
    configured = os.getenv("AI_CORS_ORIGINS") or os.getenv("FRONTEND_APP_URL") or ""
    origins = [origin.strip() for origin in configured.split(",") if origin.strip()]
    if origins:
        return origins
    return [
        "http://localhost:3000",
        "http://localhost:5000",
        "http://localhost:5173",
        "http://127.0.0.1:3000",
        "http://127.0.0.1:5000",
        "http://127.0.0.1:5173",
    ]


# ---------------------------------------------------------------------------
# CORS
# ---------------------------------------------------------------------------
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Request / Response schemas
# ---------------------------------------------------------------------------

class CandidateRequest(BaseModel):
    symbol: str
    ohlcv: List[List[float]] = Field(..., min_length=2, description="[[o,h,l,c,v], …]")
    closes: Optional[List[float]] = Field(None, description="Close prices for Chronos; auto-derived from ohlcv if absent")
    features: Optional[Dict[str, Any]] = Field(default_factory=dict, description="Extra indicators")

    @field_validator("ohlcv", mode="before")
    @classmethod
    def _validate_ohlcv(cls, v: Any) -> Any:
        if not isinstance(v, list) or len(v) < 2:
            raise ValueError("ohlcv must contain at least 2 candles")
        return v


class BatchRequest(BaseModel):
    candidates: List[CandidateRequest] = Field(..., min_length=1, max_length=200)


class TechnicalRankingRequest(BaseModel):
    ohlcv: List[List[float]] = Field(..., min_length=2)
    features: Optional[Dict[str, Any]] = Field(default_factory=dict)


class ChronosRequest(BaseModel):
    closes: List[float] = Field(..., min_length=2)
    steps: Optional[int] = Field(5, ge=1, le=30)


class TechnicalRankingResponse(BaseModel):
    bullish_probability: float
    confidence: float
    detected_patterns: List[str]
    source: str


class ChronosResponse(BaseModel):
    median_forecast: List[float]
    quantile_forecasts: Dict[str, List[float]]
    trend: str
    forecast_return_pct: float
    source: str


class CandidateScore(BaseModel):
    symbol: str
    kronos: TechnicalRankingResponse
    chronos: ChronosResponse
    sentiment_score: float = Field(default=0.0, description="News sentiment score -1.0 to 1.0")
    world_sentiment_score: float = Field(default=0.0, description="World politics sentiment score -1.0 to 1.0")
    composite_score: float = Field(description="Blended AI score 0-100")


class BatchResponse(BaseModel):
    results: List[CandidateScore]
    processing_time_ms: float


class HealthResponse(BaseModel):
    status: str
    ai_mode: str
    ranking_provider: str
    uptime_seconds: float
    models: Dict[str, Any]
    hardware: Dict[str, Any]
    diagnostics: Dict[str, Any]


# ---------------------------------------------------------------------------
# Globals
# ---------------------------------------------------------------------------
_start_time: float = time.time()

# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/health", response_model=HealthResponse, tags=["Health"])
async def health():
    """Return service health, model status, and rich GPU/CUDA diagnostics."""
    snapshot = _LAST_HEALTH_SNAPSHOT
    if snapshot is None or (time.time() - _LAST_HEALTH_REFRESH_TS) > _HEALTH_REFRESH_INTERVAL_SEC:
        snapshot = _refresh_health_snapshot()

    return HealthResponse(
        status=snapshot["status"],
        ai_mode=snapshot["ai_mode"],
        ranking_provider=snapshot["ranking_provider"],
        uptime_seconds=snapshot["uptime_seconds"],
        models=snapshot["models"],
        hardware=snapshot["hardware"],
        diagnostics=snapshot["diagnostics"],
    )


@app.post("/inference/technical_ranking", response_model=TechnicalRankingResponse, tags=["Inference"])
async def infer_technical_ranking(req: TechnicalRankingRequest):
    """Single Technical Pattern Engine inference on OHLCV data."""
    t0 = time.time()
    try:
        result = technical_pattern_engine.infer(req.ohlcv, req.features or {})
        InferenceStats.record((time.time() - t0) * 1000)
        return TechnicalRankingResponse(
            bullish_probability=result.bullish_probability,
            confidence=result.confidence,
            detected_patterns=result.detected_patterns,
            source=result.source,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except Exception as exc:
        logger.exception("Technical Pattern Engine inference error")
        raise HTTPException(status_code=500, detail=f"Inference failed: {exc}")


@app.post("/inference/chronos", response_model=ChronosResponse, tags=["Inference"])
async def infer_chronos(req: ChronosRequest):
    """Single Chronos inference on close prices."""
    t0 = time.time()
    try:
        result = chronos_service.infer(req.closes, req.steps or 5)
        InferenceStats.record((time.time() - t0) * 1000)
        return ChronosResponse(
            median_forecast=result.median_forecast,
            quantile_forecasts=result.quantile_forecasts,
            trend=result.trend,
            forecast_return_pct=result.forecast_return_pct,
            source=result.source,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except Exception as exc:
        logger.exception("Chronos inference error")
        raise HTTPException(status_code=500, detail=f"Inference failed: {exc}")


def _compute_composite_score(kr: technical_pattern_engine.TechnicalPatternResult, cr: chronos_service.ChronosResult, sentiment_dict: Dict[str, float]) -> float:
    """
    Blend Technical bullish probability, Chronos forecast, and news sentiment into a 0-100 score.
    """
    technical_component = kr.bullish_probability * 50

    import math
    chronos_raw = 1 / (1 + math.exp(-cr.forecast_return_pct))  # 0..1
    chronos_component = chronos_raw * 30

    confidence_component = kr.confidence * 15
    
    # Advanced Sentiment Component using blended composite
    sentiment_component = sentiment_dict.get('composite', 0.0) * 5.0

    score = technical_component + chronos_component + confidence_component + sentiment_component
    
    # Macro Crash Risk Penalty
    world_score = sentiment_dict.get('world_score', 0.0)
    if world_score < -0.5:
        logger.warning("Severe negative world politics sentiment detected. Applying macro crash penalty.")
        score -= 15.0

    return round(max(0, min(100, score)), 2)


@app.post("/inference/batch", response_model=BatchResponse, tags=["Inference"])
async def infer_batch(req: BatchRequest):
    """Batch inference — runs Technical Pattern Engine + Chronos for each candidate and returns
    a composite AI score (0-100)."""
    t0 = time.time()
    
    # Semaphore to prevent overwhelming CPU/GPU with too many concurrent threads
    sem = asyncio.Semaphore(4)

    async def process_candidate(cand: CandidateRequest) -> CandidateScore:
        async with sem:
            try:
                closes = cand.closes
                if closes is None or len(closes) < 2:
                    closes = [row[3] for row in cand.ohlcv]

                # Run heavy inference in separate threads to avoid blocking the event loop
                kr, cr = await asyncio.gather(
                    asyncio.to_thread(technical_pattern_engine.infer, cand.ohlcv, cand.features or {}),
                    asyncio.to_thread(chronos_service.infer, closes)
                )
                
                # Sentiment is now fully async via httpx
                sentiment_dict = await analyze_sentiment(cand.symbol)
                if isinstance(sentiment_dict, float):
                    sentiment_dict = {"symbol_specific_score": sentiment_dict, "market_wide_score": 0.0, "world_score": 0.0, "composite": sentiment_dict}

                composite = _compute_composite_score(kr, cr, sentiment_dict)

                return CandidateScore(
                    symbol=cand.symbol,
                    technical_ranking=TechnicalRankingResponse(
                        bullish_probability=kr.bullish_probability,
                        confidence=kr.confidence,
                        detected_patterns=kr.detected_patterns,
                        source=kr.source,
                    ),
                    chronos=ChronosResponse(
                        median_forecast=cr.median_forecast,
                        quantile_forecasts=cr.quantile_forecasts,
                        trend=cr.trend,
                        forecast_return_pct=cr.forecast_return_pct,
                        source=cr.source,
                    ),
                    sentiment_score=sentiment_dict.get("symbol_specific_score", 0.0),
                    world_sentiment_score=sentiment_dict.get("world_score", 0.0),
                    composite_score=composite,
                )
            except Exception as exc:
                logger.error("Batch inference failed for %s: %s", cand.symbol, exc)
                return CandidateScore(
                    symbol=cand.symbol,
                    technical_ranking=TechnicalRankingResponse(
                        bullish_probability=0.5,
                        confidence=0.0,
                        detected_patterns=[],
                        source="error",
                    ),
                    chronos=ChronosResponse(
                        median_forecast=[],
                        quantile_forecasts={},
                        trend="neutral",
                        forecast_return_pct=0.0,
                        source="error",
                    ),
                    sentiment_score=0.0,
                    world_sentiment_score=0.0,
                    composite_score=50.0,
                )

    # Process all candidates concurrently with bounded concurrency
    results = await asyncio.gather(*(process_candidate(cand) for cand in req.candidates))

    elapsed_ms = (time.time() - t0) * 1000
    InferenceStats.record(elapsed_ms)
    logger.info("Batch inference: %d candidates in %.1f ms", len(results), elapsed_ms)

    return BatchResponse(results=results, processing_time_ms=round(elapsed_ms, 2))


# ---------------------------------------------------------------------------
# Auth & Timing middleware
# ---------------------------------------------------------------------------
@app.middleware("http")
async def add_timing_header(request: Request, call_next):
    t0 = time.time()
    response = await call_next(request)
    elapsed = (time.time() - t0) * 1000
    response.headers["X-Process-Time-Ms"] = f"{elapsed:.2f}"
    return response

@app.middleware("http")
async def verify_auth_token(request: Request, call_next):
    if request.url.path == "/health":
        return await call_next(request)
    
    expected_token = os.getenv("AI_SERVICE_TOKEN")
    if expected_token:
        token = request.headers.get("X-AI-Service-Token")
        if not token or token != expected_token:
            from fastapi.responses import JSONResponse
            return JSONResponse(status_code=401, content={"detail": "Unauthorized"})
            
    return await call_next(request)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host="127.0.0.1",
        port=8001,
        log_level="info",
        reload=False,
    )
