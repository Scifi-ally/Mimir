import asyncio
import threading
import xml.etree.ElementTree as ET
import logging
import re
import time
from typing import List, Dict, Optional, Tuple
import httpx
import os
import datetime

logger = logging.getLogger("ai_service.sentiment")

# Try importing transformers; if it fails or is unavailable, fallback to neutral
sentiment_pipeline = None
_sentiment_initialized = False
_init_lock = threading.Lock()
_degraded_warned = False
# HF fast tokenizers are not thread-safe under concurrent __call__ ("Already
# borrowed") — serialize every pipeline invocation across worker threads.
_pipeline_call_lock = threading.Lock()
# Wall-clock time of the most recent runtime FinBERT inference failure, used
# to shorten cache lifetimes for results scored while inference was broken.
_finbert_last_failure_ts = 0.0

# In-memory cache: symbol -> (timestamp, result_dict)
_sentiment_cache: Dict[str, Tuple[float, Dict[str, float]]] = {}
# Market-wide and world scores are shared across all symbols
# key -> (timestamp, (market_wide_score, india_political_score, world_score))
_market_cache: Dict[str, Tuple[float, Tuple[float, float, float]]] = {}
_MARKET_CACHE_KEY = "market_shared"
_market_cache_lock: Optional[asyncio.Lock] = None
CACHE_TTL_SEC = 300  # 5 minutes — RSS feeds don't update faster than this
# Scores computed while FinBERT inference was failing are cached only briefly
# so healthy results aren't locked out for the full TTL.
FAILURE_CACHE_TTL_SEC = 20

# Background DB-save tasks — keep strong references so they aren't GC'd mid-flight
_bg_tasks: set = set()

# Geopolitical keywords that amplify sentiment impact on Indian markets
INDIA_GEOPOLITICAL_KEYWORDS = {
    # India-Pakistan / border tensions
    "india pakistan": -0.6,
    "kashmir": -0.4,
    "loc violation": -0.3,
    "line of control": -0.3,
    "ceasefire violation": -0.7,
    "surgical strike": -0.8,
    "indian military": -0.4,
    # India-China
    "india china": -0.4,
    "ladakh": -0.5,
    "galwan": -0.6,
    "lac standoff": -0.5,
    # Global trade / tariffs
    "trade war": -0.5,
    "tariff": -0.3,
    "sanctions on india": -0.6,
    "import duty": -0.2,
    # Oil / energy geopolitics (India is net importer)
    "opec cut": -0.4,
    "oil supply": -0.3,
    "strait of hormuz": -0.5,
    "red sea": -0.3,
    "suez canal": -0.3,
    # Global risk events
    "nuclear": -0.6,
    "missile": -0.4,
    "invasion": -0.5,
    "war": -0.4,
    "coup": -0.3,
    # Positive geopolitical for India
    "india trade deal": 0.5,
    "fdi india": 0.4,
    "make in india": 0.3,
    "india gdp growth": 0.5,
    "rbi rate cut": 0.5,
    "rbi holds rate": 0.2,
    "india upgrade": 0.5,
    "modi": 0.1,  # Mild positive (market-friendly perception)
    # US Fed / global monetary
    "fed rate cut": 0.4,
    "fed pause": 0.2,
    "fed hike": -0.4,
    "recession": -0.5,
    "inflation": -0.2,
}

# Indian political / policy keywords
INDIA_POLITICAL_KEYWORDS = {
    "budget": 0.1,
    "fiscal deficit": -0.2,
    "disinvestment": 0.3,
    "privatization": 0.3,
    "subsidy cut": 0.2,
    "tax relief": 0.3,
    "gst": 0.1,
    "election": -0.2,  # Uncertainty
    "coalition": -0.2,
    "no confidence": -0.5,
    "policy reform": 0.3,
    "infrastructure spend": 0.4,
    "capital expenditure": 0.3,
    "pli scheme": 0.3,
    "sebi": -0.1,
    "rbi circular": -0.1,
    "adani": -0.2,  # Governance concerns
    "hindenburg": -0.4,
}

