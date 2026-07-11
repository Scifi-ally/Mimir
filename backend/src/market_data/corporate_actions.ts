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

function fmtDate(d: Date): string {
  return d.toISOString().split("T")[0]!;
}

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

  try {
    const cookies = await getNSECookies();

    const from = new Date();
    const to = new Date();
    to.setDate(to.getDate() + 3);

    const url = `${NSE_BASE}/api/event-calendar?index=equities&from=${fmtDate(from)}&to=${fmtDate(to)}`;

    const resp = await axios.get(url, {
      headers: { ...BROWSER_HEADERS, Cookie: cookies },
      timeout: 10_000,
    });

    const rows: EventRow[] = resp.data ?? [];
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
    logger.info({ count: blacklist.size }, "Corporate action blacklist refreshed");
    return blacklist;
  } catch (err) {
    logger.warn({ err }, "Corporate actions fetch failed — using empty blacklist");
    return cachedBlacklist;
  }
}
