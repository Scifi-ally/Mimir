import os
import joblib
import logging
import numpy as np
import pandas as pd

logger = logging.getLogger("confluence_service")

class ConfluenceService:
    def __init__(self):
        self.models = {}
        self.models_dir = os.path.join(os.path.dirname(__file__), "..", "models", "confluence")
        self.load_models()

    def load_models(self):
        self.models = {}
        if not os.path.exists(self.models_dir):
            return
            
        for f in os.listdir(self.models_dir):
            if f.startswith("confluence_") and f.endswith(".pkl"):
                regime = f.replace("confluence_", "").replace(".pkl", "")
                path = os.path.join(self.models_dir, f)
                try:
                    self.models[regime] = joblib.load(path)
                except Exception as e:
                    logger.error(f"Failed to load confluence model for {regime}: {e}")
                    
        logger.info(f"Loaded confluence models for regimes: {list(self.models.keys())}")

    def get_score(self, regime: str, features: dict) -> float:
        # Default fallback if no model exists for this regime
        if regime not in self.models:
            # Fallback to simple average or equal weight
            weights = {
                "tech_score": 0.35,
                "pattern_score": 0.20,
                "chronos_score": 0.15,
                "rs_score": 0.10,
                "sector_score": 0.10,
                "sentiment_score": 0.10,
            }
            score = sum(features.get(k, 50) * w for k, w in weights.items())
            return round(max(0, min(100, score)), 2)

        model = self.models[regime]
        feature_keys = ["tech_score", "pattern_score", "chronos_score", "rs_score", "sector_score", "sentiment_score"]
        
        # LightGBM requires 2D array
        x = np.array([features.get(k, 50) for k in feature_keys]).reshape(1, -1)
        try:
            # P(Target Hit)
            prob = model.predict_proba(x)[0, 1]
            return round(prob * 100, 2)
        except Exception as e:
            logger.error(f"Failed to score confluence for {regime}: {e}")
            return 50.0

confluence_service = ConfluenceService()
