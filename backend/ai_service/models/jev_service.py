"""
JEV Service — TypeSafe AI System-1 Fast Decision Engine.
─────────────────────────────────────────────────────────────────────────────
• Non-autoregressive System-1 decision architecture for high-speed triage.
• Queries TypeSafe AI API (https://api.typesafe.ai/v1/systemone) when TYPESAFE_API_KEY
  is present.
• Uses lean, centralized deterministic RLCD surrogate engine when running offline
  or without an API key (100% testable, zero downtime).
• Returns strongly typed decision primitives: Choice (verdict/action),
  Score (opportunity/confidence), Noul (probabilistic gates), and dynamic
  position sizing multiplier.

Latency architecture:
  • One pooled, keep-alive, HTTP/2-capable httpx.Client for the process lifetime.
    A per-call client would pay a full TCP + TLS handshake per candidate, which
    dominated wall-clock latency for a System-1 gate.
  • Short-TTL decision cache keyed on a canonical digest of the market state.
    The scanner re-evaluates an unchanged symbol on every tick debounce, so the
    cache converts most of the scan into local lookups.
  • Consecutive-failure circuit breaker with cooldown. Without it, a cloud
    outage costs `timeout x candidates` on every batch, stalling the whole scan.
  • Adaptive timeout: tight while healthy, relaxes only after failures.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, List, Optional, Sequence, Tuple

from .system1_base import (
    System1Decision,
    check_hard_risk_gates,
    evaluate_deterministic_system1,
)

logger = logging.getLogger("ai_service.jev")

# Type alias for caller convenience
JevDecision = System1Decision

VALID_VERDICTS: Tuple[str, ...] = ("APPROVE", "REJECT", "CAUTION")
VALID_ACTIONS: Tuple[str, ...] = (
    "EXECUTE_IMMEDIATELY",
    "CONFIRMED_ENTRY",
    "LIMIT_PULLBACK",
    "CANCEL",
)

# The JEV query schema. Noul (Bernoulli) primitives are requested explicitly so
# the downstream risk router consumes model probabilities instead of constants
# derived from the verdict label.
_JEV_QUERIES: Tuple[Dict[str, Any], ...] = (
    {"name": "verdict", "type": "choice", "options": list(VALID_VERDICTS)},
    {"name": "action", "type": "choice", "options": list(VALID_ACTIONS)},
    {"name": "confidence", "type": "score", "min": 0.0, "max": 1.0},
    {"name": "opportunity_score", "type": "score", "min": 0.0, "max": 100.0},
    {"name": "regime_alignment", "type": "score", "min": -1.0, "max": 1.0},
    {"name": "p_execution_success", "type": "score", "min": 0.0, "max": 1.0},
    {"name": "p_stop_hunt_risk", "type": "score", "min": 0.0, "max": 1.0},
    {"name": "p_adverse_regime_shift", "type": "score", "min": 0.0, "max": 1.0},
)

# Float rounding used to canonicalize the cache key. Two states that agree to
# this precision produce the same System-1 decision, so they share a cache slot.
_CACHE_PRECISION = 6


def _env_float(key: str, default: float, minimum: float = 0.0) -> float:
    try:
        value = float(os.getenv(key, "") or default)
    except (TypeError, ValueError):
        return default
    return max(minimum, value)


def _env_int(key: str, default: int, minimum: int = 1) -> int:
    try:
        value = int(os.getenv(key, "") or default)
    except (TypeError, ValueError):
        return default
    return max(minimum, value)


def _env_bool(key: str, default: bool) -> bool:
    raw = os.getenv(key)
    if raw is None:
        return default
    return raw.strip().lower() in ("true", "1", "yes", "on")


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def _coerce_probability(value: Any, default: float) -> float:
    """Coerce an untrusted API field into a finite probability in [0, 1]."""
    try:
        f = float(value)
    except (TypeError, ValueError):
        return default
    if math.isnan(f) or math.isinf(f):
        return default
    return _clamp(f, 0.0, 1.0)


def _coerce_bounded(value: Any, low: float, high: float, default: float) -> float:
    """Coerce an untrusted API field into a finite value inside [low, high]."""
    try:
        f = float(value)
    except (TypeError, ValueError):
        return default
    if math.isnan(f) or math.isinf(f):
        return default
    return _clamp(f, low, high)


def _coerce_enum(value: Any, allowed: Sequence[str], default: str) -> str:
    """Uppercase an untrusted API label and verify it against the contract."""
    if not isinstance(value, str):
        return default
    candidate = value.strip().upper()
    return candidate if candidate in allowed else default


def _logit(p: float) -> float:
    p = _clamp(p, 1e-6, 1.0 - 1e-6)
    return math.log(p / (1.0 - p))


def _sigmoid(z: float) -> float:
    return 1.0 / (1.0 + math.exp(-max(-20.0, min(20.0, z))))


def _canonical_state_key(state: Dict[str, Any]) -> str:
    """Stable digest of a market state, used as the decision cache key."""
    normalized: Dict[str, Any] = {}
    for key, value in state.items():
        if isinstance(value, bool):
            normalized[key] = value
        elif isinstance(value, (int, float)):
            f = float(value)
            normalized[key] = None if (math.isnan(f) or math.isinf(f)) else round(f, _CACHE_PRECISION)
        elif isinstance(value, str):
            normalized[key] = value.strip()
        elif isinstance(value, (list, tuple)):
            normalized[key] = [str(v) for v in value]
        elif value is None:
            normalized[key] = None
        else:
            normalized[key] = str(value)
    blob = json.dumps(normalized, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.blake2b(blob.encode("utf-8"), digest_size=16).hexdigest()


class JevService:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._api_key: Optional[str] = None
        self._api_url: str = os.getenv("TYPESAFE_API_URL", "https://api.typesafe.ai/v1/systemone")
        self._enabled: bool = _env_bool("JEV_ENABLED", True)

        # Latency budget. A System-1 pre-trade gate must fail fast, not wait out
        # a long cloud timeout on every candidate.
        self._timeout_ms: int = 400
        self._timeout_max_ms: int = 400
        self._timeout_floor_ms: int = 150

        # Decision cache (state digest -> (expires_at, serialized decision)).
        self._cache_ttl_s: float = 2.0
        self._cache_max: int = 512
        self._cache: Dict[str, Tuple[float, Dict[str, Any]]] = {}

        # Circuit breaker.
        self._breaker_failures: int = 3
        self._breaker_cooldown_s: float = 30.0
        self._fail_streak: int = 0
        self._breaker_open_until: float = 0.0

        self._max_workers: int = 8
        self._executor: Optional[ThreadPoolExecutor] = None
        self._client: Optional[Any] = None

        self._inference_count: int = 0
        self._api_call_count: int = 0
        self._surrogate_call_count: int = 0
        self._cache_hit_count: int = 0
        self._short_circuit_count: int = 0
        self._validation_reject_count: int = 0
        self._last_error: Optional[str] = None

        self.reload_config()

    # ------------------------------------------------------------------
    # Configuration
    # ------------------------------------------------------------------
    def reload_config(self) -> None:
        with self._lock:
            self._api_key = os.getenv("TYPESAFE_API_KEY")
            self._api_url = os.getenv("TYPESAFE_API_URL", "https://api.typesafe.ai/v1/systemone")
            self._enabled = _env_bool("JEV_ENABLED", True)

            timeout_ms = _env_int("TYPESAFE_TIMEOUT_MS", 400, minimum=50)
            self._timeout_floor_ms = min(200, timeout_ms)
            self._timeout_max_ms = timeout_ms
            self._timeout_ms = timeout_ms

            self._cache_ttl_s = _env_float("JEV_CACHE_TTL_S", 2.0)
            self._cache_max = _env_int("JEV_CACHE_MAX", 512, minimum=0)
            self._breaker_failures = _env_int("JEV_BREAKER_FAILURES", 3, minimum=1)
            self._breaker_cooldown_s = _env_float("JEV_BREAKER_COOLDOWN_S", 30.0)
            self._max_workers = _env_int("JEV_MAX_WORKERS", 8, minimum=1)

            now = time.monotonic()
            if self._cache_max == 0:
                self._cache.clear()
            else:
                self._cache = {k: v for k, v in self._cache.items() if v[0] > now}

            # Credentials or endpoint changed: drop the stale pooled sockets so
            # the client rebuilds against the new target on next use.
            stale_client = self._client
            self._client = None

        if stale_client is not None:
            try:
                stale_client.close()
            except Exception:  # pragma: no cover - best effort
                pass

    def get_status(self) -> Dict[str, Any]:
        now = time.monotonic()
        with self._lock:
            breaker_open = now < self._breaker_open_until
            return {
                "model": "typesafe-jev-systemone",
                "loaded": True,
                "healthy": not breaker_open,
                "enabled": self._enabled,
                "api_key_configured": bool(self._api_key),
                "mode": "typesafe_api" if bool(self._api_key) else "local_surrogate",
                "inference_count": self._inference_count,
                "api_call_count": self._api_call_count,
                "surrogate_call_count": self._surrogate_call_count,
                "cache_hit_count": self._cache_hit_count,
                "cache_entries": len(self._cache),
                "cache_ttl_s": self._cache_ttl_s,
                "short_circuit_count": self._short_circuit_count,
                "validation_reject_count": self._validation_reject_count,
                "circuit_state": "open" if breaker_open else "closed",
                "consecutive_failures": self._fail_streak,
                "breaker_reopen_in_s": round(max(0.0, self._breaker_open_until - now), 2)
                if breaker_open
                else 0.0,
                "timeout_ms": self._timeout_ms,
                "last_error": self._last_error,
            }

    # ------------------------------------------------------------------
    # Public decision API
    # ------------------------------------------------------------------
    def evaluate_decision(self, state: Dict[str, Any]) -> JevDecision:
        """
        Evaluate candidate state and return a typed JevDecision.
        Uses TypeSafe AI API if configured; otherwise runs local deterministic surrogate.
        """
        t0 = time.perf_counter()

        # Step 1: Pre-trade quant hard risk gates (sub-millisecond execution)
        gate_rejection = check_hard_risk_gates(
            state, provider="jev", model_id="jev-1", source="local_surrogate"
        )
        if gate_rejection is not None:
            gate_rejection.latency_ms = round((time.perf_counter() - t0) * 1000, 2)
            with self._lock:
                self._inference_count += 1
                self._surrogate_call_count += 1
            return gate_rejection

        # Step 2: Serve from cache when the market state is unchanged.
        cache_key = _canonical_state_key(state)
        cached = self._cache_get(cache_key)
        if cached is not None:
            cached.latency_ms = round((time.perf_counter() - t0) * 1000, 2)
            with self._lock:
                self._inference_count += 1
                self._cache_hit_count += 1
            return cached

        # Step 3: Cloud decision, unless the breaker says the network is down.
        decision = None
        if self._api_configured():
            if self._breaker_is_open():
                with self._lock:
                    self._short_circuit_count += 1
            else:
                decision = self._call_typesafe_api(state)

        if decision is None:
            # Step 4: Local RLCD surrogate (gates already checked above). It is
            # a pure function of the state, so memoize it for the cache TTL —
            # the scanner re-evaluates unchanged symbols on every tick.
            decision = self._evaluate_local_surrogate(state, check_gates=False)
            self._cache_put(cache_key, decision)
            with self._lock:
                self._surrogate_call_count += 1
        else:
            self._cache_put(cache_key, decision)
            with self._lock:
                self._api_call_count += 1

        decision.latency_ms = round((time.perf_counter() - t0) * 1000, 2)
        with self._lock:
            self._inference_count += 1
        return decision

    def evaluate_batch(self, states: List[Dict[str, Any]]) -> List[JevDecision]:
        """
        Evaluate a batch of candidate states.

        Hard-gated states resolve locally, cached states resolve in-process, and
        only genuine cache misses reach the network — concurrently, over the
        shared keep-alive connection pool. Surrogate results are cached too: the
        RLCD surrogate is deterministic given the state, so a repeat scan of an
        unchanged symbol needs no recomputation.
        """
        if not states:
            return []
        if len(states) == 1:
            return [self.evaluate_decision(states[0])]

        decisions: List[Optional[JevDecision]] = [None] * len(states)
        pending_idx: List[int] = []
        pending_states: List[Dict[str, Any]] = []
        pending_keys: List[str] = []
        key_by_index: Dict[int, str] = {}

        batch_t0 = time.perf_counter()

        for i, state in enumerate(states):
            gate_rejection = check_hard_risk_gates(
                state, provider="jev", model_id="jev-1", source="local_surrogate"
            )
            if gate_rejection is not None:
                with self._lock:
                    self._surrogate_call_count += 1
                decisions[i] = gate_rejection
                continue

            cache_key = _canonical_state_key(state)
            cached = self._cache_get(cache_key)
            if cached is not None:
                with self._lock:
                    self._cache_hit_count += 1
                decisions[i] = cached
                continue

            pending_idx.append(i)
            pending_states.append(state)
            pending_keys.append(cache_key)
            key_by_index[i] = cache_key

        if pending_states:
            if self._api_configured() and not self._breaker_is_open():
                resolved = self._call_typesafe_api_concurrent(pending_states)
                with self._lock:
                    self._api_call_count += len(pending_states)
                for i, key, decision in zip(pending_idx, pending_keys, resolved):
                    if decision is not None:
                        self._cache_put(key, decision)
                        decisions[i] = decision
            elif self._api_configured():
                # API is configured but the breaker is open: the cloud is known
                # down, so skip it entirely rather than paying a timeout.
                with self._lock:
                    self._short_circuit_count += len(pending_states)

        # Anything the cloud could not answer for falls back to the local RLCD
        # surrogate, per-item, so one bad symbol never voids the whole batch.
        elapsed_ms = round((time.perf_counter() - batch_t0) * 1000, 2)
        surrogate_resolved = 0
        for i, decision in enumerate(decisions):
            if decision is None:
                decision = self._evaluate_local_surrogate(states[i], check_gates=False)
                # The surrogate is a pure function of the state, so it is safe
                # to memoize for the cache TTL just like a cloud decision.
                self._cache_put(key_by_index.get(i) or _canonical_state_key(states[i]), decision)
                surrogate_resolved += 1
            if decision.latency_ms <= 0.0:
                decision.latency_ms = elapsed_ms
            decisions[i] = decision

        with self._lock:
            self._surrogate_call_count += surrogate_resolved
            self._inference_count += len(states)

        return [d for d in decisions if d is not None]

    # ------------------------------------------------------------------
    # Cache
    # ------------------------------------------------------------------
    def _cache_get(self, key: str) -> Optional[JevDecision]:
        if self._cache_ttl_s <= 0:
            return None
        now = time.monotonic()
        with self._lock:
            entry = self._cache.get(key)
            if entry is None:
                return None
            expires_at, payload = entry
            if expires_at <= now:
                self._cache.pop(key, None)
                return None
        return System1Decision(**payload)

    def _cache_put(self, key: str, decision: JevDecision) -> None:
        if self._cache_ttl_s <= 0 or self._cache_max <= 0:
            return
        expires_at = time.monotonic() + self._cache_ttl_s
        with self._lock:
            if len(self._cache) >= self._cache_max:
                # Cheap bounded eviction: drop the soonest-to-expire entries.
                ordered = sorted(self._cache.items(), key=lambda kv: kv[1][0])
                for stale_key, _ in ordered[: max(1, self._cache_max // 8)]:
                    self._cache.pop(stale_key, None)
            self._cache[key] = (expires_at, decision.to_dict())

    # ------------------------------------------------------------------
    # Circuit breaker
    # ------------------------------------------------------------------
    def _api_configured(self) -> bool:
        with self._lock:
            return bool(self._api_key) and self._enabled

    def _breaker_is_open(self) -> bool:
        with self._lock:
            if time.monotonic() < self._breaker_open_until:
                return True
            if self._breaker_open_until:
                # Cooldown elapsed: half-open, let the next call probe recovery.
                self._breaker_open_until = 0.0
                self._fail_streak = 0
            return False

    def _record_api_success(self) -> None:
        with self._lock:
            self._fail_streak = 0
            self._breaker_open_until = 0.0
            if self._timeout_ms < self._timeout_max_ms:
                # Recover latency headroom after a clean call.
                self._timeout_ms = min(self._timeout_max_ms, self._timeout_ms + 50)

    def _record_api_failure(self, reason: str) -> None:
        with self._lock:
            self._last_error = reason
            self._fail_streak += 1
            if self._timeout_ms > self._timeout_floor_ms:
                self._timeout_ms = max(self._timeout_floor_ms, self._timeout_ms - 50)
            if self._fail_streak >= self._breaker_failures:
                self._breaker_open_until = time.monotonic() + self._breaker_cooldown_s
                logger.warning(
                    "TypeSafe Jev circuit breaker OPEN for %.0fs after %d consecutive "
                    "failures (last: %s); routing to local RLCD surrogate.",
                    self._breaker_cooldown_s,
                    self._fail_streak,
                    reason,
                )

    # ------------------------------------------------------------------
    # HTTP transport
    # ------------------------------------------------------------------
    def _get_client(self) -> Any:
        """Return the process-wide pooled client, creating it on first use."""
        with self._lock:
            client = self._client
            if client is not None:
                return client
            try:
                import httpx
            except ImportError:  # pragma: no cover - httpx is a hard dependency
                logger.warning("httpx unavailable; Jev running local surrogate only.")
                return None

            client = httpx.Client(
                timeout=httpx.Timeout(self._timeout_ms / 1000.0, connect=1.0),
                limits=httpx.Limits(
                    max_connections=max(8, self._max_workers * 2),
                    max_keepalive_connections=max(4, self._max_workers),
                    keepalive_expiry=30.0,
                ),
                http2=False,
                headers={"Connection": "keep-alive"},
            )
            self._client = client
            return client

    def _get_executor(self) -> Optional[ThreadPoolExecutor]:
        with self._lock:
            if self._executor is None:
                self._executor = ThreadPoolExecutor(
                    max_workers=self._max_workers, thread_name_prefix="jev-batch"
                )
            return self._executor

    def _post(self, payload: Dict[str, Any], api_key: str, api_url: str) -> Optional[Dict[str, Any]]:
        client = self._get_client()
        if client is None:
            return None
        try:
            response = client.post(
                api_url,
                json=payload,
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                timeout=self._timeout_ms / 1000.0,
            )
        except Exception as exc:
            self._record_api_failure(f"{type(exc).__name__}: {exc}")
            logger.warning("Failed to query TypeSafe Jev API: %s; degrading to local surrogate", exc)
            return None

        if response.status_code != 200:
            self._record_api_failure(f"HTTP {response.status_code}")
            logger.warning(
                "TypeSafe API returned status %s: %s",
                response.status_code,
                response.text[:200],
            )
            return None

        try:
            data = response.json()
        except ValueError as exc:
            self._record_api_failure(f"malformed JSON: {exc}")
            return None
        if not isinstance(data, dict):
            self._record_api_failure("response body is not a JSON object")
            return None
        return data

    def _call_typesafe_api(self, state: Dict[str, Any]) -> Optional[JevDecision]:
        """Call TypeSafe AI System-1 endpoint for a single candidate."""
        with self._lock:
            api_key = self._api_key
            api_url = self._api_url
        if not api_key:
            return None

        data = self._post(self._build_payload(state), api_key, api_url)
        if data is None:
            return None
        decision = self._parse_response(data, state)
        if decision is None:
            # A schema-violating answer is a failure, not a silent pass-through.
            with self._lock:
                self._validation_reject_count += 1
            self._record_api_failure("response failed System-1 contract validation")
            return None
        self._record_api_success()
        return decision

    def _call_typesafe_api_concurrent(
        self, states: List[Dict[str, Any]]
    ) -> List[Optional[JevDecision]]:
        """Fan out cache misses over the shared connection pool."""
        executor = self._get_executor()
        if executor is None or len(states) == 1:
            return [self._call_typesafe_api(state) for state in states]
        try:
            return list(executor.map(self._call_typesafe_api, states))
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning("Jev batch dispatch failed: %s", exc)
            return [self._call_typesafe_api(state) for state in states]

    def _build_payload(self, state: Dict[str, Any]) -> Dict[str, Any]:
        return {"model": "jev-1", "state": state, "queries": [dict(q) for q in _JEV_QUERIES]}

    # ------------------------------------------------------------------
    # Response parsing / contract enforcement
    # ------------------------------------------------------------------
    def _parse_response(
        self, data: Dict[str, Any], state: Dict[str, Any]
    ) -> Optional[JevDecision]:
        results = data.get("results")
        if not isinstance(results, dict):
            return None
        raw_verdict = results.get("verdict")
        if not isinstance(raw_verdict, str) or not raw_verdict.strip():
            return None

        verdict = _coerce_enum(raw_verdict, VALID_VERDICTS, "")
        if verdict == "":
            return None

        # Locally calibrated priors. Used for any Noul the API did not return and
        # as the fallback when the model omits regime alignment. Far better than
        # constants keyed off the verdict label, which carry no market information.
        prior = evaluate_deterministic_system1(
            state, provider="jev", model_id="jev-1", source="local_surrogate", check_gates=False
        )

        p_exec = _coerce_probability(results.get("p_execution_success"), prior.p_execution_success)
        p_hunt = _coerce_probability(results.get("p_stop_hunt_risk"), prior.p_stop_hunt_risk)
        p_shift = _coerce_probability(
            results.get("p_adverse_regime_shift"), prior.p_adverse_regime_shift
        )
        conf = _coerce_probability(results.get("confidence"), 0.5)
        opp = _coerce_bounded(results.get("opportunity_score"), 0.0, 100.0, 50.0)
        regime_align = _coerce_bounded(
            results.get("regime_alignment"), -1.0, 1.0, prior.regime_alignment
        )

        action = self._coerce_action(results.get("action"), verdict, prior.action)

        # Pool the cloud confidence with the local learned ranker when both are
        # calibrated probabilities: log-odds averaging shrinks variance without
        # letting either model's overconfidence dominate.
        reasons = self._extract_reasons(data, verdict)
        pooled = self._pool_with_ranker(state, verdict, conf, reasons)
        if pooled is not None:
            conf = pooled

        mult = self._position_multiplier(verdict, conf, p_exec, p_hunt, p_shift, reasons)

        return JevDecision(
            verdict=verdict,
            action=action,
            confidence=round(conf, 4),
            opportunity_score=round(opp, 1),
            gate_reasons=reasons,
            regime_alignment=round(regime_align, 2),
            p_execution_success=round(p_exec, 4),
            p_stop_hunt_risk=round(p_hunt, 4),
            p_adverse_regime_shift=round(p_shift, 4),
            provider="jev",
            model_id="jev-1",
            source="typesafe_api",
            position_size_multiplier=mult,
        )

    @staticmethod
    def _coerce_action(raw_action: Any, verdict: str, prior_action: str) -> str:
        """
        Enforce verdict/action coherence.

        A contradictory pair such as (REJECT, EXECUTE_IMMEDIATELY) would let an
        entry slip past the router's REJECT filter, so the action is repaired
        rather than trusted.
        """
        action = _coerce_enum(raw_action, VALID_ACTIONS, "")
        if action == "":
            action = prior_action
        if verdict == "REJECT" and action != "CANCEL":
            return "CANCEL"
        if action == "CANCEL" and verdict != "REJECT":
            return "CONFIRMED_ENTRY"
        if verdict == "APPROVE" and action == "CANCEL":
            return "EXECUTE_IMMEDIATELY"
        return action

    @staticmethod
    def _extract_reasons(data: Dict[str, Any], verdict: str) -> List[str]:
        raw_reasons = data.get("reasons", ["TYPESAFE_JEV_API_VERDICT"])
        if isinstance(raw_reasons, list):
            reasons = [str(r) for r in raw_reasons if str(r).strip()]
        elif isinstance(raw_reasons, str) and raw_reasons.strip():
            reasons = [raw_reasons.strip()]
        else:
            reasons = []
        if not reasons:
            reasons = [f"TYPESAFE_JEV_API_{verdict}"]
        return reasons

    @staticmethod
    def _pool_with_ranker(
        state: Dict[str, Any], verdict: str, conf: float, reasons: List[str]
    ) -> Optional[float]:
        """Log-odds pool Jev confidence with the LightGBM ranker win probability."""
        if verdict == "REJECT":
            return None
        raw = state.get("win_probability", state.get("winProb"))
        if raw is None:
            return None
        try:
            win_prob = float(raw)
        except (TypeError, ValueError):
            return None
        if math.isnan(win_prob) or math.isinf(win_prob) or not (0.0 < win_prob < 1.0):
            return None
        pooled = _sigmoid(0.5 * (_logit(conf) + _logit(win_prob)))
        if abs(pooled - conf) > 1e-4:
            reasons.append(f"RANKER_JEV_CONFIDENCE_POOLED_{win_prob:.2f}")
        return pooled

    @staticmethod
    def _position_multiplier(
        verdict: str,
        conf: float,
        p_exec: float,
        p_hunt: float,
        p_shift: float,
        reasons: List[str],
    ) -> float:
        """
        Size from calibrated probabilities rather than confidence alone.

        High conviction with clean execution odds scales up; elevated stop-hunt or
        regime-collapse risk scales down instead of being ignored.
        """
        if verdict == "REJECT":
            return 0.0
        if verdict == "CAUTION":
            return 0.65
        if conf >= 0.80 and p_exec >= 0.70 and p_hunt <= 0.20 and p_shift <= 0.20:
            reasons.append("POSITION_SIZE_SCALED_UP_1.25X")
            return 1.25
        if p_hunt > 0.35 or p_shift > 0.30 or p_exec < 0.55:
            reasons.append("POSITION_SIZE_SCALED_DOWN_0.85X")
            return 0.85
        return 1.0

    # ------------------------------------------------------------------
    # Local surrogate
    # ------------------------------------------------------------------
    def _evaluate_local_surrogate(
        self, state: Dict[str, Any], check_gates: bool = True
    ) -> JevDecision:
        """Evaluate candidate state using deterministic surrogate engine."""
        return evaluate_deterministic_system1(
            state,
            provider="jev",
            model_id="jev-1",
            source="local_surrogate",
            check_gates=check_gates,
        )

    def close(self) -> None:
        """Release pooled sockets and worker threads (shutdown / tests)."""
        with self._lock:
            client, executor = self._client, self._executor
            self._client = None
            self._executor = None
        if client is not None:
            try:
                client.close()
            except Exception:  # pragma: no cover - best effort
                pass
        if executor is not None:
            executor.shutdown(wait=False)


# Singleton instance
jev_service = JevService()
