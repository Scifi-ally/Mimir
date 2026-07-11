import pytest
from sentiment import analyze_sentiment
from models import technical_pattern_engine
from models import chronos_service

@pytest.mark.asyncio
async def test_sentiment_scoring(monkeypatch):
    # Mock network calls
    async def mock_fetch_symbol_news(symbol):
        return ["Good news", "Positive updates"]
    async def mock_fetch_moneycontrol():
        return ["Market is booming"]
    async def mock_fetch_economic_times():
        return ["Economy is growing"]
    async def mock_fetch_world_politics():
        return ["Global peace"]
    
    # Mock the pipeline itself
    import sentiment
    monkeypatch.setattr(sentiment, "fetch_yahoo_finance_headlines", mock_fetch_symbol_news)
    monkeypatch.setattr(sentiment, "fetch_moneycontrol_market_headlines", mock_fetch_moneycontrol)
    monkeypatch.setattr(sentiment, "fetch_economictimes_market_headlines", mock_fetch_economic_times)
    monkeypatch.setattr(sentiment, "fetch_world_politics_headlines", mock_fetch_world_politics)
    monkeypatch.setattr(sentiment, "_score_headlines_sync", lambda headlines: 0.8)
    monkeypatch.setattr(sentiment, "sentiment_pipeline", lambda x: [{"label": "positive", "score": 0.8}])

    result = await analyze_sentiment("RELIANCE")
    
    assert "symbol_specific_score" in result
    assert "market_wide_score" in result
    assert "world_score" in result
    assert "composite" in result
    
    # Check explicitly defined weights
    # 0.8 * 0.5 + 0.8 * 0.3 + 0.8 * 0.2 = 0.8
    assert abs(result["composite"] - 0.8) < 0.01

def test_technical_engine_status():
    status = technical_pattern_engine.get_status()
    assert "loaded" in status
    assert "healthy" in status

def test_chronos_engine_status():
    status = chronos_service.get_status()
    assert "loaded" in status
    assert "healthy" in status
