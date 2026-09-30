"""
AI Inference Microservice — FastAPI on port 8001.

• Loads Technical Pattern Engine and Chronos-Bolt-Small **once** at startup.
• Provides batch and single-model inference endpoints.
• Graceful degradation: if a model fails to load the service still starts
  and returns rule-based fallback scores.
• Full CORS support, structured logging, health-check endpoint.
"""

from __future__ import annotations

import asyncio
import logging
import math
import os
import shutil
import subprocess
import time
from contextlib import asynccontextmanager, suppress
import sys
import importlib
import threading
from typing import Any, Dict, List, Optional

import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from pydantic import BaseModel, Field, field_validator

# Load .env / .env.local BEFORE importing any service module. Every service
# singleton reads its configuration in __init__ (Laya
# weights, ranker artifact paths), so this must run first or those values are
# frozen to hardcoded defaults.
from env_loader import load_env_files, resolve_env_paths

_ENV_FILES_APPLIED = load_env_files(resolve_env_paths(os.path.dirname(os.path.abspath(__file__))))

from models import technical_pattern_engine, chronos_service
from models import ranker_service
from models.numeric_utils import finite_clamp, safe_div, sanitize_float
from models.system1_base import resolve_risk_reward
from models.confluence_service import confluence_service
from models.laya_service import laya_service, LayaDecision
from models.system1_service import system1_service, System1Decision
from models.rl_agent import rl_agent_service
from rl_lifecycle import rl_lifecycle_manager
from ranker_lifecycle import ranker_lifecycle_manager
from sentiment import analyze_sentiment
import sentiment as sentiment_module

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-7s | %(name)s | %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("ai_service")

if _ENV_FILES_APPLIED:
    logger.info(
        "Loaded %d config value(s) from .env/.env.local (e.g. %s)",
        len(_ENV_FILES_APPLIED),
        ", ".join(sorted(_ENV_FILES_APPLIED)[:6]),
    )

_HEALTH_REFRESH_INTERVAL_SEC = 60.0
_HEALTH_MONITOR_TASK: Optional[asyncio.Task[None]] = None
_LAST_HEALTH_SNAPSHOT: Optional[Dict[str, Any]] = None
_LAST_HEALTH_REFRESH_TS: float = 0.0
_HEALTH_LOCK = threading.Lock()

# Guards against concurrent confluence retrains (each would fork a full
# training subprocess). See trigger_confluence_train.
confluence_train_lock = threading.Lock()

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
        try:
            import torch
            torch_available = True
        except Exception:
            torch = None
            torch_available = False

        cuda_available = bool(torch_available and torch.cuda.is_available())
        device_count = torch.cuda.device_count() if cuda_available else 0
        cuda_version = (torch.version.cuda or None) if torch_available else None
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
            "pytorch_available": torch_available,
            "pytorch_cuda": cuda_available,
            "inference_device": inference_device,
            "system_memory_used_mb": system_memory_used_mb,
        }