# Precompiled word-boundary patterns so 'war' can't match 'warns'/'award',
# 'gst' can't match arbitrary substrings, etc. The optional (?:e?s)? suffix
# keeps inflected headline forms matching ('tariffs', 'missiles', 'opec cuts',
# 'elections') without reopening the substring hole. Kept as two dicts because
# a keyword present in both lists is intentionally counted twice.
_GEOPOLITICAL_PATTERNS = [
    (re.compile(r"\b" + re.escape(kw) + r"(?:e?s)?\b"), impact)
    for kw, impact in INDIA_GEOPOLITICAL_KEYWORDS.items()
]
_POLITICAL_PATTERNS = [
    (re.compile(r"\b" + re.escape(kw) + r"(?:e?s)?\b"), impact)
    for kw, impact in INDIA_POLITICAL_KEYWORDS.items()
]


def init_models():
    """Eagerly load the FinBERT model."""
    global sentiment_pipeline, _sentiment_initialized
    with _init_lock:
        if _sentiment_initialized:
            return
        _sentiment_initialized = True
        try:
            from transformers import pipeline
            sentiment_pipeline = pipeline("sentiment-analysis", model="ProsusAI/finbert")
            logger.info("Successfully loaded ProsusAI/finbert for sentiment analysis.")
        except Exception as e:
            logger.warning(f"Failed to load FinBERT sentiment model: {e}. Sentiment analysis will return neutral.")
            sentiment_pipeline = None


def get_status() -> Dict[str, bool]:
    """Health snapshot for the sentiment component."""
    return {
        "loaded": sentiment_pipeline is not None,
        "healthy": sentiment_pipeline is not None,
        "initialized": _sentiment_initialized,
    }


async def _fetch_rss(url: str, limit: int = 10, max_retries: int = 2) -> List[Dict[str, str]]:
    """Fetch RSS headlines with publication date for recency weighting."""
    async with httpx.AsyncClient(timeout=5.0) as client:
        for attempt in range(max_retries):
            try:
                response = await client.get(url, headers={'User-Agent': 'Mozilla/5.0'})
                response.raise_for_status()
                xml_data = response.text

                root = ET.fromstring(xml_data)
                items = []
                for item in root.findall('./channel/item'):
                    title = item.find('title')
                    pub_date = item.find('pubDate')
                    if title is not None and title.text:
                        items.append({
                            "title": title.text.strip(),
                            "pub_date": pub_date.text.strip() if pub_date is not None and pub_date.text else "",
                        })
                return items[:limit]
            except Exception as e:
                logger.debug(f"Could not fetch RSS from {url} (Attempt {attempt + 1}/{max_retries}): {e}")
                if attempt < max_retries - 1:
                    await asyncio.sleep(0.5 * (2 ** attempt))
        return []


def _parse_hours_ago(pub_date: str) -> float:
    """Parse RSS pubDate into hours ago. Returns 24+ if unparseable."""
    if not pub_date:
        return 24.0
    try:
        from email.utils import parsedate_to_datetime
        dt = parsedate_to_datetime(pub_date)
        delta = datetime.datetime.now(datetime.timezone.utc) - dt
        return max(0, delta.total_seconds() / 3600)
    except Exception:
        return 24.0


def _recency_weight(hours_ago: float) -> float:
    """Exponential decay: recent headlines matter more. Half-life = 6 hours."""
    return 2.0 ** (-hours_ago / 6.0)


async def fetch_yahoo_finance_headlines(symbol: str) -> List[Dict[str, str]]:
    clean_symbol = symbol.upper().replace(".NS", "").replace(".BO", "")
    url = f"https://feeds.finance.yahoo.com/rss/2.0/headline?s={clean_symbol}.NS&region=IN&lang=en-IN"
    return await _fetch_rss(url)


async def fetch_moneycontrol_market_headlines() -> List[Dict[str, str]]:
    url = "https://www.moneycontrol.com/rss/marketreports.xml"
    return await _fetch_rss(url)


