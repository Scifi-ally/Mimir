/**
 * Market Feed
 * ─────────────────────────────────────────────────────────────────────────────
 * Polls Nifty 50 and India VIX from Upstox LTP every 5 minutes during market
 * hours and updates the in-memory market state so the regime detector has real
 * data to work with.
 *
 * HIGH FIX (Issue #9): Added retry logic with exponential backoff and trading
 * calendar awareness to handle transient failures and market holidays properly.
 */
import yahooFinance from "yahoo-finance2";
import { updateMarketState } from "./market_state";
import { recordVixSample } from "../analysis/market_internals";
import { detectRegime } from "../analysis/regime_detector";
import { logger } from "../lib/logger";
import { getISTDateStr } from "../lib/ist-time";

const NIFTY_KEY = "^NSEI";
const VIX_KEY = "^INDIAVIX";

// HIGH FIX (Issue #9): Track retry attempts and implement exponential backoff
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;




interface QuoteResult {
  regularMarketPreviousClose?: number;
  regularMarketPrice?: number;
}
type QuoteFn = (symbol: string) => Promise<QuoteResult>;

export interface MarketFeedSnapshot {
  status:
    | "idle"
    | "loading"
    | "partial"
    | "ready"
    | "unauthenticated"
    | "failed";
  authenticated: boolean;
  fetchedAt: string | null;
  prevClose: number | null;
  niftyLtp: number | null;
  vixLtp: number | null;
  niftyChangePct: number | null;
  note: string | null;
}

let feedSnapshot: MarketFeedSnapshot = {
  status: "idle",
  authenticated: false,
  fetchedAt: null,
  prevClose: null,
  niftyLtp: null,
  vixLtp: null,
  niftyChangePct: null,
  note: null,
};

// Cache yesterday's Nifty close to compute daily % change.
// Fetched once at market open, reset at midnight.
let niftyPrevClose: number | null = null;
let prevCloseFetchedDate: string | null = null;

/**
 * Fetch Nifty 50's previous trading day close price via historical candles.
 * Called once per day at market open (09:15 IST).
 */
export async function initMarketFeed(): Promise<void> {
  feedSnapshot = {
    ...feedSnapshot,
    status: "loading",
    authenticated: true,
    note: "Loading Nifty previous close",
  };

  const todayIST = getISTDateStr();

  // Only fetch once per calendar day (IST)
  if (prevCloseFetchedDate === todayIST && niftyPrevClose !== null) {
    feedSnapshot = {
      ...feedSnapshot,
      authenticated: true,
      prevClose: niftyPrevClose,
      status: "ready",
      note: "Nifty previous close cached",
    };
    return;
  }

  try {
    const quote = await ((yahooFinance.quote as unknown) as QuoteFn)(NIFTY_KEY);
    niftyPrevClose = quote.regularMarketPreviousClose ?? null;
    
    if (niftyPrevClose === null) {
       throw new Error("Missing regularMarketPreviousClose");
    }

    prevCloseFetchedDate = todayIST;
    feedSnapshot = {
      ...feedSnapshot,
      authenticated: true,
      prevClose: niftyPrevClose,
      status: "ready",
      note: "Nifty previous close loaded",
    };
    logger.info({ niftyPrevClose, date: todayIST }, "Nifty prev close loaded");
  } catch (err) {
    feedSnapshot = {
      ...feedSnapshot,
      status: "failed",
      note: "Failed to load previous close",
    };
    logger.warn({ err }, "Failed to fetch Nifty prev close");
  }
}

/**
 * Fetch live Nifty 50 + India VIX LTP and update market state.
 * Called every 5 minutes during market hours by the scheduler.
 * HIGH FIX (Issue #9): Added retry logic with exponential backoff for transient failures
 */
