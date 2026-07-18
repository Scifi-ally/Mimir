/**
 * FII / DII Daily Flow Fetcher
 * ─────────────────────────────────────────────────────────────────────────────
 * Fetches Foreign Institutional Investor (FII) and Domestic Institutional
 * Investor (DII) net equity buying/selling data from the NSE website.
 */

import axios from "axios";
import { desc } from "drizzle-orm";
import { logger } from "../lib/logger";
import { db } from "../../db/src";
import { institutionalFlowsTable } from "../../db/src/schema/institutional_flows";
import { resetDivergenceCache } from "../analysis/divergence_engine";
import { getISTDateStr } from "../lib/ist-time";

const NSE_HOME_URL = "https://www.nseindia.com/";
const NSE_WARMUP_URL = "https://www.nseindia.com/reports-indices-historical-index-data";
const NSE_FIIDII_URL = "https://www.nseindia.com/api/fiidiiTradeReact";
const NSE_REFERER = "https://www.nseindia.com/reports-indices-historical-index-data";

// NSE returns 403 to bare requests. It fingerprints on a full Chrome header set
// (sec-ch-ua / Sec-Fetch-*) AND requires warmed cookies from a real page visit.
// These headers replicate a genuine Chrome 124 navigation → API-fetch sequence.
const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
};

export interface FIIDIISnapshot {
  fiiNetInr: number;
  diiNetInr: number;
  fetchedAt: Date;
}

let cache: FIIDIISnapshot | null = null;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
let isFetching = false;

async function doFetchFIIDIIData(): Promise<FIIDIISnapshot | null> {
  if (isFetching && cache) return cache;
  isFetching = true;

  try {
    // 1. Warm cookies. NSE only issues the full cookie set (needed by the API)
    // after a navigation to a real content page — the bare homepage is not
    // always enough, so we hit the homepage then a reports page, accumulating
    // Set-Cookie from both. Sending the wrong/partial cookie set → 403.
    const jar = new Map<string, string>();
    const collectCookies = (resp: { headers: Record<string, unknown> }) => {
      const setCookie = resp.headers["set-cookie"] as string[] | undefined;
      if (setCookie) {
        for (const c of setCookie) {
          const [pair] = c.split(";");
          const eq = pair.indexOf("=");
          if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
        }
      }
    };

    const homeResp = await axios.get(NSE_HOME_URL, { headers: BROWSER_HEADERS, timeout: 10_000 });
    collectCookies(homeResp);
    try {
      const warmResp = await axios.get(NSE_WARMUP_URL, {
        headers: { ...BROWSER_HEADERS, Referer: NSE_HOME_URL },
        timeout: 10_000,
      });
      collectCookies(warmResp);
    } catch {
      // Warmup page is best-effort; homepage cookies alone sometimes suffice.
    }

    const cookieHeader = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");

    // 2. Fetch FII/DII data as an XHR from the reports page (Referer + XHR
    // marker are part of the fingerprint NSE checks).
    const apiHeaders = {
      ...BROWSER_HEADERS,
      "Accept": "application/json, text/plain, */*",
      "Referer": NSE_REFERER,
      "X-Requested-With": "XMLHttpRequest",
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Dest": "empty",
      "Cookie": cookieHeader,
    };

    const resp = await axios.get(NSE_FIIDII_URL, {
      headers: apiHeaders,
      timeout: 10_000,
    });

    const data = resp.data;
    if (!Array.isArray(data)) {
      throw new Error("Unexpected response format from NSE API");
    }

    let fiiNet = 0;
    let diiNet = 0;

    for (const item of data) {
      if (item.category === "FII/FPI") {
        fiiNet = parseFloat(item.netValue || "0");
      } else if (item.category === "DII") {
        diiNet = parseFloat(item.netValue || "0");
      }
    }

    if (Number.isNaN(fiiNet) || Number.isNaN(diiNet)) {
      throw new Error("Parse failed on net values");
    }

    // IST trading date, not UTC — at 02:00 UTC the IST day has already rolled,
    // and a UTC key would upsert under the previous day's row.
    const todayStr = getISTDateStr();
    try {
      await db.insert(institutionalFlowsTable)
        .values({
          date: todayStr,
          fiiNet,
          diiNet,
          fiiIndexFuturesNet: 0,
          fiiStockFuturesNet: 0,
        })
        .onConflictDoUpdate({
          target: institutionalFlowsTable.date,
          set: { fiiNet, diiNet, fiiIndexFuturesNet: 0, fiiStockFuturesNet: 0 }
        });
    } catch (dbErr) {
      logger.error({ err: dbErr }, "Failed to save FII/DII flows to DB");
    }

    cache = { fiiNetInr: fiiNet, diiNetInr: diiNet, fetchedAt: new Date() };
    resetDivergenceCache();
    return cache;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "FII/DII live fetch failed, checking database or fallback");
    
    try {
      const dbRow = await db.select().from(institutionalFlowsTable).orderBy(desc(institutionalFlowsTable.date)).limit(1);
      if (dbRow && dbRow.length > 0 && typeof dbRow[0].fiiNet === "number" && typeof dbRow[0].diiNet === "number") {
        cache = {
          fiiNetInr: dbRow[0].fiiNet,
          diiNetInr: dbRow[0].diiNet,
          fetchedAt: new Date(),
        };
        resetDivergenceCache();
        return cache;
      }
    } catch (dbErr) {
      logger.error({ err: dbErr }, "FII/DII database fallback failed");
    }

    // No live data and no DB history — return null so callers/UI show N/A.
    // Never fabricate flows: fake numbers feed regime detection and scoring.
    return null;
  } finally {
    isFetching = false;
  }
}

export async function fetchFIIDIIData(): Promise<FIIDIISnapshot | null> {
  if (cache && Date.now() - cache.fetchedAt.getTime() < CACHE_TTL_MS) {
    return cache;
  }
  
  if (!cache) {
    return await doFetchFIIDIIData();
  }
  
  // Background fetch if stale
  doFetchFIIDIIData().catch(err => logger.error({ err }, "FII/DII background fetch failed"));
  return cache;
}
