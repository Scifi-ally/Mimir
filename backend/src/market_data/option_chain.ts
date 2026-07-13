import axios from "axios";
import { logger } from "../lib/logger";

const NSE_BASE = "https://www.nseindia.com";
const OPTION_CHAIN_URL = `${NSE_BASE}/api/option-chain-indices?symbol=NIFTY`;

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Referer": `${NSE_BASE}/`,
  "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124"',
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-origin",
  "Connection": "keep-alive",
};

export interface OptionChainSnapshot {
  pcr: number;
  maxPain: number;
  spotPrice: number;
  fetchedAt: Date;
}

let cache: OptionChainSnapshot | null = null;
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 mins
let isFetching = false;

async function getNSECookies(): Promise<string> {
  const resp = await axios.get(NSE_BASE, {
    headers: BROWSER_HEADERS,
    timeout: 10_000,
    maxRedirects: 3,
  });
  const raw = resp.headers["set-cookie"] as string | string[] | undefined;
  if (!raw) return "";
  return Array.isArray(raw) ? raw.map(c => c.split(";")[0]).join("; ") : (raw as string).split(";")[0] ?? "";
}

async function doFetchOptionChain(): Promise<OptionChainSnapshot | null> {
  if (isFetching) return cache;
  isFetching = true;
  try {
    const cookies = await getNSECookies();

    const resp = await axios.get(OPTION_CHAIN_URL, {
      headers: { ...BROWSER_HEADERS, Cookie: cookies },
      timeout: 10_000,
    });

    const data = resp.data;
    if (!data || !data.records || !data.records.data) {
      logger.warn("Option Chain: Invalid response shape");
      return null;
    }

    const spotPrice = data.records.underlyingValue;
    const totalCE_OI = data.filtered.CE.totOI || 1; 
    const totalPE_OI = data.filtered.PE.totOI || 0;
    const pcr = totalPE_OI / totalCE_OI;

    const expiries = data.records.expiryDates;
    const currentExpiry = expiries[0];
    
    let maxPainStrike = spotPrice;
    let highestCombinedOI = 0;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const currentExpiryData = data.records.data.filter((d: any) => d.expiryDate === currentExpiry);
    for (const row of currentExpiryData) {
      const ceOI = row.CE ? row.CE.openInterest : 0;
      const peOI = row.PE ? row.PE.openInterest : 0;
      const combined = ceOI + peOI;
      if (combined > highestCombinedOI) {
        highestCombinedOI = combined;
        maxPainStrike = row.strikePrice;
      }
    }

    cache = {
      pcr: parseFloat(pcr.toFixed(2)),
      maxPain: maxPainStrike,
      spotPrice,
      fetchedAt: new Date()
    };

    logger.info({ pcr: cache.pcr, maxPain: cache.maxPain }, "Option Chain data updated");
    return cache;

  } catch (err) {
    logger.warn({ err }, "Option Chain fetch failed");
    return null;
  } finally {
    isFetching = false;
  }
}

export async function fetchOptionChainData(): Promise<OptionChainSnapshot | null> {
  if (cache && Date.now() - cache.fetchedAt.getTime() < CACHE_TTL_MS) {
    return cache;
  }
  
  // Background fetch
  doFetchOptionChain().catch(err => logger.error({ err }, "Option chain background fetch failed"));
  
  // Return stale cache or null immediately so we don't block
  return cache;
}
