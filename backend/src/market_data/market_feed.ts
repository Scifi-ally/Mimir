/**
 * Market Feed
 * ─────────────────────────────────────────────────────────────────────────────
 * Polls Nifty 50 and India VIX from Upstox LTP every 5 minutes during market
 * hours and updates the in-memory market state so the regime detector has real
 * data to work with.
 *
 * Without this, `niftyChangePct` and `indiaVix` remain null forever and the
 * regime is always UNKNOWN — meaning no VIX-based pause gates can fire.
 */
import axios from "axios";
import { getAccessToken, invalidateAccessToken } from "../upstox/auth";
import { updateMarketState } from "./market_state";
import { detectRegime } from "../analysis/regime_detector";
import { logger } from "../lib/logger";
import { getISTDateStr } from "../lib/ist-time";
import { createUpstoxClient } from "../lib/upstox-client";

const NIFTY_KEY = "NSE_INDEX|Nifty 50";
const VIX_KEY = "NSE_INDEX|India VIX";
const marketFeedClient = createUpstoxClient({ cacheTimeMs: 1_000 });

function normalizeInstrumentKey(value: string): string {
  return value.trim().toUpperCase().replace(":", "|");
}



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
  const token = getAccessToken();
  if (!token) {
    feedSnapshot = {
      ...feedSnapshot,
      status: "unauthenticated",
      authenticated: false,
      note: "Upstox authorization required",
    };
    logger.warn("Market feed init skipped — not authenticated");
    return;
  }

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
    const now = new Date();
    const toDate = new Date(now);
    const fromDate = new Date(now);
    fromDate.setUTCDate(fromDate.getUTCDate() - 7); // look back 7 days to skip holidays
    const toStr = toDate.toISOString().split("T")[0]!;
    const fromStr = fromDate.toISOString().split("T")[0]!;

    const url = `https://api.upstox.com/v2/historical-candle/${encodeURIComponent(NIFTY_KEY)}/day/${toStr}/${fromStr}`;
    const resp = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      timeout: 10_000,
    });

    // Candles come newest-first from Upstox.
    // candles[0] = today's in-progress candle (if market is open)
    // candles[1] = yesterday's completed candle
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const candles: any[][] = resp.data?.data?.candles ?? [];
    if (candles.length < 2) {
      logger.warn(
        { candles: candles.length },
        "Not enough Nifty candles for prev close",
      );
      return;
    }

    niftyPrevClose = candles[1]?.[4] as number; // [4] = close
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
 */
export async function updateMarketFeed(): Promise<void> {
  const token = getAccessToken();
  if (!token) {
    feedSnapshot = {
      ...feedSnapshot,
      status: "unauthenticated",
      authenticated: false,
      note: "Upstox authorization required",
    };
    return;
  }

  // Lazily initialise prev close if not done yet
  if (niftyPrevClose === null) {
    await initMarketFeed();
  }

  try {
    const prices = await marketFeedClient.fetchLTPForInstruments(
      [NIFTY_KEY, VIX_KEY],
      token,
    );

    const niftyLTP = prices[normalizeInstrumentKey(NIFTY_KEY)] ?? null;
    const vixLTP = prices[normalizeInstrumentKey(VIX_KEY)] ?? null;
    const availableKeys = Object.keys(prices);

    if (niftyLTP === null && vixLTP === null) {
      feedSnapshot = {
        ...feedSnapshot,
        status: "partial",
        authenticated: true,
        fetchedAt: new Date().toISOString(),
        note: "No quote data returned",
      };
      logger.warn(
        { availableKeys },
        "Market feed: no Nifty/VIX data returned from Upstox",
      );
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
          ? "Upstox quotes updated"
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
      },
      "Market feed updated",
    );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    const status = err?.response?.status;
    if (status === 401 || status === 403) {
      await invalidateAccessToken(`market_feed_http_${status}`);
      feedSnapshot = {
        ...feedSnapshot,
        status: "unauthenticated",
        authenticated: false,
        fetchedAt: new Date().toISOString(),
        note: "Upstox session expired. Re-authorize.",
      };
      logger.warn({ status }, "Market feed authentication failed");
      return;
    }

    feedSnapshot = {
      ...feedSnapshot,
      status: "failed",
      authenticated: true,
      fetchedAt: new Date().toISOString(),
      note: "Market feed poll failed",
    };

    if (err && (err.name === "AxiosError" || err.isAxiosError)) {
      logger.warn(
        {
          status,
          message: err.message,
          code: err.code,
          url: err.config?.url,
        },
        "Market feed poll failed (AxiosError)",
      );
    } else {
      logger.warn({ err: err instanceof Error ? err.message : err }, "Market feed poll failed");
    }
  }
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
  const tokenPresent = getAccessToken() !== null;
  return {
    ...feedSnapshot,
    authenticated: feedSnapshot.authenticated || tokenPresent,
    status:
      tokenPresent && feedSnapshot.status === "idle"
        ? "loading"
        : feedSnapshot.status,
    note:
      tokenPresent && feedSnapshot.status === "idle"
        ? "Token available. Waiting for first quote poll."
        : feedSnapshot.note,
  };
}
