/**
 * NSE Free Data Feeds
 * ─────────────────────────────────────────────────────────────────────────────
 * Free daily datasets from NSE that materially improve signal quality:
 *
 * 1. Delivery percentage (sec_bhavdata_full CSV) — high delivery % + price up
 *    means real accumulation vs. intraday churn. Used to filter fake momentum.
 * 2. F&O ban list (securities in ban period) — banned symbols behave
 *    erratically; suggestions on them are hard-rejected.
 * 3. Bulk/block deals — institutional footprints per symbol. A momentum signal
 *    with a recent bulk BUY is treated as stronger confluence.
 *
 * All fetchers fail gracefully (empty/last-known data) and never fabricate.
 */

import axios from "axios";
import { logger } from "../lib/logger";
import { getISTDateStr, getLastCompletedTradingDayStr, shiftISTDateStr } from "../lib/ist-time";

const NSE_BASE = "https://www.nseindia.com";
const NSE_ARCHIVES = "https://archives.nseindia.com";
const NSE_FNO_BAN_CSV = "https://nsearchives.nseindia.com/content/fo/fo_secban.csv";

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": `${NSE_BASE}/`,
  // NSE fingerprints on the Chrome client hints — without these the API 403s
  // even with valid cookies. Keep in sync with fii_dii.ts.
  "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
};

// NSE only issues its full cookie set after a real navigation. Warming the
// homepage + a content page and accumulating Set-Cookie from both is what makes
// the JSON API return 200 instead of 403. See [[nse-scraping-recipe]].
async function getNSECookies(): Promise<string> {
  const jar = new Map<string, string>();
  const collect = (raw: string | string[] | undefined) => {
    if (!raw) return;
    const arr = Array.isArray(raw) ? raw : [raw];
    for (const c of arr) {
      const [pair] = c.split(";");
      const eq = pair.indexOf("=");
      if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  };
  try {
    const home = await axios.get(NSE_BASE, {
      headers: { ...BROWSER_HEADERS, Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
      timeout: 10_000,
      maxRedirects: 3,
    });
    collect(home.headers["set-cookie"] as string | string[] | undefined);
    try {
      const warm = await axios.get(`${NSE_BASE}/market-data/securities-available-for-trading`, {
        headers: { ...BROWSER_HEADERS, Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", Referer: `${NSE_BASE}/` },
        timeout: 10_000,
        maxRedirects: 3,
      });
      collect(warm.headers["set-cookie"] as string | string[] | undefined);
    } catch {
      // Warmup page best-effort; homepage cookies alone sometimes suffice.
    }
    return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "NSE cookie fetch failed");
    return "";
  }
}

// Common headers for an NSE JSON API call made as an in-page XHR.
function nseApiHeaders(cookies: string): Record<string, string> {
  return {
    ...BROWSER_HEADERS,
    "X-Requested-With": "XMLHttpRequest",
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
    Cookie: cookies,
  };
}

// ── 1. Delivery percentage ────────────────────────────────────────────────────

export interface DeliveryData {
  deliveryPct: number;      // % of traded qty actually delivered
  turnover: number;         // traded value (lakhs)
  date: string;             // IST trading date the data is for
}

let deliveryCache: Map<string, DeliveryData> = new Map();
let deliveryCacheDate = "";
let deliveryFetchInFlight: Promise<Map<string, DeliveryData>> | null = null;

/** Bhavcopy date format: 02012026 → ddmmyyyy */
function bhavDateParam(istDateStr: string): string {
  const [y, m, d] = istDateStr.split("-");
  return `${d}${m}${y}`;
}

async function fetchDeliveryCSV(istDateStr: string): Promise<Map<string, DeliveryData> | null> {
  const url = `${NSE_ARCHIVES}/products/content/sec_bhavdata_full_${bhavDateParam(istDateStr)}.csv`;
  const resp = await axios.get<string>(url, {
    headers: BROWSER_HEADERS,
    timeout: 20_000,
    responseType: "text",
    validateStatus: (s) => s === 200,
  });

  const lines = resp.data.split("\n");
  if (lines.length < 2) return null;

  // Header: SYMBOL, SERIES, DATE1, PREV_CLOSE, OPEN_PRICE, HIGH_PRICE, LOW_PRICE,
  // LAST_PRICE, CLOSE_PRICE, AVG_PRICE, TTL_TRD_QNTY, TURNOVER_LACS,
  // NO_OF_TRADES, DELIV_QTY, DELIV_PER
  const header = lines[0]!.split(",").map((h) => h.trim().toUpperCase());
  const iSymbol = header.indexOf("SYMBOL");
  const iSeries = header.indexOf("SERIES");
  const iTurnover = header.indexOf("TURNOVER_LACS");
  const iDelivPer = header.indexOf("DELIV_PER");
  if (iSymbol < 0 || iSeries < 0 || iDelivPer < 0) return null;

  const map = new Map<string, DeliveryData>();
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i]!.split(",").map((c) => c.trim());
    if (cols.length <= iDelivPer) continue;
    if ((cols[iSeries] ?? "").toUpperCase() !== "EQ") continue;
    const deliveryPct = parseFloat(cols[iDelivPer] ?? "");
    if (!Number.isFinite(deliveryPct)) continue; // "-" for non-delivery rows
    const turnover = parseFloat(cols[iTurnover] ?? "");
    map.set(cols[iSymbol]!.toUpperCase(), {
      deliveryPct,
      turnover: Number.isFinite(turnover) ? turnover : 0,
      date: istDateStr,
    });
  }
  return map.size > 0 ? map : null;
}

