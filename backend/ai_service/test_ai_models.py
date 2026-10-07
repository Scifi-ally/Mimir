import json
from pathlib import Path

import pytest
from sentiment import analyze_sentiment
from models import technical_pattern_engine
from models import chronos_service

@pytest.mark.asyncio
async def test_sentiment_scoring(monkeypatch):
    # Mock network calls (fetchers return dicts with title + pub_date for recency weighting)
    async def mock_fetch_symbol_news(symbol):
        return [{"title": "Good news", "pub_date": ""}, {"title": "Positive updates", "pub_date": ""}]
    async def mock_fetch_market():
        return [{"title": "Market is booming", "pub_date": ""}]
    async def mock_fetch_politics():
        return [{"title": "Global peace", "pub_date": ""}]

    # Mock the pipeline itself
    import sentiment
    monkeypatch.setattr(sentiment, "fetch_yahoo_finance_headlines", mock_fetch_symbol_news)
    monkeypatch.setattr(sentiment, "fetch_moneycontrol_market_headlines", mock_fetch_market)
    monkeypatch.setattr(sentiment, "fetch_economictimes_market_headlines", mock_fetch_market)
    monkeypatch.setattr(sentiment, "fetch_livemint_market_headlines", mock_fetch_market)
    monkeypatch.setattr(sentiment, "fetch_world_politics_headlines", mock_fetch_politics)
    monkeypatch.setattr(sentiment, "fetch_india_politics_headlines", mock_fetch_politics)
    monkeypatch.setattr(sentiment, "fetch_rbi_policy_headlines", mock_fetch_politics)
    monkeypatch.setattr(sentiment, "_score_headlines_advanced", lambda items, apply_geopolitical=False: 0.8)
    monkeypatch.setattr(sentiment, "sentiment_pipeline", lambda x: [{"label": "positive", "score": 0.8}])
    # Results are cached per symbol / per market window; clear so the mocks take effect
    monkeypatch.setattr(sentiment, "_sentiment_cache", {})
    monkeypatch.setattr(sentiment, "_market_cache", {})

    result = await analyze_sentiment("RELIANCE")

    assert "symbol_specific_score" in result
    assert "market_wide_score" in result
    assert "world_score" in result
    assert "composite" in result

    # All components mocked to 0.8 and the weights (0.30 + 0.25 + 0.25 + 0.20) sum to 1.0
    assert abs(result["composite"] - 0.8) < 0.01

def test_technical_engine_status():
    status = technical_pattern_engine.get_status()
    assert "loaded" in status
    assert "healthy" in status

def test_chronos_engine_status():
    status = chronos_service.get_status()
    assert "loaded" in status
    assert "healthy" in status


def test_chronos_infer_batch_abstains_without_model(monkeypatch):
    # Use recorded NSE OHLCV. Missing Chronos weights must produce an explicit
    # unavailable result, never synthetic quantiles derived from price movement.
    recorded = json.loads((Path(__file__).parents[1] / "tests" / "fixtures" / "recorded_nse_daily.json").read_text())
    series = [[bar[4] for bar in recorded["bars"]["RELIANCE"]]]
    monkeypatch.setattr(chronos_service, "_model_loaded", False)
    results = chronos_service.infer_batch(series, steps=5)

    assert len(results) == len(series)
    for res in results:
        assert res.median_forecast == []
        assert res.quantile_forecasts == {}
        assert res.trend == "neutral"
        assert res.forecast_return_pct is None
        assert res.source == "unavailable"


def test_chronos_infer_batch_handles_invalid_series(monkeypatch):
    # Invalid input remains distinguishable from a valid series for which the
    # forecasting model is unavailable.
    recorded = json.loads((Path(__file__).parents[1] / "tests" / "fixtures" / "recorded_nse_daily.json").read_text())
    closes = [bar[4] for bar in recorded["bars"]["RELIANCE"]]
    monkeypatch.setattr(chronos_service, "_model_loaded", False)
    results = chronos_service.infer_batch([[100.0], closes], steps=3)
    assert len(results) == 2
    assert results[0].source == "error"
    assert results[0].median_forecast == []
    assert results[0].forecast_return_pct is None
    assert results[1].source == "unavailable"
    assert results[1].median_forecast == []
    assert results[1].quantile_forecasts == {}
    assert results[1].forecast_return_pct is None


def test_ranker_graceful_degradation(monkeypatch):
    # The hard guarantee: with no trained artifacts (and/or no lightgbm) the
    # ranker must NOT be loaded and predict_batch must return one None per row
    # so callers cleanly fall back to the composite score. The zero-dependency
    # install depends on this never raising.
    from models import ranker_service

    monkeypatch.setenv("RANKER_MODEL_PATH", "/nonexistent/ranker_model.txt")
    monkeypatch.setenv("RANKER_META_PATH", "/nonexistent/ranker_meta.json")
    ranker_service._loaded = False
    ranker_service._booster = None
    ranker_service.load_model()  # non-existent artifacts — must stay unloaded
    assert ranker_service.is_loaded() is False

    status = ranker_service.get_status()
    assert "loaded" in status
    assert status["loaded"] is False

    probs = ranker_service.predict_batch([[0.0] * 27, [1.0] * 27])
    assert probs == [None, None]
    # An empty batch must also be safe.
    assert ranker_service.predict_batch([]) == []
    # No model -> no gate.
    assert ranker_service.recommended_threshold() is None


def test_sentiment_deduplicates_headlines_and_exposes_status(monkeypatch):
    import sentiment

    items = [
        {"title": "  RBI cuts rates  ", "pub_date": ""},
        {"title": "rbi   cuts rates", "pub_date": ""},
        {"title": "Market opens higher", "pub_date": ""},
    ]
    unique = sentiment._deduplicate_headlines(items)
    assert [item["title"] for item in unique] == ["  RBI cuts rates  ", "Market opens higher"]

    monkeypatch.setattr(sentiment, "sentiment_pipeline", None)
    status = sentiment.get_status()
    assert status["model"] == "ProsusAI/finbert"
    assert status["fallback_active"] is True
    assert status["fallback_mode"] == "keyword_or_neutral"
    assert "failure_count" in status
    assert "last_error" in status
