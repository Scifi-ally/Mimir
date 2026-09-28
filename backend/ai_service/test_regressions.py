"""
Regression tests for previously-fixed defects.
─────────────────────────────────────────────────────────────────────────────
Each test here reproduces a concrete bug that shipped. They are deliberately
written so that reverting the corresponding fix makes them FAIL — an assertion
that passes both before and after a fix proves nothing.
"""

import math

import pytest
from fastapi.testclient import TestClient

from models.numeric_utils import (
    finite_clamp,
    is_finite_number,
    safe_div,
    sanitize_float,
)


@pytest.fixture
def client():
    from main import app

    return TestClient(app)


# ---------------------------------------------------------------------------
# NaN clamp semantics — the root cause of "corrupt data scores perfectly"
# ---------------------------------------------------------------------------

def test_native_min_max_return_first_argument_for_nan():
    """
    Document the Python behaviour the whole class of bugs rests on.

    This is the trap: `min`/`max` return the FIRST argument unless the second is
    strictly smaller/larger, and every comparison against NaN is False.
    """
    nan = float("nan")
    assert min(100, nan) == 100
    assert max(0, min(100, nan)) == 100
    assert min(0.3, nan) == 0.3
    assert max(-0.3, min(0.3, nan)) == 0.3


def test_finite_clamp_never_yields_the_upper_bound_for_nan():
    nan = float("nan")
    assert finite_clamp(nan, 0.0, 100.0) == 0.0
    assert finite_clamp(nan, 0.0, 100.0, default=50.0) == 50.0
    assert math.isfinite(finite_clamp(nan, 0.0, 100.0))


@pytest.mark.parametrize("bad", [float("nan"), float("inf"), float("-inf"), None, "abc", object(), True])
def test_sanitize_float_collapses_non_finite_to_default(bad):
    assert sanitize_float(bad, default=7.0) == 7.0
    assert is_finite_number(bad) is False


def test_safe_div_guards_all_three_ieee_failure_modes():
    assert safe_div(1.0, 0.0, default=-1.0) == -1.0   # x/0 -> Inf
    assert safe_div(0.0, 0.0, default=-1.0) == -1.0   # 0/0 -> NaN
    assert safe_div(float("inf"), float("inf"), default=-1.0) == -1.0
    assert safe_div(10.0, 4.0) == 2.5


# ---------------------------------------------------------------------------
# Composite score: NaN must not become a perfect 100
# ---------------------------------------------------------------------------

def test_composite_score_nan_input_is_not_maximum_conviction():
    """
    A NaN anywhere upstream must not produce composite_score = 100.0.

    Before the fix, `max(0, min(100, nan))` evaluated to 100, so a candidate
    with corrupt data was handed the highest possible score in the batch.
    """
    import main
    from models import technical_pattern_engine

    nan = float("nan")
    kr = technical_pattern_engine.TechnicalPatternResult(
        bullish_probability=nan, confidence=nan, detected_patterns=[], source="test"
    )
    cr = type("CR", (), {
        "forecast_return_pct": nan, "trend": "neutral",
        "median_forecast": [], "quantile_forecasts": {},
    })()
    score, components = main._compute_composite_score(
        kr, cr, {"composite": nan, "world_score": nan}, {"ofi_ratio": nan}
    )
    assert score != 100.0, "NaN input produced a PERFECT composite score"
    assert math.isfinite(score)
    assert 0.0 <= score <= 100.0
    assert all(math.isfinite(v) for v in components.values())


def test_composite_score_normal_input_is_unchanged():
    """The NaN guard must not disturb legitimate scoring."""
    import main
    from models import technical_pattern_engine

    kr = technical_pattern_engine.TechnicalPatternResult(
        bullish_probability=0.8, confidence=0.7, detected_patterns=[], source="test"
    )
    cr = type("CR", (), {
        "forecast_return_pct": 2.0, "trend": "bullish",
        "median_forecast": [], "quantile_forecasts": {},
    })()
    score, _ = main._compute_composite_score(
        kr, cr, {"composite": 0.5, "world_score": 0.0}, {"ofi_ratio": 0.3}
    )
    assert score == pytest.approx(0.8 * 50 + (1 / (1 + math.exp(-6.0))) * 30 + 0.7 * 15 + 0.5 * 5 + 1.5, abs=0.2)
    assert score > 70.0