/**
 * Delivery data for the last completed trading day. Walks back up to 5 days to
 * skip holidays. Returns last-known cache (possibly empty) on total failure.
 */
export async function getDeliveryData(): Promise<Map<string, DeliveryData>> {
  const targetDate = getLastCompletedTradingDayStr();
  if (deliveryCacheDate === targetDate && deliveryCache.size > 0) return deliveryCache;
  if (deliveryFetchInFlight) return deliveryFetchInFlight;

  deliveryFetchInFlight = (async () => {
    let date = targetDate;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const map = await fetchDeliveryCSV(date);
        if (map) {
          deliveryCache = map;
          deliveryCacheDate = targetDate;
          logger.info({ symbols: map.size, date }, "NSE delivery data refreshed");
          return map;
        }
      } catch (err) {
        logger.debug({ date, err: (err as Error).message }, "Bhavcopy not available for date, walking back");
      }
      date = shiftISTDateStr(date, -1);
    }
    logger.warn({ targetDate }, "NSE delivery data unavailable — using last-known cache");
    return deliveryCache;
  })().finally(() => {
    deliveryFetchInFlight = null;
  });

  return deliveryFetchInFlight;
}

export function getDeliveryPct(symbol: string): number | null {
  return deliveryCache.get(symbol.toUpperCase())?.deliveryPct ?? null;
}

// ── 2. F&O ban list ───────────────────────────────────────────────────────────

let banListCache: Set<string> = new Set();
let banListCacheDate = "";

/**
 * Symbols in the F&O ban period today. Hard-reject: these stocks are at
 * open-interest limits and move erratically. Empty set on failure (fail-open:
 * a missing ban list should not halt all suggestion generation).
 */
export async function getFnOBanList(): Promise<Set<string>> {
  const today = getISTDateStr();
  if (banListCacheDate === today) return banListCache;

  try {
    // The old /api/reportSecBanApi JSON endpoint is dead (404). NSE now publishes
    // the daily ban list as a plain CSV on nsearchives (no cookies needed):
    //   "Securities in Ban For Trade Date DD-MON-YYYY:\n1,SYMBOL\n2,SYMBOL\n..."
    const resp = await axios.get<string>(NSE_FNO_BAN_CSV, {
      headers: { ...BROWSER_HEADERS, Accept: "text/csv,text/plain,*/*" },
      timeout: 10_000,
      responseType: "text",
      validateStatus: (s) => s === 200,
    });

    const set = new Set<string>();
    for (const line of resp.data.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || /ban for trade date/i.test(trimmed)) continue;
      // Rows look like "1,KAYNES" — take the token after the leading index.
      const parts = trimmed.split(",");
      const sym = (parts.length > 1 ? parts[1] : parts[0])?.trim().toUpperCase();
      if (sym && /^[A-Z&-]+$/.test(sym)) set.add(sym);
    }

    banListCache = set;
    banListCacheDate = today;
    logger.info({ count: set.size }, "F&O ban list refreshed");
    return set;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "F&O ban list fetch failed — using last-known list");
    return banListCache;
  }
}

