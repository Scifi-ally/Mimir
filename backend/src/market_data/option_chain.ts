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
let cacheLoadedAt = 0;
const FAILURE_COOLDOWN_MS = 60 * 1000; // don't hammer NSE after a failure

export function parseOptionChainSourceTimestamp(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  const iso = Date.parse(raw);
  if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) {
    return Number.isFinite(iso) ? new Date(iso) : null;
  }
  const match = /^(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(raw);
  if (!match) return null;
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const month = months.indexOf(match[2]!.toLowerCase());
  const day = Number(match[1]);
  const year = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 0 || hour > 23 || minute > 59 || second > 59) return null;
  const check = new Date(Date.UTC(year, month, day, hour, minute, second));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month || check.getUTCDate() !== day) return null;
  return new Date(`${year.toString().padStart(4, "0")}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}+05:30`);
}

function isFreshSourceTimestamp(timestamp: Date | null, now = Date.now()): boolean {
  if (!timestamp || !Number.isFinite(timestamp.getTime())) return false;
  const ageMs = now - timestamp.getTime();
  return ageMs >= -5_000 && ageMs <= CACHE_TTL_MS;
}

function isFreshSnapshot(snapshot: OptionChainSnapshot | null, now = Date.now()): snapshot is OptionChainSnapshot {
  return Boolean(snapshot && isFreshSourceTimestamp(snapshot.fetchedAt, now));
}

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
  if (isFetching) return isFreshSnapshot(cache) ? cache : null;
  isFetching = true;
  try {
    const cookies = await getNSECookies();

    const resp = await axios.get(OPTION_CHAIN_URL, {
      headers: { ...BROWSER_HEADERS, Cookie: cookies },
      timeout: 10_000,
    });

    const data = resp.data;
    if (!data || !data.records || !Array.isArray(data.records.data)) {
      logger.warn("Option Chain: Invalid response shape");
      lastFailedAt = Date.now();
      return null;
    }

    const sourceTimestamp = parseOptionChainSourceTimestamp(data.records.timestamp);
    if (!sourceTimestamp) {
      logger.warn({ timestamp: data.records.timestamp }, "Option Chain: missing or invalid source timestamp");
      lastFailedAt = Date.now();
      return null;
    }
    if (!sourceTimestamp || !isFreshSourceTimestamp(sourceTimestamp)) {
      logger.warn({ timestamp: data.records.timestamp }, "Option Chain: missing, invalid, or stale source timestamp");
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
    const totalCE_OI = Number(data.filtered?.CE?.totOI);
    const totalPE_OI = Number(data.filtered?.PE?.totOI);
    // Reject rather than fabricate: `|| 1` here previously turned missing CE OI
    // into PCR = PE_OI/1, wildly overstating put pressure into regime logic.
    if (!Number.isFinite(totalCE_OI) || !Number.isFinite(totalPE_OI) || totalCE_OI <= 0 || totalPE_OI <= 0) {
      logger.warn({ totalCE_OI, totalPE_OI }, "Option Chain: OI totals missing/zero — rejecting snapshot");
      lastFailedAt = Date.now();
      return null;
    }
    const pcr = totalPE_OI / totalCE_OI;

    const expiries = data.records.expiryDates;
    if (!Array.isArray(expiries) || expiries.length === 0) {
      logger.warn("Option Chain: expiry list missing");
      lastFailedAt = Date.now();
      return null;
    }
    const currentExpiry = expiries[0];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const currentExpiryData = data.records.data.filter((d: any) => d.expiryDate === currentExpiry);
    if (currentExpiryData.length === 0) {
      logger.warn({ currentExpiry }, "Option Chain: no rows for nearest expiry; refusing fabricated max pain");
      lastFailedAt = Date.now();
      return null;
    }
    // Real max pain: strike minimizing total option-writer payout
    // Σ [callOI·max(0, K − strike_i) + putOI·max(0, strike_i − K)] over all rows.
    let lowestPain = Infinity;
    let maxPainStrike = 0;
    for (const candidate of currentExpiryData) {
      const k = Number(candidate.strikePrice);
      if (!Number.isFinite(k) || k <= 0) {
        lowestPain = Infinity;
        break;
      }
      let pain = 0;
      for (const row of currentExpiryData) {
        const strike = Number(row.strikePrice);
        const ceOI = row.CE ? Number(row.CE.openInterest) : 0;
        const peOI = row.PE ? Number(row.PE.openInterest) : 0;
        if (!Number.isFinite(strike) || !Number.isFinite(ceOI) || !Number.isFinite(peOI) || ceOI < 0 || peOI < 0) {
          pain = NaN;
          break;
        }
        pain += ceOI * Math.max(0, k - strike) + peOI * Math.max(0, strike - k);
      }
      if (pain < lowestPain) {
        lowestPain = pain;
        maxPainStrike = k;
      }
    }
    if (!Number.isFinite(lowestPain) || maxPainStrike <= 0) {
      logger.warn("Option Chain: max pain could not be computed from valid expiry rows");
      lastFailedAt = Date.now();
      return null;
    }

    cache = {
      pcr: parseFloat(pcr.toFixed(2)),
      maxPain: maxPainStrike,
      spotPrice,
      fetchedAt: sourceTimestamp
    };
    cacheLoadedAt = Date.now();

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
  if (cache && !isFreshSnapshot(cache)) {
    cache = null;
    cacheLoadedAt = 0;
  }
  if (cache && Date.now() - cacheLoadedAt < CACHE_TTL_MS) {
    return cache;
  }

  // Recently failed — don't hammer NSE or present an expired snapshot as current.
  if (Date.now() - lastFailedAt < FAILURE_COOLDOWN_MS) {
    return isFreshSnapshot(cache) ? cache : null;
  }

  if (!cache) {
    return await doFetchOptionChain();
  }
  
  // Background fetch if stale
  doFetchOptionChain().catch(err => logger.error({ error: err?.message || String(err) }, "Option chain background fetch failed"));
  return isFreshSnapshot(cache) ? cache : null;
}
