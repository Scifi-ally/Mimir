"""
Train the Regime-Gated Confluence Model.
Reads JSONL data, applies Purged K-Fold Cross Validation to prevent overlap leakage,
trains a LightGBM classifier with monotonic constraints for each regime,
and saves the models to models/confluence/
"""
import argparse
import json
import os
import joblib
import numpy as np
import pandas as pd
from lightgbm import LGBMClassifier
from sklearn.metrics import log_loss, roc_auc_score

# The feature names from the extracted data
FEATURES = [
    "tech_score",
    "pattern_score",
    "chronos_score",
    "rs_score",
    "sector_score",
    "sentiment_score"
]

def load_data(filepath: str) -> pd.DataFrame:
    rows = []
    with open(filepath, 'r') as f:
        for line in f:
            if not line.strip():
                continue
            rows.append(json.loads(line))
    return pd.DataFrame(rows)

def purged_kfold(df: pd.DataFrame, k: int = 5, embargo_pct: float = 0.01):
    """
    Implements a basic Purged K-Fold CV.
    Since we might not have exact entry/exit timestamps for every trade in the JSONL easily,
    we sort by generation time and perform TimeSeries/KFold splits with an embargo buffer
    between train and test sets to prevent leakage.
    """
    df = df.sort_values("generated_at").reset_index(drop=True)
    n = len(df)
    fold_size = n // k
    embargo_size = int(n * embargo_pct)
    
    splits = []
    for i in range(k):
        test_start = i * fold_size
        test_end = test_start + fold_size if i < k - 1 else n
        
        test_idx = np.arange(test_start, test_end)
        
        # Purge train indices that are too close to the test set
        train_idx = []
        for j in range(n):
            if j < test_start - embargo_size or j > test_end + embargo_size - 1:
                train_idx.append(j)
                
        splits.append((np.array(train_idx), test_idx))
    return splits

def train_and_evaluate(df: pd.DataFrame, regime: str, model_dir: str):
    print(f"\n--- Training for Regime: {regime} ---")
    regime_df = df[df["regime"] == regime].copy()
    if len(regime_df) < 50:
        print(f"Not enough data for regime {regime} (n={len(regime_df)}). Skipping.")
        return

    X = regime_df[FEATURES].fillna(0)
    y = regime_df["label"]

    # Monotonic constraints: all features should positively impact the target
    monotone_constraints = [1] * len(FEATURES)
    
    # Validation using Purged K-Fold
    splits = purged_kfold(regime_df, k=3, embargo_pct=0.05)
    
    aucs = []
    losses = []
    
    for train_idx, test_idx in splits:
        if len(train_idx) == 0 or len(test_idx) == 0:
            continue
            
        X_train, y_train = X.iloc[train_idx], y.iloc[train_idx]
        X_test, y_test = X.iloc[test_idx], y.iloc[test_idx]
        
        # Very shallow trees, high regularization to prevent overfitting on small sets
        model = LGBMClassifier(
            max_depth=3,
            num_leaves=7,
            learning_rate=0.05,
            n_estimators=50,
            monotone_constraints=monotone_constraints,
            min_child_samples=5,
            verbose=-1
        )
        
        model.fit(X_train, y_train)
        preds = model.predict_proba(X_test)[:, 1]
        
        if len(np.unique(y_test)) > 1:
            aucs.append(roc_auc_score(y_test, preds))
        losses.append(log_loss(y_test, preds, labels=[0, 1]))
    
    if aucs:
        print(f"CV ROC AUC: {np.mean(aucs):.3f} ± {np.std(aucs):.3f}")
    print(f"CV Log Loss: {np.mean(losses):.3f} ± {np.std(losses):.3f}")
    
    # Train final model on all data for this regime
    final_model = LGBMClassifier(
        max_depth=3,
        num_leaves=7,
        learning_rate=0.05,
        n_estimators=50,
        monotone_constraints=monotone_constraints,
        min_child_samples=5,
        verbose=-1
    )
    final_model.fit(X, y)
    
    os.makedirs(model_dir, exist_ok=True)
    model_path = os.path.join(model_dir, f"confluence_{regime}.pkl")
    joblib.dump(final_model, model_path)
    print(f"Saved model to {model_path}")

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", required=True, help="Path to JSONL data file")
    parser.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "models", "confluence"), help="Output directory")
    args = parser.parse_args()

    df = load_data(args.data)
    if df.empty:
        print("No data found.")
        return

    # Train a model for each unique regime
    regimes = df["regime"].unique()
    for r in regimes:
        train_and_evaluate(df, r, args.out)

if __name__ == "__main__":
    main()