def _build_health_snapshot() -> Dict[str, Any]:
    technical_engine_status = technical_pattern_engine.get_status()
    chronos_status = chronos_service.get_status()
    ranker_status = ranker_service.get_status()
    sentiment_status = sentiment_module.get_status()
    confluence_status = confluence_service.get_status()
    rl_status = rl_lifecycle_manager.get_status()
    rl_inference_status = rl_agent_service.get_status()
    laya_status = laya_service.get_status()
    system1_status = system1_service.get_status()
    runtime = RuntimeDiagnostics.collect()

    core_ready = bool(
        technical_engine_status.get("loaded")
        and technical_engine_status.get("healthy")
        and chronos_status.get("loaded")
        and chronos_status.get("healthy")
    )
    degraded_components = []
    # Components that are working correctly but have no trained model yet. These
    # train on closed-trade history, which a fresh install does not have, so this
    # is a cold start rather than a fault. Listing them next to genuinely broken
    # components made every health check look alarming and hid real failures.
    cold_start_components = []
    if not core_ready:
        degraded_components.append("core_forecasting")
    if sentiment_status.get("fallback_active"):
        degraded_components.append("sentiment")
    if not ranker_status.get("loaded"):
        degraded_components.append("ranker")
    # A loaded ranker is not the same as an ACTIVE ranker. A feature-width
    # mismatch or a candidate without ranker features yields a null
    # win_probability, and the caller then skips the hard P(win) < threshold
    # veto entirely. Flag that explicitly rather than reporting "healthy".
    elif ranker_status.get("width_mismatch_rows") or ranker_status.get("without_features_rows"):
        degraded_components.append("ranker_contract_mismatch")
    if confluence_status.get("fallback_active"):
        if confluence_status.get("cold_start"):
            cold_start_components.append("confluence")
        else:
            degraded_components.append("confluence")
    if not rl_agent_service.is_loaded:
        if getattr(rl_agent_service, "cold_start", True):
            cold_start_components.append("rl")
        else:
            degraded_components.append("rl")
    if not laya_status.get("healthy"):
        degraded_components.append("laya")

    # A loaded ranker that has never produced a prediction is not healthy and
    # not cold-start either: the artifact exists and is meant to be used, so
    # every candidate is bypassing the only calibrated veto. This is the exact
    # failure that let the ranker sit disarmed (rankerIncomplete was true for
    # every production candidate) while /health stayed green.
    ranker_gate_disarmed = bool(
        ranker_status.get("loaded") and ranker_status.get("gate_never_exercised")
    )
    if ranker_gate_disarmed:
        degraded_components.append("ranker_gate_disarmed")

    # Truthful verdict. Previously status was healthy on the strength of the
    # rule engine plus Chronos alone, so an untrained confluence model, an
    # absent RL policy and a disarmed ranker all sat behind a green light and
    # an "AI Mode" string that the dashboard renders as a healthy LED.
    if not core_ready or degraded_components:
        status = "degraded"
    else:
        status = "healthy"

    # What is actually contributing signal to a decision right now. This is
    # the field to read when asking "is the AI actually deciding anything".
    contributing_to_decisions = {
        "technical_rules": bool(technical_engine_status.get("loaded")),
        "chronos_forecast": bool(chronos_status.get("loaded")),
        "sentiment": not sentiment_status.get("fallback_active"),
        "laya_checkpoint": bool(laya_status.get("weights_loaded")),
        "ranker_calibrated_pwin": bool(ranker_status.get("gate_active")),
    }
    trained_model_count = sum(
        1 for key in ("chronos_forecast", "laya_checkpoint", "ranker_calibrated_pwin")
        if contributing_to_decisions[key]
    )

    ai_mode = "AI Mode" if status == "healthy" else "Fallback Mode"
    if degraded_components:
        ai_mode += " (degraded: " + ", ".join(degraded_components) + ")"
    elif cold_start_components:
        ai_mode += " (untrained: " + ", ".join(cold_start_components) + " - using fallbacks)"
    ranking_provider = "AI Ranking" if ranker_status.get("loaded") else "Technical Ranking"

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
        # Whether any component with real weights is actually contributing.
        # "AI Mode" used to be printed whenever the rule engine and Chronos
        # loaded, which is true even when every trained model is absent.
        "trained_model_count": trained_model_count,
        "contributing_to_decisions": contributing_to_decisions,
        "degraded_components": degraded_components,
        "cold_start_components": cold_start_components,
        "ranking_provider": ranking_provider,
        "uptime_seconds": round(time.time() - _start_time, 2),
        "models": {
            "technical_engine": technical_engine_status,
            "chronos": chronos_status,
            "ranker": ranker_status,
            "confluence": confluence_status,
            # Report BOTH the training lifecycle (READY/TRAINING) and whether an
            # RL model is actually loaded for inference. A service with no
            # rl_model.zip would otherwise show READY while silently serving the
            # no_model fallback.
            "rl_model": rl_status,
            "rl_inference": rl_inference_status,
            "rl_inference_loaded": rl_agent_service.is_loaded,
            "sentiment": sentiment_status,
                    "laya": laya_status,
            "system1": system1_status,
        },
        "hardware": runtime,
        "diagnostics": diagnostics,
    }


def _refresh_health_snapshot() -> Dict[str, Any]:
    global _LAST_HEALTH_SNAPSHOT, _LAST_HEALTH_REFRESH_TS

    snapshot = _build_health_snapshot()
    with _HEALTH_LOCK:
        _LAST_HEALTH_SNAPSHOT = snapshot
        _LAST_HEALTH_REFRESH_TS = time.time()
    return snapshot


