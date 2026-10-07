"""Regression checks use recorded corpus rows, not fabricated market history."""
import copy
import hashlib
import json
from pathlib import Path
from types import SimpleNamespace
import numpy as np
import pytest

from train_ranker import load_rows, to_matrix, purged_chronological_split, _timestamp_ms, fit_isotonic
from validation_metrics import trade_metrics, select_threshold
from models import ranker_service

DATA = Path(__file__).resolve().parents[1] / "data" / "ranker_train.jsonl"


def test_real_corpus_split_purges_both_boundaries():
    rows = load_rows(str(DATA))
    train, calib, test, metadata = purged_chronological_split(rows, .6, .2, 24)
    assert train and calib and test
    ca = min(_timestamp_ms(r["ts"], "ts") for r in calib)
    te = min(_timestamp_ms(r["ts"], "ts") for r in test)
    assert max(_timestamp_ms(r["resolutionTs"], "resolutionTs") for r in train) < ca - 86400000
    assert max(_timestamp_ms(r["resolutionTs"], "resolutionTs") for r in calib) < te - 86400000
    assert metadata["purged_train"] > 0 and metadata["purged_calib"] > 0


def test_corrupted_real_rows_are_rejected_instead_of_imputed(tmp_path):
    recorded = load_rows(str(DATA))[0]
    corrupt = copy.deepcopy(recorded)
    corrupt["features"][0] = None
    with pytest.raises(ValueError, match="unmeasured"):
        to_matrix([corrupt])
    file = tmp_path / "rows.jsonl"
    file.write_text(json.dumps(corrupt) + "\n")
    with pytest.raises(ValueError, match="nonfinite"):
        load_rows(str(file))
    file.write_text(json.dumps(recorded) + "\n" + json.dumps(recorded) + "\n")
    with pytest.raises(ValueError, match="Duplicate"):
        load_rows(str(file))


def test_optional_missing_flow_and_constant_score_calibration():
    rows = load_rows(str(DATA))[:80]
    missing = copy.deepcopy(rows[0]); missing["features"][-1] = None
    X, _, _ = to_matrix([missing])
    assert np.isnan(X[0, -1]) and np.isfinite(X[0, :-1]).all()
    labels = np.array([r["label"] for r in rows])
    # Constant predictor has exactly the observed base rate, never a fake edge.
    xs, ys = fit_isotonic(np.full(len(rows), .1), labels)
    assert np.all(np.diff(xs) > 0)
    assert ys == pytest.approx([labels.mean()] * len(ys))


def test_cost_stress_and_no_trade_threshold_on_real_outcomes():
    rows = load_rows(str(DATA))[-500:]
    returns = np.array([r["retPct"] for r in rows])
    base = trade_metrics(rows, returns)
    stress = trade_metrics(rows, returns - .2)
    assert stress["expectancy_pct"] == pytest.approx(base["expectancy_pct"] - .2)
    assert base["entry_date_clusters"] < len(rows)
    assert base["portfolio_sharpe"] is None
    # Scores are irrelevant when every observed payoff is non-positive.
    losses = returns[returns < 0]
    threshold, mask = select_threshold(np.ones(len(losses)), losses, 30)
    assert threshold > 1 and not mask.any()


def test_shipped_unverified_artifact_cannot_load(monkeypatch, tmp_path):
    monkeypatch.setattr(ranker_service, "_loaded", False)
    monkeypatch.setattr(ranker_service, "_load_error", None)
    monkeypatch.setattr(ranker_service, "_LGB_AVAILABLE", True)
    model_path = tmp_path / "ranker_model.txt"
    meta_path = tmp_path / "ranker_meta.json"
    model_path.write_bytes(b"recorded model")
    meta_path.write_text(json.dumps({"validation": {"passed": False}}))
    monkeypatch.setenv("RANKER_MODEL_PATH", str(model_path))
    monkeypatch.setenv("RANKER_META_PATH", str(meta_path))
    called = []
    monkeypatch.setattr(ranker_service, "_load_booster", lambda _: called.append(True))
    ranker_service.load_model()
    assert not ranker_service.is_loaded() and not called
    assert "walk-forward" in ranker_service._load_error

    # Even a metadata file that claims successful validation cannot pair with
    # an independently replaced or truncated booster file.
    model_path.write_bytes(b"tampered model")
    valid_gate = {"validation_version": 2, "passed": True, "replay_verified": True,
                  "strategy_scope_verified": True,
                  "strategy_scope": ranker_service._REQUIRED_STRATEGY_SCOPE,
                  "point_in_time_universe_verified": True, "folds": [{}, {}, {}],
                  "cost_stress": {"trades": 100, "expectancy_cluster_95_ci": [0.1, 1.0]}}
    meta_path.write_text(json.dumps({"validation": valid_gate,
                                     "model_sha256": hashlib.sha256(b"different model").hexdigest()}))
    monkeypatch.setattr(ranker_service, "_load_error", None)
    ranker_service.load_model()
    assert not ranker_service.is_loaded() and not called
    assert "integrity digest" in ranker_service._load_error


def test_nonfinite_serving_features_do_not_reach_model(monkeypatch):
    recorded = load_rows(str(DATA))[0]["features"]
    monkeypatch.setattr(ranker_service, "_loaded", True)
    monkeypatch.setattr(ranker_service, "_feature_keys", list(range(len(recorded))))
    called = []
    monkeypatch.setattr(ranker_service, "_booster", SimpleNamespace(predict=lambda _: called.append(True)))
    corrupt = recorded.copy(); corrupt[0] = float("nan")
    assert ranker_service.predict_batch([corrupt]) == [None]
    assert not called

    keys = [f"feature-{i}" for i in range(len(recorded))]
    keys[-1] = "fiiDiiNetFlowLag"
    monkeypatch.setattr(ranker_service, "_feature_keys", keys)
    monkeypatch.setattr(ranker_service, "_iso_x", np.array([0.0, 1.0]))
    monkeypatch.setattr(ranker_service, "_iso_y", np.array([0.0, 1.0]))

    class ReloadDuringPrediction:
        def predict(self, _matrix):
            ranker_service._booster = SimpleNamespace(predict=lambda _: np.array([0.9]))
            ranker_service._feature_keys = ["replacement-feature"]
            ranker_service._iso_x = np.array([0.0, 1.0])
            ranker_service._iso_y = np.array([0.8, 1.0])
            return np.array([0.25])

    monkeypatch.setattr(ranker_service, "_booster", ReloadDuringPrediction())
    assert ranker_service.predict_batch([recorded]) == [0.25]
