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


def test_chronos_infer_batch_shape_and_alignment():
    # With no HF weights loaded this exercises the fallback path, but the batch
    # API contract (one result per input series, order preserved) must hold
    # regardless of whether the model or the fallback produced each forecast.
    series = [
        [100.0, 100.5, 101.0, 101.4, 101.9, 102.3],
        [50.0, 49.5, 49.0, 48.7, 48.2, 47.6],
        [200.0] * 6,
    ]
    results = chronos_service.infer_batch(series, steps=5)

    assert len(results) == len(series)
    for res in results:
        assert len(res.median_forecast) == 5
        assert res.trend in ("bullish", "bearish", "neutral")
        assert "q50" in res.quantile_forecasts

    # Uptrend should not forecast lower than a downtrend series (directional sanity).
    assert results[0].forecast_return_pct >= results[1].forecast_return_pct


def test_chronos_infer_batch_handles_invalid_series():
    # A too-short series must not crash the batch; it yields a neutral forecast
    # while valid neighbours still produce real forecasts.
    results = chronos_service.infer_batch([[100.0], [10.0, 11.0, 12.0, 13.0, 14.0]], steps=3)
    assert len(results) == 2
    assert results[0].source == "error"
    assert results[0].median_forecast == []
    assert len(results[1].median_forecast) == 3


def test_ranker_graceful_degradation():
    # The hard guarantee: with no trained artifacts (and/or no lightgbm) the
    # ranker must NOT be loaded and predict_batch must return one None per row
    # so callers cleanly fall back to the composite score. The zero-dependency
    # install depends on this never raising.
    from models import ranker_service

    ranker_service.load_model()  # no artifacts in the repo — must stay unloaded
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
