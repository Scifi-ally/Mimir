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
let lastFailedAt = 0;
const FAILURE_COOLDOWN_MS = 60 * 1000; // don't hammer NSE after a failure

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
    logger.warn({ err: (err as Error).message }, "NSE cookie fetch failed in option_chain");
    return "";
  }
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
      lastFailedAt = Date.now();
      return null;
    }

    const spotPrice = data.records.underlyingValue;
    // Reject rather than cache garbage: undefined/NaN/zero spot would poison
    // the snapshot for the full 15-min TTL.
    if (!Number.isFinite(spotPrice) || spotPrice <= 0) {
      logger.warn({ spotPrice }, "Option Chain: invalid underlyingValue — rejecting snapshot");
      lastFailedAt = Date.now();
      return null;
    }
    const totalCE_OI = data.filtered?.CE?.totOI;
    const totalPE_OI = data.filtered?.PE?.totOI;
    // Reject rather than fabricate: `|| 1` here previously turned missing CE OI
    // into PCR = PE_OI/1, wildly overstating put pressure into regime logic.
    if (!totalCE_OI || !totalPE_OI || totalCE_OI <= 0) {
      logger.warn({ totalCE_OI, totalPE_OI }, "Option Chain: OI totals missing/zero — rejecting snapshot");
      lastFailedAt = Date.now();
      return null;
    }
    const pcr = totalPE_OI / totalCE_OI;

    const expiries = data.records.expiryDates;
    const currentExpiry = expiries[0];
    
    let maxPainStrike = spotPrice;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const currentExpiryData = data.records.data.filter((d: any) => d.expiryDate === currentExpiry);
    // Real max pain: strike minimizing total option-writer payout
    // Σ [callOI·max(0, K − strike_i) + putOI·max(0, strike_i − K)] over all rows.
    let lowestPain = Infinity;
    for (const candidate of currentExpiryData) {
      const k = candidate.strikePrice;
      let pain = 0;
      for (const row of currentExpiryData) {
        const ceOI = row.CE ? row.CE.openInterest : 0;
        const peOI = row.PE ? row.PE.openInterest : 0;
        pain += ceOI * Math.max(0, k - row.strikePrice) + peOI * Math.max(0, row.strikePrice - k);
      }
      if (pain < lowestPain) {
        lowestPain = pain;
        maxPainStrike = k;
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

  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const status = (err as Record<string, Record<string, unknown>>)?.response?.status;
    logger.warn({ error: errorMsg, status }, "Option Chain fetch failed — no data available");
    lastFailedAt = Date.now();
    // Return null, never fabricated PCR/max-pain: these feed the UI and regime logic.
    return null;
  } finally {
    isFetching = false;
  }
}

export async function fetchOptionChainData(): Promise<OptionChainSnapshot | null> {
  if (cache && Date.now() - cache.fetchedAt.getTime() < CACHE_TTL_MS) {
    return cache;
  }

  // Recently failed — don't hammer NSE; serve whatever we have (possibly null).
  if (Date.now() - lastFailedAt < FAILURE_COOLDOWN_MS) {
    return cache;
  }

  if (!cache) {
    return await doFetchOptionChain();
  }
  
  // Background fetch if stale
  doFetchOptionChain().catch(err => logger.error({ error: err?.message || String(err) }, "Option chain background fetch failed"));
  return cache;
}