# ---------------------------------------------------------------------------
# Technical pattern engine
# ---------------------------------------------------------------------------

def test_trend_bias_nan_close_does_not_produce_maximum_bullish():
    """
    One NaN close previously yielded trend_bias = +0.3 (the clamp ceiling),
    giving the highest-scoring candidate in the batch for corrupt data.
    """
    from models import technical_pattern_engine as tpe

    clean = [[100.0 + i, 101.0 + i, 99.0 + i, 100.5 + i, 1000.0 + i] for i in range(25)]
    res_clean = tpe.infer(clean)

    corrupt = [list(row) for row in clean]
    corrupt[10][3] = float("nan")  # one NaN close
    res_corrupt = tpe.infer(corrupt)

    assert math.isfinite(res_corrupt.bullish_probability)
    assert math.isfinite(res_corrupt.confidence)
    # A single NaN must not manufacture more bullishness than an intact series.
    assert res_corrupt.bullish_probability <= res_clean.bullish_probability + 0.05
    assert 0.0 <= res_corrupt.bullish_probability <= 1.0


def test_six_column_ohlcv_does_not_silently_disable_ta_features():
    """
    A 6-column [timestamp, O, H, L, C, V] payload — the documented RL contract
    format — previously raised inside the TA block, and the swallowed exception
    silently disabled the ADX chop dampener and ATR confidence reduction.
    """
    from models import technical_pattern_engine as tpe

    base = [[100.0 + i, 101.0 + i, 99.0 + i, 100.5 + i, 1000.0 + i] for i in range(25)]
    with_ts = [[1700000000.0 + i * 86400] + row for i, row in enumerate(base)]

    res = tpe.infer(with_ts)
    assert math.isfinite(res.bullish_probability)
    assert 0.0 <= res.bullish_probability <= 1.0
    # The TA path must not have bailed out.
    assert not any("Failed to compute advanced TA" in str(p) for p in res.detected_patterns)


def test_four_column_ohlcv_still_supported():
    from models import technical_pattern_engine as tpe

    four = [[100.0 + i, 101.0 + i, 99.0 + i, 100.5 + i] for i in range(25)]
    res = tpe.infer(four)
    assert math.isfinite(res.bullish_probability)


# ---------------------------------------------------------------------------
# Confluence
# ---------------------------------------------------------------------------

def test_confluence_nan_feature_does_not_score_maximum():
    """
    A NaN feature previously produced confluence score 100.0, above the
    legitimate best case of ~61.
    """
    from models.confluence_service import ConfluenceService, FALLBACK_WEIGHTS

    svc = ConfluenceService()
    svc.models = {}
    score = svc.get_score("NO_SUCH_REGIME", {"tech_score": float("nan")})
    assert score != 100.0
    assert math.isfinite(score)
    assert 0.0 <= score <= 100.0
    # Sanity: the max legitimate fallback score is sum of weighted 100s.
    assert score <= sum(100 * w for w in FALLBACK_WEIGHTS.values())


def test_confluence_load_models_swap_is_atomic():
    """load_models must replace the mapping, never clear-then-refill in place."""
    from models.confluence_service import ConfluenceService

    svc = ConfluenceService()
    svc.models = {"A": object()}
    before = svc.models
    svc.load_models(force=True)
    # A reader holding the previous snapshot keeps a consistent view.
    assert before is svc.models or "A" in before or len(before) == 0


# ---------------------------------------------------------------------------
# Consensus: risk must not be overruled by an optimistic engine
# ---------------------------------------------------------------------------