async def _monitor_health() -> None:
    while True:
        try:
            await asyncio.to_thread(_refresh_health_snapshot)
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

        try:
            ranker_service.load_model()
        except Exception:
            logger.exception("Failed to load learned ranker")

        try:
            laya_service.reload_config()
        except Exception:
            logger.exception("Failed to load LAYA service config")

        try:
            system1_service.reload_config()
        except Exception:
            logger.exception("Failed to load System-1 service config")

        _refresh_health_snapshot()
        logger.info("=== Model loading completed in %.2f s ===", time.time() - t0)

    # Start model loading in a background thread so Uvicorn binds to :8001
    # immediately.  The /health endpoint already handles degraded mode when
    # models aren't ready yet.
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
    title="Mimir AI Inference Service",
    version="1.0.0",
    description="Financial AI inference using Technical Pattern Engine, Chronos-Bolt-Small, FinBERT, and optional learned rankers.",
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
    ohlcv: List[List[float]] = Field(..., min_length=20, description="[[o,h,l,c,v], …]")
    closes: Optional[List[float]] = Field(None, description="Close prices for Chronos; auto-derived from ohlcv if absent")
    features: Optional[Dict[str, Any]] = Field(default_factory=dict, description="Extra indicators")
    as_of_date: Optional[str] = Field(None, description="ISO date for PIT fundamental lookups")

    @field_validator("ohlcv", mode="before")
    @classmethod
    def _validate_ohlcv(cls, v: Any) -> Any:
        if not isinstance(v, list) or len(v) < 20:
            raise ValueError("ohlcv must contain at least 20 candles for adequate model context")
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
    components: Dict[str, float] = Field(default_factory=dict, description="Score breakdown by sub-components")
    win_probability: Optional[float] = Field(
        default=None,
        description="Calibrated P(target1 before stop) from the learned ranker; null when the ranker is unavailable and callers should use composite_score.",
    )
    jev_decision: Optional[Dict[str, Any]] = Field(
        default=None,
        description="Retired: the TypeSafe Jev cloud engine no longer exists. Always null.",
    )
    laya_decision: Optional[Dict[str, Any]] = Field(
        default=None,
        description="Convai Innovations Laya System-1 decision (verdict, action, confidence, Noul primitives).",
    )
    system1_decision: Optional[Dict[str, Any]] = Field(
        default=None,
        description="Unified System-1 decision (Choice, Score, Noul primitives).",
    )
    scored: bool = Field(
        default=True,
        description="False when this candidate could not be scored and composite_score is a neutral 50 placeholder (per-candidate inference error). Callers must NOT rank an unscored placeholder alongside genuinely-scored candidates.",
    )


class BatchResponse(BaseModel):
    results: List[CandidateScore]
    processing_time_ms: float
    ranker_threshold: Optional[float] = Field(
        default=None,
        description="Recommended P(win) threshold for greenlighting a trade; null when the ranker is unavailable.",
    )
    ranker_loaded: bool = Field(default=False, description="Whether the learned ranker served these scores.")
    jev_enabled: bool = Field(default=False, description="Retired: there is no cloud engine to enable.")
    laya_enabled: bool = Field(default=True, description="Whether Laya System-1 triage is active.")
    system1_enabled: bool = Field(default=True, description="Whether unified System-1 triage is active.")


class System1Request(BaseModel):
    symbol: str
    direction: str = "BUY"
    setup_type: str = "PULLBACK"
    timeframe: str = "15m"
    entry_price: float = 0.0
    stop_loss: float = 0.0
    target1: float = 0.0
    risk_reward_ratio: float = 1.5
    technical_score: float = 50.0
    chronos_trend: str = "neutral"
    sentiment_score: float = 0.0
    order_flow_imbalance_ratio: float = 0.0
    fii_dii_net: float = 0.0
    india_vix: float = 15.0
    market_regime: str = "UNKNOWN"
    win_probability: Optional[float] = None
    preferred_engine: Optional[str] = None


LayaRequest = System1Request


class System1Response(BaseModel):
    model_config = {"protected_namespaces": ()}
    verdict: str
    action: str
    confidence: float
    opportunity_score: float
    gate_reasons: List[str]
    regime_alignment: float
    p_execution_success: float
    p_stop_hunt_risk: float
    p_adverse_regime_shift: float
    provider: str
    model_id: str
    source: str
    latency_ms: float
    position_size_multiplier: float = 1.0


LayaResponse = System1Response


class HealthResponse(BaseModel):
    status: str
    ai_mode: str
    # How many components with real trained weights are actually contributing to
    # a decision, and which ones. This exists because `ai_mode` reports "AI
    # Mode" whenever the rule engine and Chronos load, which is true even when
    # every trained model is absent - so a green light did not mean the AI was
    # deciding anything.
    trained_model_count: int = 0
    contributing_to_decisions: Dict[str, bool] = {}
    # Distinguishes genuinely faulty components from ones that simply have no
    # trained model yet on a fresh install.
    degraded_components: list[str]
    cold_start_components: list[str]
    ranking_provider: str
    uptime_seconds: float
    models: Dict[str, Any]
    hardware: Dict[str, Any]
    diagnostics: Dict[str, Any]