async def fetch_economictimes_market_headlines() -> List[Dict[str, str]]:
    url = "https://economictimes.indiatimes.com/markets/rssfeeds/2146842.cms"
    return await _fetch_rss(url)


async def fetch_livemint_market_headlines() -> List[Dict[str, str]]:
    url = "https://www.livemint.com/rss/markets"
    return await _fetch_rss(url, limit=8)


async def fetch_world_politics_headlines() -> List[Dict[str, str]]:
    url = "https://news.yahoo.com/rss/world"
    return await _fetch_rss(url)


async def fetch_india_politics_headlines() -> List[Dict[str, str]]:
    """India-specific political and policy news."""
    urls = [
        "https://economictimes.indiatimes.com/news/politics-and-nation/rssfeeds/1052732854.cms",
        "https://www.livemint.com/rss/politics",
    ]
    all_items: List[Dict[str, str]] = []
    results = await asyncio.gather(*[_fetch_rss(url, limit=6) for url in urls], return_exceptions=True)
    for r in results:
        if isinstance(r, list):
            all_items.extend(r)
    return all_items[:12]


async def fetch_rbi_policy_headlines() -> List[Dict[str, str]]:
    """RBI and monetary policy news."""
    url = "https://economictimes.indiatimes.com/news/economy/policy/rssfeeds/1373380680.cms"
    return await _fetch_rss(url, limit=6)


def _score_geopolitical_impact(headline: str) -> float:
    """Score a headline's geopolitical impact on Indian markets.

    Uses signed saturation, NOT a plain average. Averaging diluted the most
    important headlines: "Modi announces surgical strike" matched both
    "surgical strike" (-0.8) and "modi" (+0.1) and averaged to -0.35, roughly
    half the severity of "surgical strike" alone — so a keyword-DENSE risk
    headline could score less alarming than a sparse one and slip above the
    macro crash-penalty threshold. Instead we anchor on the single
    strongest-magnitude signal and let additional same-direction matches
    reinforce it with diminishing returns, while opposite-direction matches
    only dampen. The result is clamped to [-1, 1].
    """
    text_lower = headline.lower()
    impacts: List[float] = []

    for pattern, impact in _GEOPOLITICAL_PATTERNS:
        if pattern.search(text_lower):
            impacts.append(impact)

    for pattern, impact in _POLITICAL_PATTERNS:
        if pattern.search(text_lower):
            impacts.append(impact)

    if not impacts:
        return 0.0

    # Anchor on the dominant signal (largest magnitude), preserving its sign.
    dominant_idx = max(range(len(impacts)), key=lambda i: abs(impacts[i]))
    dominant = impacts[dominant_idx]
    # Same-direction matches reinforce with diminishing returns (each adds 25%
    # of its magnitude); opposite-direction matches dampen at full weight.
    reinforcement = 0.0
    for i, imp in enumerate(impacts):
        if i == dominant_idx:
            continue
        if (imp >= 0) == (dominant >= 0):
            reinforcement += 0.25 * imp
        else:
            reinforcement += imp
    score = dominant + reinforcement
    return max(-1.0, min(1.0, score))