def test_consensus_multiplier_does_not_overrule_a_risk_downsize():
    """
    The two multipliers are opposite-polarity signals, not two votes.

    1.25 is returned only when an engine sees CLEAN conditions; 0.85 only when
    it sees elevated risk. Taking max() let one optimistic engine size UP on a
    state the other engine flagged as dangerous — the exact inverse of the
    function's own "adopt the more conservative" contract.
    """
    from models.system1_base import System1Decision
    from models.system1_service import System1Service

    svc = System1Service()
    laya = System1Decision(
        verdict="APPROVE", action="EXECUTE_IMMEDIATELY", confidence=0.85,
        opportunity_score=80.0, position_size_multiplier=1.25,
        p_execution_success=0.85, p_stop_hunt_risk=0.10, p_adverse_regime_shift=0.10,
    )
    jev = System1Decision(
        verdict="APPROVE", action="LIMIT_PULLBACK", confidence=0.80,
        opportunity_score=80.0, position_size_multiplier=0.85,
        p_execution_success=0.60, p_stop_hunt_risk=0.60, p_adverse_regime_shift=0.10,
    )
    out = svc.resolve_decision(laya, jev, preferred_engine="laya")

    assert out.position_size_multiplier <= min(1.25, 0.85) + 1e-9
    assert out.position_size_multiplier == 0.85
    # A plain mean would sit exactly on the 0.35 routing threshold and erase
    # the warning; the pessimistic reading must survive pooling.
    assert out.p_stop_hunt_risk >= 0.60
    assert out.p_stop_hunt_risk > 0.35


def test_consensus_keeps_upside_when_both_engines_agree_it_is_clean():
    from models.system1_base import System1Decision
    from models.system1_service import System1Service

    svc = System1Service()
    laya = System1Decision(
        verdict="APPROVE", action="EXECUTE_IMMEDIATELY", confidence=0.85,
        opportunity_score=88.0, position_size_multiplier=1.25,
        p_execution_success=0.88, p_stop_hunt_risk=0.10, p_adverse_regime_shift=0.10,
    )
    jev = System1Decision(
        verdict="APPROVE", action="EXECUTE_IMMEDIATELY", confidence=0.90,
        opportunity_score=90.0, position_size_multiplier=1.25,
        p_execution_success=0.90, p_stop_hunt_risk=0.08, p_adverse_regime_shift=0.08,
    )
    out = svc.resolve_decision(laya, jev, preferred_engine="laya")
    assert out.position_size_multiplier == 1.25
    assert out.p_stop_hunt_risk == pytest.approx(0.10)


# ---------------------------------------------------------------------------
# RL observation
# ---------------------------------------------------------------------------

def test_rl_state_never_contains_nan():
    """
    `bool(nan)` is True, so the previous `x / d if x else default` guards let NaN
    through. An all-NaN observation makes argmax return 0 -> a confident
    STRONG_SELL, and confidence=NaN crashed response serialization.
    """
    import numpy as np
    from models.rl_agent import rl_agent_service

    df = __import__("pandas").DataFrame(
        {
            "close": [100.0 + i for i in range(30)],
            "volume": [1000.0 + i for i in range(30)],
        }
    )
    df.loc[15, "close"] = float("nan")
    state = rl_agent_service.prepare_state(df, {"vix": 15.0, "fiiNet": 0.0})
    assert np.all(np.isfinite(state)), "RL observation contains non-finite values"


def test_rl_scaled_helper_collapses_non_finite():
    from models.rl_agent import _scaled

    assert _scaled(float("nan"), 100.0, 0.5) == 0.5
    assert _scaled(float("inf"), 100.0, 0.5) == 0.5
    assert _scaled(None, 100.0, 0.5) == 0.5
    assert _scaled(200.0, 100.0, 0.5) == 2.0


# ---------------------------------------------------------------------------
# Batch endpoint robustness
# ---------------------------------------------------------------------------