export function isSymbolBanned(symbol: string): boolean {
  return banListCache.has(symbol.toUpperCase());
}

// ── 3. Bulk deals ─────────────────────────────────────────────────────────────

export interface BulkDealSignal {
  netBuyQty: number;     // buy qty minus sell qty across bulk deals (last 7 days)
  dealCount: number;
  lastDealDate: string;
}

let bulkDealsCache: Map<string, BulkDealSignal> = new Map();
let bulkDealsCacheTime = 0;
const BULK_DEALS_TTL_MS = 6 * 60 * 60 * 1000;

interface BulkDealRow {
  BD_SYMBOL?: string;
  BD_BUY_SELL?: string;
  BD_QTY_TRD?: string | number;
  BD_DT_DATE?: string;
  // historical/alternate keys
  symbol?: string;
  buySell?: string;
  qty?: string | number;
  date?: string;
}

/**
 * Net bulk-deal flow per symbol over the last 7 days. Institutional bulk BUYs
 * confirm momentum; bulk SELLs into strength are distribution.
 */
export async function getBulkDeals(): Promise<Map<string, BulkDealSignal>> {
  if (Date.now() - bulkDealsCacheTime < BULK_DEALS_TTL_MS && bulkDealsCache.size > 0) {
    return bulkDealsCache;
  }

  try {
    const cookies = await getNSECookies();
    const to = getISTDateStr();
    const from = shiftISTDateStr(to, -7);
    const fmt = (s: string) => {
      const [y, m, d] = s.split("-");
      return `${d}-${m}-${y}`;
    };
    const resp = await axios.get(
      `${NSE_BASE}/api/historicalOR/bulk-block-short-deals?optionType=bulk_deals&from=${fmt(from)}&to=${fmt(to)}`,
      { headers: nseApiHeaders(cookies), timeout: 15_000 },
    );

    const rows: BulkDealRow[] = resp.data?.data ?? [];
    const map = new Map<string, BulkDealSignal>();
    for (const row of rows) {
      const symbol = (row.BD_SYMBOL ?? row.symbol ?? "").toUpperCase().trim();
      if (!symbol) continue;
      const side = (row.BD_BUY_SELL ?? row.buySell ?? "").toUpperCase();
      const qty = Number(String(row.BD_QTY_TRD ?? row.qty ?? "0").replace(/,/g, "")) || 0;
      const date = row.BD_DT_DATE ?? row.date ?? "";
      const existing = map.get(symbol) ?? { netBuyQty: 0, dealCount: 0, lastDealDate: "" };
      existing.netBuyQty += side.startsWith("B") ? qty : side.startsWith("S") ? -qty : 0;
      existing.dealCount += 1;
      if (date > existing.lastDealDate) existing.lastDealDate = date;
      map.set(symbol, existing);
    }

    bulkDealsCache = map;
    bulkDealsCacheTime = Date.now();
    logger.info({ symbols: map.size, from, to }, "NSE bulk deals refreshed");
    return map;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "Bulk deals fetch failed — using last-known cache");
    return bulkDealsCache;
  }
}

export function getBulkDealSignal(symbol: string): BulkDealSignal | null {
  return bulkDealsCache.get(symbol.toUpperCase()) ?? null;
}

/** Refresh all NSE free-data feeds. Called from the scheduler. */
export async function refreshNSEFreeData(): Promise<void> {
  await Promise.allSettled([getDeliveryData(), getFnOBanList(), getBulkDeals()]);
}
