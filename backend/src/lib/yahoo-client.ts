import YahooFinance from "yahoo-finance2";

// v3 exports a constructor; its static methods throw migration errors.
// Share the instance so callers also share the SDK's session and request queue.
export const yahooFinance = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