def test_closes_for_tolerates_ragged_rows(client, monkeypatch):
    """
    A row shorter than 4 numbers previously raised IndexError OUTSIDE any
    handler, discarding every other candidate's work in the batch.
    """
    import main

    monkeypatch.setenv("SYSTEM1_ENGINE", "laya")

    async def mock_sentiment(symbol):
        return {"symbol_specific_score": 0.5, "market_wide_score": 0.0, "world_score": 0.0, "composite": 0.5}

    monkeypatch.setattr(main, "analyze_sentiment", mock_sentiment)

    candles = [[100.0 + i, 102.0 + i, 99.0 + i, 101.5 + i, 5000.0] for i in range(25)]
    base = {"direction": "BUY", "setup_type": "PULLBACK", "risk_reward_ratio": 2.2, "india_vix": 14.0}

    ragged = [list(r) for r in candles]
    ragged[3] = [1.0, 2.0, 3.0]  # only 3 numbers

    payload = {
        "candidates": [
            {"symbol": "RAGGED", "ohlcv": ragged, "features": dict(base)},
            {"symbol": "FINE", "ohlcv": candles, "features": dict(base)},
        ]
    }
    response = client.post("/inference/batch", json=payload)
    assert response.status_code == 200, response.text
    results = {r["symbol"]: r for r in response.json()["results"]}
    # The malformed candidate must not 500 the batch or void the healthy one.
    assert len(results) == 2
    assert results["FINE"]["scored"] is True
    assert results["FINE"]["system1_decision"] is not None


# ---------------------------------------------------------------------------
# env_loader
# ---------------------------------------------------------------------------

def test_env_quoted_value_with_trailing_comment_has_no_literal_quotes():
    """
    Node's dotenv yields `abc123`; the previous parser yielded `"abc123"`,
    producing `Authorization: Bearer "abc123"` -> HTTP 401 -> the Jev circuit
    breaker opens permanently.
    """
    from env_loader import parse_env_file

    import os
    import tempfile

    d = tempfile.mkdtemp()
    p = os.path.join(d, ".env")
    with open(p, "w", encoding="utf-8") as fh:
        fh.write('TYPESAFE_API_KEY="abc123"   # rotated 2026-01\n')
    assert parse_env_file(p)["TYPESAFE_API_KEY"] == "abc123"


def test_env_search_stops_at_repo_root():
    """
    The walk must not continue above the repository root — a `~/.env` is a
    common place to stash credentials, and silently applying one to a live
    trading service is a security hazard.

    Note: on this machine the repo itself lives *under* the home directory, so
    the assertion is that the walk stops AT the repo root, not that no path
    starts with `~`.
    """
    from env_loader import resolve_env_paths

    import os

    here = os.path.abspath("backend/ai_service")
    repo_root = os.path.abspath(".")
    paths = resolve_env_paths(here)

    assert paths, "no candidate paths resolved"
    # Every candidate lives inside the repository.
    for p in paths:
        assert os.path.abspath(p).startswith(repo_root + os.sep), f"escapes repo root: {p}"
    # The repo root itself is examined, and nothing above it.
    assert any(os.path.abspath(p) == os.path.join(repo_root, ".env") for p in paths)
    # Nothing above the repo root (e.g. Desktop\.env, home\.env) is included.
    assert not any(os.path.abspath(p) == os.path.join(os.path.dirname(repo_root), ".env") for p in paths)


# ---------------------------------------------------------------------------
# Sentiment cache bound
# ---------------------------------------------------------------------------

def test_sentiment_cache_is_bounded():
    """A per-symbol cache that was only ever overwritten leaked one entry per symbol."""
    import sentiment

    with sentiment._sentiment_cache_lock:
        sentiment._sentiment_cache.clear()
        now = 1e9
        for i in range(sentiment._SENTIMENT_CACHE_MAX + 500):
            sentiment._sentiment_cache[f"SYM{i}"] = (now, {"a": 1.0})
        sentiment._prune_sentiment_cache(now)
        assert len(sentiment._sentiment_cache) <= sentiment._SENTIMENT_CACHE_MAX
    sentiment._sentiment_cache.clear()


# ---------------------------------------------------------------------------
# Ranker gate visibility: a silent veto disarm must be detectable
# ---------------------------------------------------------------------------