# ---------------------------------------------------------------------------
# Globals
# ---------------------------------------------------------------------------
_start_time: float = time.time()
_gpu_semaphore = asyncio.Semaphore(1)

# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/health", response_model=HealthResponse, tags=["Health"])
async def health():
    """Return service health, model status, and rich GPU/CUDA diagnostics."""
    with _HEALTH_LOCK:
        snapshot = _LAST_HEALTH_SNAPSHOT
        ts = _LAST_HEALTH_REFRESH_TS
    
    if snapshot is None or (time.time() - ts) > _HEALTH_REFRESH_INTERVAL_SEC:
        snapshot = await asyncio.to_thread(_refresh_health_snapshot)

    return HealthResponse(
        status=snapshot["status"],
        ai_mode=snapshot["ai_mode"],
        trained_model_count=snapshot.get("trained_model_count", 0),
        contributing_to_decisions=snapshot.get("contributing_to_decisions", {}),
        degraded_components=snapshot["degraded_components"],
        cold_start_components=snapshot["cold_start_components"],
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
        result = await asyncio.to_thread(technical_pattern_engine.infer, req.ohlcv, req.features or {})
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
        async with _gpu_semaphore:
            result = await asyncio.to_thread(chronos_service.infer, req.closes, req.steps or 5)
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


@app.post("/inference/laya", response_model=LayaResponse, tags=["Inference"])
async def infer_laya(req: LayaRequest):
    """Evaluate candidate state using Convai Innovations Laya System-1 Decision Engine."""
    t0 = time.time()
    try:
        state = req.model_dump()
        result = await asyncio.to_thread(laya_service.evaluate_decision, state)
        InferenceStats.record((time.time() - t0) * 1000)
        return LayaResponse(**result.to_dict())
    except Exception as exc:
        logger.exception("Laya inference error")
        raise HTTPException(status_code=500, detail=f"Laya decision evaluation failed: {exc}")


@app.post("/inference/system1", response_model=System1Response, tags=["Inference"])
async def infer_system1(req: System1Request):
    """Evaluate candidate state using the local Laya System-1 checkpoint."""
    t0 = time.time()
    try:
        state = req.model_dump()
        result = await asyncio.to_thread(system1_service.evaluate_decision, state)
        InferenceStats.record((time.time() - t0) * 1000)
        return System1Response(**result.to_dict())
    except Exception as exc:
        logger.exception("System-1 inference error")
        raise HTTPException(status_code=500, detail=f"System-1 decision evaluation failed: {exc}")


def _compute_composite_score(kr: technical_pattern_engine.TechnicalPatternResult, cr: chronos_service.ChronosResult, sentiment_dict: Dict[str, float], features: Dict[str, Any]) -> tuple[float, dict]:
    """
    Blend Technical bullish probability, Chronos forecast, and news sentiment into a 0-100 score.
    Returns (score, components_dict)

    Every component is coerced to a finite float first. NaN compares False against
    everything, so `max(0, min(100, nan))` evaluates to 100 — meaning a single NaN
    anywhere upstream (a missing close, a null->NaN column mapping, a Postgres
    `double precision` NaN) would hand a candidate a PERFECT 100.0 score for
    corrupt data, with no error and no fallback marker.
    """
    technical_component = sanitize_float(kr.bullish_probability, default=0.5) * 50

    # Scale forecast before sigmoid: realistic short-horizon forecasts are
    # ±0.3-1%, which unscaled maps to 0.43-0.57 — the component barely
    # discriminates. x3 spreads ±1% to 0.05-0.95.
    forecast_pct = sanitize_float(cr.forecast_return_pct, default=0.0, low=-20.0, high=20.0)
    chronos_raw = 1 / (1 + math.exp(-forecast_pct * 3.0))  # 0..1
    chronos_component = chronos_raw * 30

    confidence_component = sanitize_float(kr.confidence, default=0.0) * 15

    # Advanced Sentiment Component using blended composite
    sentiment_component = sanitize_float(sentiment_dict.get('composite', 0.0), default=0.0) * 5.0

    components = {
        "trend_alignment": round(technical_component, 2),
        "forecast_momentum": round(chronos_component, 2),
        "confidence": round(confidence_component, 2),
        "sentiment": round(sentiment_component, 2)
    }

    score = sum(components.values())

    # Macro Crash Risk Penalty (World Sentiment)
    world_score = sanitize_float(sentiment_dict.get('world_score', 0.0), default=0.0)
    if world_score < -0.5:
        logger.warning("Severe negative world politics sentiment detected. Applying macro crash penalty.")
        score -= 15.0
        components["macro_penalty"] = -15.0

    # Micro-structure Order Flow Imbalance (OFI) Boost
    ofi_ratio = sanitize_float(features.get("ofi_ratio", 0.0), default=0.0, low=-10.0, high=10.0)
    if ofi_ratio != 0.0:
        ofi_boost = round(ofi_ratio * 5.0, 2)  # up to +/- 5 score points
        score += ofi_boost
        components["micro_structure_ofi"] = ofi_boost
        
    # FII/DII Divergence Penalty/Boost
    div_penalty = sanitize_float(features.get("macro_divergence_penalty", 0.0), default=0.0, low=-100.0, high=100.0)
    if div_penalty != 0.0:
        score += div_penalty
        components["fii_dii_divergence"] = div_penalty

    return round(finite_clamp(score, 0.0, 100.0, default=50.0), 2), components


@app.post("/inference/batch", response_model=BatchResponse, tags=["Inference"])
async def infer_batch(req: BatchRequest):
    """Batch inference — runs Technical Pattern Engine + Chronos for each candidate and returns
    a composite AI score (0-100)."""
    t0 = time.time()

    # Chronos forecasts for ALL candidates in a single batched GPU call. This
    # replaces the previous pattern of N concurrent single-series calls — one
    # forward pass over the whole batch is dramatically cheaper on the RTX 3050.
    def _closes_for(cand: CandidateRequest) -> List[float]:
        c = cand.closes
        if c is None or len(c) < 2:
            # `row[3]` assumes every row has at least 4 numbers, but
            # `List[List[float]]` accepts ragged rows and the pydantic validator
            # only checks the OUTER list length. An unguarded IndexError here
            # would abort the whole batch and discard every other candidate's
            # work, so bad rows are skipped rather than fatal.
            c = [
                row[3]
                for row in cand.ohlcv
                if len(row) >= 4
            ]
        return c

    closes_batch = [_closes_for(cand) for cand in req.candidates]
    async with _gpu_semaphore:
        chronos_results = await asyncio.to_thread(chronos_service.infer_batch, closes_batch)
    chronos_by_symbol = {
        id(cand): chronos_results[i] for i, cand in enumerate(req.candidates)
    }

    # Learned ranker: one batched P(win) prediction for all candidates. The caller
    # sends the shared candle-derived feature array under features["ranker_features"]
    # (ordered per RANKER_FEATURE_KEYS). Returns None per row when the ranker is
    # unavailable, so each candidate cleanly falls back to the composite score.
    ranker_rows = [
        (cand.features or {}).get("ranker_features") or [] for cand in req.candidates
    ]
    # Rows with no ranker features are classified and counted inside
    # predict_batch, which is the single source of truth for gate coverage.
    # Do not also count them here or the counters double-count.
    ranker_probs = await asyncio.to_thread(ranker_service.predict_batch, ranker_rows)
    win_prob_by_id = {
        id(cand): ranker_probs[i] for i, cand in enumerate(req.candidates)
    }
    # Semaphore bounds the remaining per-candidate CPU work (pattern engine +
    # sentiment). Chronos is already batched, so contention on the GPU is gone.
    sem = asyncio.Semaphore(4)

    def _error_score(symbol: str) -> CandidateScore:
        return CandidateScore(
            symbol=symbol,
            kronos=TechnicalRankingResponse(
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
            components={},
            win_probability=None,
            jev_decision=None,
            laya_decision=None,
            system1_decision=None,
            scored=False,
        )

    # ---- Phase 1: per-candidate enrichment (concurrent, bounded) -----------
    async def prepare_candidate(cand: CandidateRequest) -> Dict[str, Any]:
        cr = chronos_by_symbol[id(cand)]

        kr = await asyncio.to_thread(
            technical_pattern_engine.infer, cand.ohlcv, cand.features or {}
        )

        # Fetch sentiment
        if cand.as_of_date:
            def fetch_historical_sentiment():
                db_url = os.getenv("DATABASE_URL")
                if not db_url:
                    return 0.0, 0.0
                try:
                    import psycopg2
                    from contextlib import closing
                    with closing(psycopg2.connect(db_url)) as conn:
                        with conn.cursor() as cur:
                            cur.execute("""
                                SELECT value FROM fundamental_snapshots
                                WHERE symbol = %s AND field_name = 'sentiment_composite' AND filed_date <= %s
                                ORDER BY filed_date DESC LIMIT 1
                            """, (cand.symbol, cand.as_of_date))
                            row = cur.fetchone()
                            composite_val = float(row[0]) if row else 0.0
                            cur.execute("""
                                SELECT value FROM fundamental_snapshots
                                WHERE field_name = 'sentiment_world' AND filed_date <= %s
                                ORDER BY filed_date DESC LIMIT 1
                            """, (cand.as_of_date,))
                            wrow = cur.fetchone()
                            world_val = float(wrow[0]) if wrow else 0.0
                            return composite_val, world_val
                except Exception as e:
                    logger.error(f"Failed to fetch historical sentiment: {e}")
                    return 0.0, 0.0

            historical_composite, historical_world = await asyncio.to_thread(fetch_historical_sentiment)
            sentiment_dict = {"symbol_specific_score": historical_composite, "market_wide_score": 0.0, "world_score": historical_world, "composite": historical_composite}
        else:
            # Live query
            sentiment_dict = await analyze_sentiment(cand.symbol)
            if isinstance(sentiment_dict, float):
                sentiment_dict = {"symbol_specific_score": sentiment_dict, "market_wide_score": 0.0, "world_score": 0.0, "composite": sentiment_dict}

        cand_feats = cand.features or {}
        composite, components = _compute_composite_score(kr, cr, sentiment_dict, cand_feats)

        # Risk-reward must be a true R multiple. `riskRewardScore` is a
        # NORMALIZED 0-100 score (3.0 == 100) and reading it as an R multiple let
        # a 0.3 R:R setup pass the `rr < 1.2` hard gate with a 100.0 opportunity
        # score and 1.25x size. resolve_risk_reward de-normalizes it.
        risk_reward_ratio = resolve_risk_reward(cand_feats, default=1.5)

        # Assemble the canonical System-1 state. Built here (not in a later
        # phase) because it needs the ranker, Chronos trend, and sentiment.
        system1_state = {
            "symbol": cand.symbol,
            "direction": cand_feats.get("direction", "BUY"),
            "setup_type": cand_feats.get("setup_type") or cand_feats.get("setupType", "UNKNOWN"),
            "timeframe": cand_feats.get("timeframe", "15m"),
            "entry_price": cand_feats.get("entry_price") if cand_feats.get("entry_price") is not None else cand_feats.get("entryPrice", 0.0),
            "stop_loss": cand_feats.get("stop_loss") if cand_feats.get("stop_loss") is not None else cand_feats.get("stopLoss", 0.0),
            "target1": cand_feats.get("target1", 0.0),
            "risk_reward_ratio": risk_reward_ratio,
            "technical_score": round(kr.bullish_probability * 100.0, 2),
            "chronos_trend": cr.trend,
            "sentiment_score": sentiment_dict.get("symbol_specific_score", 0.0),
            "order_flow_imbalance_ratio": cand_feats.get("order_flow_imbalance_ratio") if cand_feats.get("order_flow_imbalance_ratio") is not None else (cand_feats.get("ofi_ratio") if cand_feats.get("ofi_ratio") is not None else cand_feats.get("bidAskImbalance", 0.0)),
            "fii_dii_net": cand_feats.get("fii_dii_net") if cand_feats.get("fii_dii_net") is not None else (cand_feats.get("fiiNet") if cand_feats.get("fiiNet") is not None else cand_feats.get("fiiDiiNetFlowLag", 0.0)),
            "india_vix": cand_feats.get("india_vix") if cand_feats.get("india_vix") is not None else cand_feats.get("vix", 15.0),
            "market_regime": cand_feats.get("market_regime") or cand_feats.get("regime", "UNKNOWN"),
            "win_probability": win_prob_by_id.get(id(cand)),
        }

        return {
            "kr": kr,
            "cr": cr,
            "sentiment": sentiment_dict,
            "composite": composite,
            "components": components,
            "state": system1_state,
        }

    async def _phase1(idx: int, cand: CandidateRequest) -> Optional[Dict[str, Any]]:
        async with sem:
            try:
                return await prepare_candidate(cand)
            except Exception as exc:
                logger.error("Batch inference failed for %s: %s", cand.symbol, exc)
                return None

    prepared = await asyncio.gather(
        *(_phase1(i, cand) for i, cand in enumerate(req.candidates))
    )

    # ---- Phase 2: batched System-1 triage (local Laya) -------------------
    # All candidates go through ONE true-batch inference: Laya issues a single
    # ModernBERT forward pass over every prompt. Issuing one call per candidate
    # was the dominant cost of this endpoint.
    # There is exactly one engine now. Preferred-engine values on individual
    # candidates are retained in the response for provenance, but they no
    # longer select anything: "jev"/"consensus" used to require a cloud API.
    laya_idx = [i for i, prep in enumerate(prepared) if prep is not None]

    laya_by_idx: Dict[int, Any] = {}

    async def _laya_pass(idxs: List[int]) -> None:
        if not idxs:
            return
        states = [prepared[i]["state"] for i in idxs]
        try:
            results = await asyncio.to_thread(laya_service.evaluate_batch, states)
        except Exception as exc:
            logger.error("Laya batch triage failed (%s); retrying per candidate", exc)
            # return_exceptions is essential: a plain gather re-raises the FIRST
            # failure and abandons the rest, which would 500 the whole batch
            # even though most candidates scored fine.
            results = await asyncio.gather(
                *(asyncio.to_thread(laya_service.evaluate_decision, s) for s in states),
                return_exceptions=True,
            )
        for i, res in zip(idxs, results):
            if isinstance(res, BaseException):
                logger.error("Laya per-candidate retry failed for index %s: %s", i, res)
                continue
            laya_by_idx[i] = res

    await _laya_pass(laya_idx)

    # ---- Phase 3: resolve + assemble responses ---------------------------
    def _assemble(idx: int) -> CandidateScore:
        cand = req.candidates[idx]
        prep = prepared[idx]
        if prep is None:
            return _error_score(cand.symbol)

        kr = prep["kr"]
        cr = prep["cr"]
        sentiment_dict = prep["sentiment"]

        laya_dec = laya_by_idx.get(idx)
        # Single engine: the System-1 decision *is* the Laya decision.
        sys1_dec = laya_dec
        # Kept as a field for response-shape compatibility; always None now
        # that the cloud engine is gone.
        jev_dec = None

        return CandidateScore(
            symbol=cand.symbol,
            kronos=TechnicalRankingResponse(
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
            composite_score=prep["composite"],
            components=prep["components"],
            win_probability=win_prob_by_id.get(id(cand)),
            jev_decision=jev_dec.to_dict() if jev_dec is not None else None,
            laya_decision=laya_dec.to_dict() if laya_dec is not None else None,
            system1_decision=sys1_dec.to_dict() if sys1_dec is not None else None,
        )

    results = [_assemble(i) for i in range(len(req.candidates))]

    elapsed_ms = (time.time() - t0) * 1000
    InferenceStats.record(elapsed_ms)
    logger.info(
        "Batch inference: %d candidates in %.1f ms (laya_batched=%d)",
        len(results),
        elapsed_ms,
        len(laya_idx),
    )

    return BatchResponse(
        results=results,
        processing_time_ms=round(elapsed_ms, 2),
        ranker_loaded=ranker_service.is_loaded(),
        ranker_threshold=ranker_service.recommended_threshold(),
        jev_enabled=False,
        laya_enabled=laya_service.get_status().get("enabled", True),
        system1_enabled=system1_service.get_status().get("enabled", True),
    )


class RLPredictRequest(BaseModel):
    symbol: str
    ohlcv: List[List[float]] = Field(..., description="[timestamp, open, high, low, close, volume]")
    vix: float = 15.0
    pcr: float = 1.0
    fii_dii_net: float = 0.0

@app.post("/api/v1/predict_rl", tags=["Inference"])
async def predict_rl(req: RLPredictRequest):
    """Predict using Reinforcement Learning model."""
    try:
        import pandas as pd
        if not req.ohlcv:
            return {"action": "HOLD", "confidence": 0.0, "score_adjustment": 0.0, "isFallback": True, "source": "no_data"}
            
        df = pd.DataFrame(req.ohlcv, columns=["timestamp", "open", "high", "low", "close", "volume"])
        macro_data = {
            "vix": req.vix,
            "pcr": req.pcr,
            "fiiNet": req.fii_dii_net
        }
        result = await asyncio.to_thread(rl_agent_service.predict, df, macro_data)
        return result
    except Exception as e:
        logger.error(f"RL prediction failed for {req.symbol}: {e}")
        return {"action": "HOLD", "confidence": 0.0, "score_adjustment": 0.0, "isFallback": True, "source": "error"}

@app.post("/api/v1/rl_train", tags=["Training"])
async def trigger_rl_train():
    """Trigger the RL training pipeline in the background."""
    started = rl_lifecycle_manager.trigger_training()
    if started:
        return {"message": "RL training started"}
    else:
        return {"message": "RL training already in progress", "status": "TRAINING"}

@app.get("/api/v1/rl_status", tags=["Training"])
async def get_rl_status():
    """Get the current status of the RL training pipeline."""
    return rl_lifecycle_manager.get_status()


from models.confluence_service import confluence_service

class ConfluenceRequest(BaseModel):
    regime: str
    features: Dict[str, float]

class ConfluenceResponse(BaseModel):
    score: float
    fallback: bool = False

@app.post("/confluence_score", response_model=ConfluenceResponse)
def get_confluence_score(req: ConfluenceRequest):
    """
    Returns the regime-gated combination score (0-100) based on the stage inputs.
    """
    try:
        if not confluence_service.models:
            # Try to load models if they were trained since startup
            confluence_service.load_models()
        
        fallback = req.regime not in confluence_service.models
        score = confluence_service.get_score(req.regime, req.features)
        
        return ConfluenceResponse(
            score=score,
            fallback=fallback
        )
    except Exception as e:
        logger.error(f"Error computing confluence score: {e}")
        return ConfluenceResponse(score=50.0, fallback=True)

class RankerTrainRequest(BaseModel):
    data_path: Optional[str] = Field(
        default=None, description="Path to the JSONL training data; defaults to ../data/ranker_train.jsonl"
    )


@app.post("/api/v1/ranker_train", tags=["Training"])
async def trigger_ranker_train(req: RankerTrainRequest):
    """Trigger learned-ranker retraining in the background. Training enforces the
    walk-forward out-of-sample gate and champion-challenger promotion, so this is
    safe to call on a schedule — a weak retrain simply keeps the incumbent."""
    started = ranker_lifecycle_manager.trigger_training(req.data_path)
    if started:
        return {"message": "Ranker training started"}
    return {"message": "Ranker training already in progress", "status": "TRAINING"}


@app.post("/api/v1/confluence_train", tags=["Training"])
async def trigger_confluence_train():
    """Trigger confluence model retraining in the background."""
    here = os.path.dirname(os.path.abspath(__file__))
    script = os.path.join(here, "train_confluence.py")
    data_path = os.path.abspath(os.path.join(here, "..", "data", "confluence_train.jsonl"))

    if not os.path.isfile(script):
        logger.error("Confluence training script not found at %s", script)
        raise HTTPException(status_code=500, detail="train_confluence.py not found")
    if not os.path.isfile(data_path):
        logger.error("Confluence training data not found at %s", data_path)
        raise HTTPException(status_code=500, detail="confluence training data not found")

    # In-flight guard. Without this, N concurrent POSTs each spawn a thread that
    # forks a full retraining subprocess, exhausting CPU and RAM.
    if not confluence_train_lock.acquire(blocking=False):
        return {"message": "Confluence training already in progress", "status": "TRAINING"}

    def run_train():
        try:
            # `cwd=here` with an absolute script path: the previous RELATIVE
            # script path only resolved when the process happened to start with
            # this directory as its cwd, and the resulting FileNotFoundError was
            # swallowed — so the endpoint reported success for a retrain that
            # never ran, and load_models() was never called.
            result = subprocess.run(
                [sys.executable, script, "--data", data_path],
                cwd=here,
                capture_output=True,
                text=True,
                timeout=1800,
            )
            if result.returncode != 0:
                logger.error(
                    "Confluence training failed (rc=%s): %s",
                    result.returncode,
                    (result.stderr or result.stdout or "")[-500:],
                )
                return
            confluence_service.load_models(force=True)
            logger.info("Confluence retraining completed and models reloaded")
        except Exception as e:
            logger.error(f"Confluence training failed: {e}")
        finally:
            confluence_train_lock.release()

    threading.Thread(target=run_train, daemon=True, name="confluence-train").start()
    return {"message": "Confluence training started"}


@app.get("/api/v1/ranker_status", tags=["Training"])
async def get_ranker_status():
    """Status of the learned ranker: training lifecycle + currently-served model."""
    return {"lifecycle": ranker_lifecycle_manager.get_status(), "model": ranker_service.get_status()}

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
        import hmac
        if not token or not hmac.compare_digest(token, expected_token):
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
