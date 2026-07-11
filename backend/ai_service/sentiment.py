import asyncio
import xml.etree.ElementTree as ET
import logging
from typing import List, Dict, Optional
import httpx

logger = logging.getLogger("ai_service.sentiment")

# Try importing transformers; if it fails or is unavailable, fallback to neutral
sentiment_pipeline = None
_sentiment_initialized = False

def init_models():
    """Eagerly load the FinBERT model."""
    global sentiment_pipeline, _sentiment_initialized
    if _sentiment_initialized:
        return
    _sentiment_initialized = True
    try:
        from transformers import pipeline
        # Initialize the sentiment pipeline globally to load the model into memory once.
        # We use "ProsusAI/finbert" which classifies financial texts into positive, negative, neutral.
        sentiment_pipeline = pipeline("sentiment-analysis", model="ProsusAI/finbert")
        logger.info("Successfully loaded ProsusAI/finbert for sentiment analysis.")
    except Exception as e:
        logger.warning(f"Failed to load FinBERT sentiment model: {e}. Sentiment analysis will return neutral.")
        sentiment_pipeline = None

async def _fetch_rss(url: str, limit: int = 5, max_retries: int = 3) -> List[str]:
    async with httpx.AsyncClient(timeout=5.0) as client:
        for attempt in range(max_retries):
            try:
                response = await client.get(url, headers={'User-Agent': 'Mozilla/5.0'})
                response.raise_for_status()
                xml_data = response.text
                
                root = ET.fromstring(xml_data)
                headlines = []
                for item in root.findall('./channel/item'):
                    title = item.find('title')
                    if title is not None and title.text:
                        headlines.append(title.text.strip())
                return headlines[:limit]
            except Exception as e:
                logger.debug(f"Could not fetch RSS from {url} (Attempt {attempt + 1}/{max_retries}): {e}")
                if attempt < max_retries - 1:
                    await asyncio.sleep(1.0 * (2 ** attempt)) # Exponential backoff
        return []

async def fetch_yahoo_finance_headlines(symbol: str) -> List[str]:
    clean_symbol = symbol.upper().replace(".NS", "").replace(".BO", "")
    url = f"https://feeds.finance.yahoo.com/rss/2.0/headline?s={clean_symbol}.NS&region=IN&lang=en-IN"
    return await _fetch_rss(url)

async def fetch_moneycontrol_market_headlines() -> List[str]:
    url = "https://www.moneycontrol.com/rss/marketreports.xml"
    return await _fetch_rss(url)

async def fetch_economictimes_market_headlines() -> List[str]:
    url = "https://economictimes.indiatimes.com/markets/rssfeeds/2146842.cms"
    return await _fetch_rss(url)

async def fetch_world_politics_headlines() -> List[str]:
    url = "https://news.yahoo.com/rss/world"
    return await _fetch_rss(url)

def _score_headlines_sync(headlines: List[str]) -> float:
    if not headlines or sentiment_pipeline is None:
        return 0.0
    try:
        results = sentiment_pipeline(headlines[:10]) # Evaluate up to 10 headlines
        score_sum = 0.0
        for res in results:
            label = res['label'].lower()
            score = res['score']
            if label == 'positive':
                score_sum += score
            elif label == 'negative':
                score_sum -= score
        return score_sum / len(results)
    except Exception as e:
        logger.warning(f"Sentiment analysis failed on batch: {e}")
        return 0.0

async def analyze_sentiment(symbol: str) -> Dict[str, float]:
    """
    Returns an advanced sentiment dictionary:
    {
      "symbol_score": float,
      "world_score": float,
      "composite": float
    }
    """
    if sentiment_pipeline is None and not _sentiment_initialized:
        init_models()
        
    if sentiment_pipeline is None:
        return {"symbol_specific_score": 0.0, "market_wide_score": 0.0, "world_score": 0.0, "composite": 0.0}

    # Fetch all RSS feeds concurrently without blocking the event loop
    symbol_headlines, mc_headlines, et_headlines, world_headlines = await asyncio.gather(
        fetch_yahoo_finance_headlines(symbol),
        fetch_moneycontrol_market_headlines(),
        fetch_economictimes_market_headlines(),
        fetch_world_politics_headlines()
    )

    # Explicit Weights
    SYMBOL_SPECIFIC_WEIGHT = 0.5
    MARKET_WIDE_WEIGHT = 0.3
    WORLD_POLITICS_WEIGHT = 0.2

    market_wide_headlines = mc_headlines + et_headlines

    # Run heavy PyTorch model inference in a separate thread so we don't block the async event loop
    symbol_specific_score, market_wide_score, world_score = await asyncio.gather(
        asyncio.to_thread(_score_headlines_sync, symbol_headlines),
        asyncio.to_thread(_score_headlines_sync, market_wide_headlines),
        asyncio.to_thread(_score_headlines_sync, world_headlines)
    )
    
    composite = (symbol_specific_score * SYMBOL_SPECIFIC_WEIGHT) + \
                (market_wide_score * MARKET_WIDE_WEIGHT) + \
                (world_score * WORLD_POLITICS_WEIGHT)

    return {
        "symbol_specific_score": symbol_specific_score,
        "market_wide_score": market_wide_score,
        "world_score": world_score,
        "composite": composite
    }