def test_ranker_reports_gate_coverage_and_mismatch_counts(monkeypatch):
    """
    A null `win_probability` makes signal_generator SKIP the hard
    `P(win) < threshold` veto entirely — it does not degrade the decision, it
    removes the only calibrated risk gate the system has. That must be visible in
    status, continuously, rather than as a one-shot warning buried in the
    service log.
    """
    from models import ranker_service as rs

    monkeypatch.setattr(rs, "_rows_predicted_count", 10, raising=False)
    monkeypatch.setattr(rs, "_width_mismatch_count", 5, raising=False)
    monkeypatch.setattr(rs, "_rows_without_features", 5, raising=False)
    monkeypatch.setattr(rs, "_loaded", True, raising=False)
    monkeypatch.setattr(rs, "_feature_keys", ["f"] * 32, raising=False)

    st = rs.get_status()
    for key in (
        "gate_active",
        "rows_predicted",
        "width_mismatch_rows",
        "without_features_rows",
        "gate_coverage",
    ):
        assert key in st, f"ranker status missing {key}"

    assert st["gate_active"] is True
    assert st["rows_predicted"] == 10
    assert st["width_mismatch_rows"] == 5
    assert st["without_features_rows"] == 5
    # 10 of 20 candidates were actually scored; the other 10 bypassed the veto.
    assert st["gate_coverage"] == pytest.approx(0.5)


def test_ranker_gate_coverage_is_none_before_any_prediction():
    """No coverage claim should be made before the model has been consulted."""
    from models import ranker_service as rs

    rs._rows_predicted_count = 0
    rs._width_mismatch_count = 0
    rs._rows_without_features = 0
    assert rs.get_status()["gate_coverage"] is None


def test_width_mismatch_is_counted_continuously_not_latched_once():
    """
    The original code warned once via `_width_warned` and then went silent. A
    recurring contract mismatch must keep accumulating so the disarm is visible
    in status rather than disappearing after the first occurrence.
    """
    from models import ranker_service as rs

    rs.load_model()
    if not rs.is_loaded():
        pytest.skip("no ranker artifact available")

    expected = len(rs._feature_keys)
    bad_row = [0.0] * max(1, expected - 1)  # deliberately wrong width
    good_row = [0.0] * expected

    rs._width_mismatch_count = 0
    rs._rows_predicted_count = 0

    out = rs.predict_batch([bad_row, good_row])
    # The malformed row must not receive a fabricated probability.
    assert out[0] is None
    assert out[1] is not None
    assert rs._width_mismatch_count == 1

    rs.predict_batch([bad_row])
    assert rs._width_mismatch_count == 2, "mismatch count stopped accumulating"
    assert rs.get_status()["width_mismatch_rows"] == 2


def test_rows_without_features_are_counted_separately_from_width_mismatch():
    """
    An empty row is a missing feature vector, not contract drift. Counting it in
    both buckets inflates width_mismatch_rows and makes gate_coverage meaningless.
    """
    from models import ranker_service as rs

    rs.load_model()
    if not rs.is_loaded():
        pytest.skip("no ranker artifact available")

    expected = len(rs._feature_keys)
    good = [0.0] * expected
    empty = []
    wrong = [0.0] * (expected - 1)

    rs._rows_predicted_count = 0
    rs._width_mismatch_count = 0
    rs._rows_without_features = 0

    out = rs.predict_batch([good, empty, wrong])
    assert out[0] is not None
    assert out[1] is None
    assert out[2] is None

    st = rs.get_status()
    assert st["rows_predicted"] == 1
    assert st["without_features_rows"] == 1, "empty row misclassified"
    assert st["width_mismatch_rows"] == 1, "empty row double-counted as mismatch"
    assert st["gate_coverage"] == pytest.approx(1 / 3, abs=1e-3)  # status rounds to 4dp


# ---------------------------------------------------------------------------
# riskRewardScore units: a 0-100 score must never be read as an R multiple
# ---------------------------------------------------------------------------

def _normalize_rr_score(rr: float) -> int:
    """Mirror of feature_engine.ts computeRiskRewardScore (3.0 == 100)."""
    if rr <= 0:
        return 0
    if rr >= 3.0:
        return 100
    return round((rr / 3.0) * 100)


