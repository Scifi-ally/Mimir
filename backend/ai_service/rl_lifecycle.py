import logging
import threading
from typing import Dict, Any

logger = logging.getLogger("rl_lifecycle")

class RLLifecycleManager:
    def __init__(self):
        self.state = "READY"
        self.progress = 0
        self.last_error = None
        self._lock = threading.Lock()
        
    def get_status(self) -> Dict[str, Any]:
        with self._lock:
            return {
                "status": self.state,
                "progress": self.progress,
                "last_error": self.last_error
            }
            
    def set_state(self, state: str, progress: int = 0, error: str = None):
        with self._lock:
            self.state = state
            self.progress = progress
            if error:
                self.last_error = error
                
    def trigger_training(self):
        with self._lock:
            if self.state == "TRAINING":
                logger.warning("RL training is already in progress.")
                return False
            self.state = "TRAINING"
            self.progress = 0
            self.last_error = None
            
        # Spin up a background thread to run train_rl.py main function
        def _run_training():
            try:
                # We import it here to avoid circular imports and keep memory clean
                import train_rl
                logger.info("Starting automated RL training pipeline...")
                train_rl.main(self)
                self.set_state("READY", 100)
                logger.info("Automated RL training completed successfully.")
                
                # Reload the model in the running service so it uses the new weights
                from models.rl_agent import rl_agent_service
                rl_agent_service.reload_model()
                
            except Exception as e:
                logger.exception("Failed during RL training pipeline")
                self.set_state("ERROR", error=str(e))
                
        thread = threading.Thread(target=_run_training, daemon=True)
        thread.start()
        return True

rl_lifecycle_manager = RLLifecycleManager()
