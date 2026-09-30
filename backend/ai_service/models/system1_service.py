"""
Unified System-1 Fast Decision Router.
─────────────────────────────────────────
Routes every System-1 decision to the local open-weight Laya checkpoint
(Convai Innovations ModernBERT RLCD, Apache-2.0, self-hosted).

The former "jev" engine was TypeSafe AI's managed *cloud* API, and "consensus"
combined the two. Both are retired: this platform is required to decide fully
on its own, offline, with no third-party inference service in the loop. The
deterministic surrogate inside laya_service remains only as a last-resort
safety net if the checkpoint cannot be loaded at all.
"""

from __future__ import annotations

import logging
import os
import threading
from typing import Any, Dict, List, Optional

from .laya_service import laya_service
from .system1_base import System1Decision

logger = logging.getLogger("ai_service.system1")

# Engines that used to exist and required a cloud API. Kept as a set so old
# configs fail loudly instead of quietly changing which model decides.
_RETIRED_ENGINES = frozenset({"jev", "consensus"})


class System1Service:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._default_engine: str = os.getenv("SYSTEM1_ENGINE", "laya").lower()
        self._enabled: bool = os.getenv("SYSTEM1_ENABLED", "true").lower() in ("true", "1", "yes")

    def reload_config(self) -> None:
        with self._lock:
            self._default_engine = os.getenv("SYSTEM1_ENGINE", "laya").lower()
            self._enabled = os.getenv("SYSTEM1_ENABLED", "true").lower() in ("true", "1", "yes")
        laya_service.reload_config()

    def get_status(self) -> Dict[str, Any]:
        with self._lock:
            default_engine = self._default_engine
            enabled = self._enabled

        laya_status = laya_service.get_status()
        return {
            "default_engine": default_engine,
            "enabled": enabled,
            "laya": laya_status,
            "healthy": laya_status.get("healthy", True),
            # Surfaced so a stale SYSTEM1_ENGINE in a .env is visible rather
            # than silently ignored.
            "retired_engines": sorted(_RETIRED_ENGINES),
            "cloud_engines_available": False,
        }

    def evaluate_decision(
        self, state: Dict[str, Any], engine: Optional[str] = None
    ) -> System1Decision:
        """Route a decision to the local Laya checkpoint.

        "jev" and "consensus" are accepted as input for backward compatibility
        with old configs and saved candidate rows, but they no longer route
        anywhere: Jev was a managed cloud API, and every decision now has to
        come from the local open-weight checkpoint. An explicit request for a
        retired engine is reported rather than silently downgraded, because the
        caller may be relying on a cloud-grade answer it is not getting.
        """
        with self._lock:
            selected_engine = (engine or state.get("preferred_engine") or self._default_engine).lower()

        if selected_engine in _RETIRED_ENGINES:
            logger.warning(
                "SYSTEM1_ENGINE=%s is retired (it required a cloud API) - using the local "
                "Laya checkpoint instead",
                selected_engine,
            )
            state = {**state, "retired_engine_requested": selected_engine}

        # Laya is the only decision engine. The deterministic surrogate inside
        # laya_service is a last-resort safety net if the checkpoint cannot load,
        # not a selectable engine.
        return laya_service.evaluate_decision(state)

    def evaluate_batch(
        self, states: List[Dict[str, Any]], engine: Optional[str] = None
    ) -> List[System1Decision]:
        """Evaluate many candidates.

        Always the local checkpoint, in one batched call. Batching matters here
        for a concrete reason: Laya on CPU costs roughly a second per candidate,
        so a 100-stock scan has to amortise the forward pass rather than issue
        100 separate ones.
        """
        if not states:
            return []
        return laya_service.evaluate_batch(states)


system1_service = System1Service()