def _score_headlines_advanced(items: List[Dict[str, str]], apply_geopolitical: bool = False) -> float:
    """Score headlines with recency weighting and optional geopolitical amplification."""
    if not items:
        return 0.0

    headlines = [item["title"] for item in items[:15]]
    pub_dates = [item.get("pub_date", "") for item in items[:15]]

    # FinBERT scoring
    global _finbert_last_failure_ts
    finbert_scores: List[float] = []
    finbert_ok = sentiment_pipeline is not None
    if sentiment_pipeline is not None:
        try:
            with _pipeline_call_lock:
                results = sentiment_pipeline(headlines)
            for res in results:
                label = res['label'].lower()
                score = res['score']
                if label == 'positive':
                    finbert_scores.append(score)
                elif label == 'negative':
                    finbert_scores.append(-score)
                else:
                    finbert_scores.append(0.0)
        except Exception as e:
            _finbert_last_failure_ts = time.time()
            logger.warning(f"FinBERT scoring failed: {e}")
            finbert_scores = [0.0] * len(headlines)
            finbert_ok = False
    else:
        finbert_scores = [0.0] * len(headlines)

    # Apply recency weighting and geopolitical amplification
    weighted_sum = 0.0
    weight_total = 0.0

    for i, (headline, pub_date) in enumerate(zip(headlines, pub_dates)):
        hours_ago = _parse_hours_ago(pub_date)
        recency = _recency_weight(hours_ago)

        base_score = finbert_scores[i] if i < len(finbert_scores) else 0.0

        if apply_geopolitical:
            geo_impact = _score_geopolitical_impact(headline)
            # Blend FinBERT with geopolitical keyword scoring
            # Geopolitical keywords carry 40% weight when detected;
            # with FinBERT unavailable OR its inference failing at runtime,
            # keyword score carries full weight so the macro thresholds
            # remain reachable in degraded mode.
            if abs(geo_impact) > 0:
                if not finbert_ok:
                    combined = geo_impact
                else:
                    combined = base_score * 0.6 + geo_impact * 0.4
            else:
                combined = base_score
        else:
            combined = base_score

        weighted_sum += combined * recency
        weight_total += recency

    if weight_total == 0:
        return 0.0

    return weighted_sum / weight_total


async def _get_market_wide_scores() -> Tuple[float, float, float]:
    """Fetch + score the shared (non-symbol) feeds once per CACHE_TTL_SEC.

    Returns (market_wide_score, india_political_score, world_score) — the same
    for all symbols, so a single cached copy keeps cross-symbol rankings
    consistent within a batch and avoids refetching 6 feeds per symbol.
    """
    global _market_cache_lock
    if _market_cache_lock is None:
        _market_cache_lock = asyncio.Lock()

    now = time.time()
    cached = _market_cache.get(_MARKET_CACHE_KEY)
    if cached and now - cached[0] < CACHE_TTL_SEC:
        return cached[1]

    async with _market_cache_lock:
        # Re-check after acquiring the lock (thundering-herd guard)
        now = time.time()
        cached = _market_cache.get(_MARKET_CACHE_KEY)
        if cached and now - cached[0] < CACHE_TTL_SEC:
            return cached[1]

        (
            mc_headlines,
            et_headlines,
            mint_headlines,
            world_headlines,
            india_pol_headlines,
            rbi_headlines,
        ) = await asyncio.gather(
            fetch_moneycontrol_market_headlines(),
            fetch_economictimes_market_headlines(),
            fetch_livemint_market_headlines(),
            fetch_world_politics_headlines(),
            fetch_india_politics_headlines(),
            fetch_rbi_policy_headlines(),
        )

        market_wide_headlines = mc_headlines + et_headlines + mint_headlines
        india_political_all = india_pol_headlines + rbi_headlines

        # Run FinBERT inference in thread pool
        scoring_started = time.time()
        market_wide_score, world_score, india_political_score = await asyncio.gather(
            asyncio.to_thread(_score_headlines_advanced, market_wide_headlines, False),
            asyncio.to_thread(_score_headlines_advanced, world_headlines, True),
            asyncio.to_thread(_score_headlines_advanced, india_political_all, True),
        )

        scores = (market_wide_score, india_political_score, world_score)
        if _finbert_last_failure_ts >= scoring_started:
            # FinBERT failed while scoring this batch — backdate the entry so
            # it expires after FAILURE_CACHE_TTL_SEC instead of poisoning the
            # market-wide scores for every symbol for the full TTL.
            _market_cache[_MARKET_CACHE_KEY] = (
                time.time() - CACHE_TTL_SEC + FAILURE_CACHE_TTL_SEC,
                scores,
            )
        else:
            _market_cache[_MARKET_CACHE_KEY] = (time.time(), scores)
        return scores


