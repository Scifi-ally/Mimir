import asyncio
import sys
sys.path.insert(0, "./backend/ai_service")
from sentiment import analyze_sentiment, fetch_yahoo_finance_headlines, fetch_moneycontrol_market_headlines, fetch_economictimes_market_headlines

async def test():
    print("Testing RSS Feeds...")
    mc = await fetch_moneycontrol_market_headlines()
    print("MC:", mc)
    et = await fetch_economictimes_market_headlines()
    print("ET:", et)
    yh = await fetch_yahoo_finance_headlines("RELIANCE")
    print("YH:", yh)
    
    print("\nTesting Sentiment...")
    res = await analyze_sentiment("RELIANCE")
    print(res)

asyncio.run(test())