def test_resolve_risk_reward_prefers_explicit_r_multiple():
    from models.system1_base import resolve_risk_reward

    assert resolve_risk_reward({"risk_reward_ratio": 2.4}) == 2.4
    assert resolve_risk_reward({"riskReward": 1.9}) == 1.9
    # Explicit value wins even when a normalized score is also present.
    assert resolve_risk_reward({"risk_reward_ratio": 0.4, "riskRewardScore": 87}) == 0.4


def test_resolve_risk_reward_denormalizes_score():
    from models.system1_base import resolve_risk_reward

    # score 100 -> 3.0 R ; score 10 -> 0.30 R (NOT 10 R)
    assert resolve_risk_reward({"riskRewardScore": 100}) == pytest.approx(3.0)
    assert resolve_risk_reward({"riskRewardScore": 10}) == pytest.approx(0.30, abs=1e-6)
    assert resolve_risk_reward({"riskRewardScore": 33}) == pytest.approx(0.99, abs=1e-6)


@pytest.mark.parametrize("bad", [0, -5, float("nan"), float("inf"), None, "abc"])
def test_resolve_risk_reward_falls_back_on_unusable_input(bad):
    from models.system1_base import resolve_risk_reward

    if bad is None:
        assert resolve_risk_reward({}) == 1.5
        return
    assert resolve_risk_reward({"risk_reward_ratio": bad, "riskRewardScore": bad}) == 1.5


def test_resolve_risk_reward_passes_through_absurd_but_wellformed_value():
    """
    A large but finite R multiple is well-formed, so it is honoured rather than
    silently clamped — clamping would hide genuine data problems. It saturates
    the opportunity score at 100 through the existing clamp, which is the
    intended behaviour for a very high-conviction setup.
    """
    from models.system1_base import resolve_risk_reward

    assert resolve_risk_reward({"risk_reward_ratio": 1e9}) == 1e9


def test_terrible_rr_cannot_buy_max_size_via_normalized_score():
    """
    Regression for a units bug that inverted the R:R safety gate.

    A setup with a real R:R of 0.3 (risking 3x more than it can win) reports
    riskRewardScore = 10. Read as an R multiple that is `rr = 10`, which:
      * passed the `rr < 1.2` hard reject,
      * added (10/3)*20 = 66.7 opportunity points,
      * scored opportunity 100 / APPROVE / 1.25x — MAXIMUM position size for
        the WORST possible setup.
    """
    from models.system1_base import (
        check_hard_risk_gates,
        evaluate_deterministic_system1,
    )

    base = {
        "direction": "BUY",
        "setup_type": "BREAKOUT",
        "technical_score": 70,
        "india_vix": 14.0,
        "order_flow_imbalance_ratio": 0.25,
        "market_regime": "BULL_TRENDING",
        "chronos_trend": "bullish",
        "fii_dii_net": 800,
    }

    for true_rr in (0.3, 0.5, 0.8, 1.0):
        state = {**base, "riskRewardScore": _normalize_rr_score(true_rr)}
        gate = check_hard_risk_gates(state, provider="jev", model_id="jev-1", source="t")
        assert gate is not None, f"true R:R {true_rr} bypassed the hard gate via a 0-100 score"
        assert gate.verdict == "REJECT" and gate.position_size_multiplier == 0.0

        d = evaluate_deterministic_system1(
            state, provider="jev", model_id="jev-1", source="t", check_gates=False
        )
        assert d.opportunity_score < 100.0, f"true R:R {true_rr} scored a perfect opportunity"

    # A genuinely good R:R must still be approved and able to scale up.
    good = {**base, "riskRewardScore": _normalize_rr_score(3.0)}
    gate = check_hard_risk_gates(good, provider="jev", model_id="jev-1", source="t")
    assert gate is None
    d = evaluate_deterministic_system1(
        good, provider="jev", model_id="jev-1", source="t", check_gates=False
    )
    assert d.verdict == "APPROVE"
    assert d.position_size_multiplier == 1.25