async def analyze_sentiment(symbol: str) -> Dict[str, float]:
    """
    Returns an advanced sentiment dictionary with India-aware geopolitical scoring:
    {
      "symbol_specific_score": float,
      "market_wide_score": float,
      "india_political_score": float,
      "world_score": float,
      "composite": float
    }
    """
    global _degraded_warned
    now = time.time()

    # Check cache
    if symbol in _sentiment_cache:
        cached_ts, cached_result = _sentiment_cache[symbol]
        if now - cached_ts < CACHE_TTL_SEC:
            return cached_result

    if sentiment_pipeline is None and not _sentiment_initialized:
        # Off the event loop — FinBERT may download hundreds of MB on first run.
        # init_models is idempotent under _init_lock, so racing the startup
        # loader thread is safe.
        await asyncio.to_thread(init_models)

    if sentiment_pipeline is None and not _degraded_warned:
        _degraded_warned = True
        logger.warning(
            "FinBERT unavailable — sentiment running in degraded mode using "
            "geopolitical/political keyword scoring only."
        )

    # Shared (market-wide/political/world) feeds: fetched + scored once per TTL
    shared_task = asyncio.create_task(_get_market_wide_scores())
    symbol_headlines = await fetch_yahoo_finance_headlines(symbol)
    market_wide_score, india_political_score, world_score = await shared_task

    # Symbol-specific scoring in thread pool
    symbol_specific_score = await asyncio.to_thread(
        _score_headlines_advanced, symbol_headlines, False
    )

    # Weighted composite — India political and geopolitical carry meaningful weight
    SYMBOL_WEIGHT = 0.30
    MARKET_WEIGHT = 0.25
    INDIA_POLITICAL_WEIGHT = 0.25
    WORLD_WEIGHT = 0.20

    composite = (
        symbol_specific_score * SYMBOL_WEIGHT
        + market_wide_score * MARKET_WEIGHT
        + india_political_score * INDIA_POLITICAL_WEIGHT
        + world_score * WORLD_WEIGHT
    )

    result = {
        "symbol_specific_score": round(symbol_specific_score, 4),
        "market_wide_score": round(market_wide_score, 4),
        "india_political_score": round(india_political_score, 4),
        "world_score": round(world_score, 4),
        "composite": round(composite, 4),
    }

    # Cache result — briefly if FinBERT inference failed during this run,
    # since the composite then embeds degraded (keyword-only) scores.
    if _finbert_last_failure_ts >= now:
        _sentiment_cache[symbol] = (now - CACHE_TTL_SEC + FAILURE_CACHE_TTL_SEC, result)
    else:
        _sentiment_cache[symbol] = (now, result)

    # Save to DB in background
    def save_to_db():
        db_url = os.getenv("DATABASE_URL")
        if not db_url:
            return
        try:
            import psycopg2
            from contextlib import closing
            with closing(psycopg2.connect(db_url)) as conn:
                with conn.cursor() as cur:
                    now_dt = datetime.datetime.now()
                    cur.execute("""
                        INSERT INTO fundamental_snapshots (symbol, field_name, value, filed_date, fetched_at)
                        VALUES (%s, %s, %s, %s, %s)
                    """, (symbol, 'sentiment_composite', composite, now_dt, now_dt))
                    cur.execute("""
                        INSERT INTO fundamental_snapshots (symbol, field_name, value, filed_date, fetched_at)
                        VALUES (%s, %s, %s, %s, %s)
                    """, (symbol, 'sentiment_india_political', india_political_score, now_dt, now_dt))
                    # Persist world_score too: the composite blend applies a macro
                    # crash penalty when world_score < -0.5 (see _compute_composite_score
                    # in main.py). Without storing it, the PIT/backtest path had to
                    # assume world_score=0 and could NEVER reproduce that penalty, so
                    # historical scores diverged from live scores on risk-off days.
                    cur.execute("""
                        INSERT INTO fundamental_snapshots (symbol, field_name, value, filed_date, fetched_at)
                        VALUES (%s, %s, %s, %s, %s)
                    """, (symbol, 'sentiment_world', world_score, now_dt, now_dt))
                    conn.commit()
        except Exception as e:
            logger.error(f"Failed to save sentiment snapshot: {e}")

    task = asyncio.create_task(asyncio.to_thread(save_to_db))
    _bg_tasks.add(task)
    task.add_done_callback(_bg_tasks.discard)

    return result
