import logging
import os
import subprocess
import sys
import threading
from typing import Any, Dict, Optional

logger = logging.getLogger("ranker_lifecycle")

HERE = os.path.dirname(os.path.abspath(__file__))
TRAINER = os.path.join(HERE, "train_ranker.py")


class RankerLifecycleManager:
    """Runs train_ranker.py in a background thread and hot-reloads the served
    model on success. Training itself enforces the walk-forward out-of-sample
    gate AND champion-challenger promotion, so a bad retrain can never demote a
    good champion — this manager only orchestrates and reports."""

    def __init__(self) -> None:
        self.state = "READY"
        self.last_error: Optional[str] = None
        self.last_result: Optional[str] = None
        self._lock = threading.Lock()

    def get_status(self) -> Dict[str, Any]:
        with self._lock:
            return {
                "status": self.state,
                "last_error": self.last_error,
                "last_result": self.last_result,
            }

    def trigger_training(self, data_path: Optional[str] = None) -> bool:
        with self._lock:
            if self.state == "TRAINING":
                logger.warning("Ranker training already in progress.")
                return False
            self.state = "TRAINING"
            self.last_error = None

        def _run() -> None:
            try:
                cmd = [sys.executable, TRAINER]
                if data_path:
                    cmd += ["--data", data_path]
                logger.info("Starting ranker training: %s", " ".join(cmd))
                proc = subprocess.run(
                    cmd, capture_output=True, text=True, cwd=HERE, timeout=1800, check=False
                )
                tail = (proc.stdout or "").strip().splitlines()[-1:] or ["(no output)"]
                # Exit 0 => a new champion was written; 1 => kept incumbent / no ship;
                # 2 => precondition failure (no data / lightgbm missing).
                if proc.returncode == 0:
                    with self._lock:
                        self.state = "READY"
                        self.last_result = tail[0]
                    from models import ranker_service
                    ranker_service.reload_model()
                    logger.info("Ranker training promoted a new model; reloaded.")
                else:
                    with self._lock:
                        self.state = "READY"
                        self.last_result = tail[0]
                        if proc.returncode == 2:
                            self.last_error = (proc.stderr or tail[0]).strip()[:500]
                    logger.info(
                        "Ranker training finished rc=%d (no promotion): %s",
                        proc.returncode, tail[0],
                    )
            except Exception as exc:  # never let a training crash take down the service
                logger.exception("Ranker training pipeline failed")
                with self._lock:
                    self.state = "READY"
                    self.last_error = str(exc)

        threading.Thread(target=_run, name="ranker-trainer", daemon=True).start()
        return True


ranker_lifecycle_manager = RankerLifecycleManager()