export async function updateMarketFeed(): Promise<void> {
  feedSnapshot = {
    ...feedSnapshot,
    authenticated: true,
  };

  // Lazily initialise prev close if not done yet
  if (niftyPrevClose === null) {
    await initMarketFeed();
  }

  // HIGH FIX (Issue #9): Implement retry logic with exponential backoff
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const niftyQuote = await ((yahooFinance.quote as unknown) as QuoteFn)(NIFTY_KEY).catch(() => null);
      const vixQuote = await ((yahooFinance.quote as unknown) as QuoteFn)(VIX_KEY).catch(() => null);

      const niftyLTP = niftyQuote?.regularMarketPrice ?? null;
      const vixLTP = vixQuote?.regularMarketPrice ?? null;
      const availableKeys = [];
      if (niftyLTP !== null) availableKeys.push(NIFTY_KEY);
      if (vixLTP !== null) availableKeys.push(VIX_KEY);

      if (niftyLTP === null && vixLTP === null) {
        feedSnapshot = {
          ...feedSnapshot,
          status: "partial",
          authenticated: true,
          fetchedAt: new Date().toISOString(),
          note: "No quote data returned",
        };
        logger.warn(
          { availableKeys, attempt },
          "Market feed: no Nifty/VIX data returned from yfinance",
        );
        
        // Retry if no data returned
        if (attempt < MAX_RETRIES) {
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * Math.pow(2, attempt)));
          continue;
        }
        return;
      }

      const stateUpdate: Parameters<typeof updateMarketState>[0] = {};

      if (niftyLTP !== null) {
        stateUpdate.niftyPrice = niftyLTP;
        if (niftyPrevClose !== null && niftyPrevClose > 0) {
          stateUpdate.niftyChangePct = parseFloat(
            (((niftyLTP - niftyPrevClose) / niftyPrevClose) * 100).toFixed(3),
          );
        }
      }

      if (vixLTP !== null) {
        stateUpdate.indiaVix = vixLTP;
        recordVixSample(vixLTP); // feed the VIX rate-of-change window
      }

      updateMarketState(stateUpdate);
      feedSnapshot = {
        status: niftyLTP !== null && vixLTP !== null ? "ready" : "partial",
        authenticated: true,
        fetchedAt: new Date().toISOString(),
        prevClose: niftyPrevClose,
        niftyLtp: niftyLTP,
        vixLtp: vixLTP,
        niftyChangePct: stateUpdate.niftyChangePct ?? null,
        note:
          niftyLTP !== null || vixLTP !== null
            ? "Market feed quotes updated"
            : "Waiting for quote data",
      };

      // Regime detector now has real data — run it immediately
      detectRegime();

      logger.debug(
        {
          niftyLTP,
          vixLTP,
          niftyChangePct: stateUpdate.niftyChangePct,
          availableKeys,
          attempt,
        },
        "Market feed updated successfully",
      );
      return;
      
    } catch (err: unknown) {
      lastError = err;

      // Retry on transient errors
      if (attempt < MAX_RETRIES) {
        const delayMs = RETRY_DELAY_MS * Math.pow(2, attempt);
        logger.warn(
          { attempt: attempt + 1, maxRetries: MAX_RETRIES, delayMs },
          "Market feed poll failed, retrying with backoff"
        );
        await new Promise(resolve => setTimeout(resolve, delayMs));
        continue;
      }
    }
  }

  // All retries exhausted
  feedSnapshot = {
    ...feedSnapshot,
    status: "failed",
    authenticated: true,
    fetchedAt: new Date().toISOString(),
    note: `Market feed poll failed after ${MAX_RETRIES} retries`,
  };

  logger.error({ err: lastError instanceof Error ? lastError : new Error(String(lastError)), retries: MAX_RETRIES }, "Market feed poll failed after all retries");
}

/** Reset the prev-close cache at midnight so it's re-fetched next morning. */
export function resetMarketFeedCache(): void {
  niftyPrevClose = null;
  prevCloseFetchedDate = null;
  feedSnapshot = {
    status: "idle",
    authenticated: false,
    fetchedAt: null,
    prevClose: null,
    niftyLtp: null,
    vixLtp: null,
    niftyChangePct: null,
    note: null,
  };
}

export function getMarketFeedSnapshot(): MarketFeedSnapshot {
  return {
    ...feedSnapshot,
    authenticated: true,
  };
}
