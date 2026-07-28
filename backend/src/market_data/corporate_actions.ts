/**
 * Corporate Actions Blacklist
 * ─────────────────────────────────────────────────────────────────────────────
 * Fetches the NSE event calendar to identify stocks with upcoming earnings
 * results, board meetings, or dividend ex-dates within the next 3 days.
 * Suggestions are skipped for blacklisted symbols to avoid binary event risk.
 *
 * Data source: NSE event calendar API (public, requires browser-like headers).
 * Cache TTL: 6 hours. Fails gracefully — returns empty set on error.
 */

import axios from "axios";
import { logger } from "../lib/logger";
import { getISTDateStr, shiftISTDateStr } from "../lib/ist-time";

const NSE_BASE = "https://www.nseindia.com";

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": `${NSE_BASE}/`,
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-origin",
};

interface EventRow {
  symbol?: string;
  purpose?: string;
  exDate?: string;
  date?: string;
}

let cachedBlacklist: Set<string> = new Set();
let cacheTime = 0;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
let fetchInFlight: Promise<Set<string>> | null = null;
let lastFailureTime = 0;
const FAILURE_COOLDOWN_MS = 60 * 1000;

async function getNSECookies(): Promise<string> {
  try {
    const resp = await axios.get(NSE_BASE, {
      headers: BROWSER_HEADERS,
      timeout: 10_000,
      maxRedirects: 3,
    });
    const raw = resp.headers["set-cookie"] as string | string[] | undefined;
    if (!raw) return "";
    return Array.isArray(raw) ? raw.map(c => c.split(";")[0]).join("; ") : (raw as string).split(";")[0] ?? "";
  } catch (err) {
    logger.warn({ err }, "Suppressed error: failed to fetch NSE cookies");
    return "";
  }
}

/**
 * Returns a Set of NSE symbols that have a corporate event (earnings, board
 * meeting, ex-dividend) within the next 3 trading days. Empty set on failure.
 */
export async function fetchCorporateActionBlacklist(): Promise<Set<string>> {
  if (Date.now() - cacheTime < CACHE_TTL_MS) return cachedBlacklist;
  if (fetchInFlight) return fetchInFlight;
  if (Date.now() - lastFailureTime < FAILURE_COOLDOWN_MS) return cachedBlacklist;

  fetchInFlight = (async () => {
    try {
      const cookies = await getNSECookies();

      // NSE dates must be IST calendar days — toISOString (UTC) is a day behind
      // between 00:00 and 05:29 IST.
      const from = getISTDateStr();
      const to = shiftISTDateStr(from, 3);

      const url = `${NSE_BASE}/api/event-calendar?index=equities&from=${from}&to=${to}`;

      const resp = await axios.get(url, {
        headers: { ...BROWSER_HEADERS, Cookie: cookies },
        timeout: 10_000,
      });

      // NSE returns an error object (not an array) on soft failures — guard so
      // the log names the payload instead of an iterator TypeError.
      if (!Array.isArray(resp.data)) {
        logger.warn({ data: resp.data }, "Corporate actions: unexpected non-array response — using cached blacklist");
        lastFailureTime = Date.now();
        return cachedBlacklist;
      }
      const rows: EventRow[] = resp.data;
      const blacklist = new Set<string>();

      const SENSITIVE_KEYWORDS = ["results", "dividend", "board meeting", "bonus", "rights", "split"];

      for (const row of rows) {
        const purpose = (row.purpose ?? "").toLowerCase();
        const symbol = (row.symbol ?? "").toUpperCase().trim();
        if (!symbol) continue;
        if (SENSITIVE_KEYWORDS.some(kw => purpose.includes(kw))) {
          blacklist.add(symbol);
        }
      }

      cachedBlacklist = blacklist;
      cacheTime = Date.now();
      lastFailureTime = 0;
      logger.info({ count: blacklist.size }, "Corporate action blacklist refreshed");
      return blacklist;
    } catch (err) {
      lastFailureTime = Date.now();
      logger.warn({ err }, "Corporate actions fetch failed — using empty blacklist");
      return cachedBlacklist;
    } finally {
      fetchInFlight = null;
    }
  })();

  return fetchInFlight;
}

export interface SplitAdjustment {
  exDate: string; // ISO date string YYYY-MM-DD
  splitRatio: number; // e.g. 0.5 for a 1:2 split (2 new shares for 1 old share -> price halved)
}

/**
 * Adjust historical OHLCV candles retroactively across split/bonus ex-dates.
 * Prior candles before the exDate are multiplied by splitRatio (for prices)
 * and divided by splitRatio (for volume), preventing artificial indicator spikes.
 */
export function adjustCandlesForCorporateActions<T extends { timestamp: string; open: number; high: number; low: number; close: number; volume: number }>(
  candles: T[],
  adjustments: SplitAdjustment[]
): T[] {
  if (!candles || candles.length === 0 || !adjustments || adjustments.length === 0) {
    return candles;
  }

  // Sort adjustments in chronological order
  const sorted = [...adjustments].sort((a, b) => a.exDate.localeCompare(b.exDate));

  return candles.map((c) => {
    let cumulativeRatio = 1.0;
    const candleDate = c.timestamp.slice(0, 10);

    for (const adj of sorted) {
      if (candleDate < adj.exDate) {
        cumulativeRatio *= adj.splitRatio;
      }
    }

    if (cumulativeRatio === 1.0) return c;

    return {
      ...c,
      open: Number((c.open * cumulativeRatio).toFixed(4)),
      high: Number((c.high * cumulativeRatio).toFixed(4)),
      low: Number((c.low * cumulativeRatio).toFixed(4)),
      close: Number((c.close * cumulativeRatio).toFixed(4)),
      volume: Math.round(c.volume / cumulativeRatio),
    };
  });
}

