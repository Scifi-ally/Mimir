/**
 * Overnight Gap Risk & Economic Event Calendar
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. Gap risk: GIFT Nifty (Yahoo "GIFTNIFTY" proxies), S&P 500 futures (ES=F)
 *    and USDINR overnight change predict the NSE opening gap. Swing entries and
 *    pre-open intraday generation consult this before committing.
 * 2. Economic calendar: static, code-reviewed list of scheduled binary events
 *    (RBI policy, Fed, CPI, Budget). On event days `eventRiskActive` semantics
 *    apply: position sizing halves via the existing risk-engine hook.
 *
 * The calendar is intentionally a checked-in JSON — free, deterministic,
 * auditable — updated as dates are announced. No scraping fragility.
 */

import { logger } from "../lib/logger";
import { getISTDateStr } from "../lib/ist-time";

// ── Economic event calendar ───────────────────────────────────────────────────
// IST dates of scheduled high-impact events. Update as RBI/Fed/CPI schedules
// publish. Format: YYYY-MM-DD → label.
const ECONOMIC_EVENTS: Record<string, string> = {
  // RBI MPC decisions (2026 schedule)
  "2026-02-06": "RBI MPC decision",
  "2026-04-09": "RBI MPC decision",
  "2026-06-05": "RBI MPC decision",
  "2026-08-06": "RBI MPC decision",
  "2026-10-01": "RBI MPC decision",
  "2026-12-04": "RBI MPC decision",
  // FOMC decisions (second day, IST morning after — the gap lands on this date)
  "2026-01-29": "FOMC decision (overnight)",
  "2026-03-19": "FOMC decision (overnight)",
  "2026-04-30": "FOMC decision (overnight)",
  "2026-06-18": "FOMC decision (overnight)",
  "2026-07-30": "FOMC decision (overnight)",
  "2026-09-17": "FOMC decision (overnight)",
  "2026-10-29": "FOMC decision (overnight)",
  "2026-12-10": "FOMC decision (overnight)",
  // India CPI releases (~12th of each month, 17:30 IST — affects next day too)
  "2026-07-13": "India CPI release",
  "2026-08-12": "India CPI release",
  "2026-09-14": "India CPI release",
  "2026-10-12": "India CPI release",
  "2026-11-12": "India CPI release",
  "2026-12-14": "India CPI release",
};

export function getTodayEconomicEvent(): string | null {
  return ECONOMIC_EVENTS[getISTDateStr()] ?? null;
}

export function isEconomicEventDay(): boolean {
  return getTodayEconomicEvent() !== null;
}

// ── Overnight gap risk ────────────────────────────────────────────────────────

export interface GapRiskSnapshot {
  spxFuturesChangePct: number | null;   // ES=F change since previous close
  usdInrChangePct: number | null;       // INR=X change (positive = INR weakening)
  giftNiftyChangePct: number | null;    // GIFT Nifty vs previous Nifty close, if resolvable
  impliedGapPct: number | null;         // best available opening-gap estimate
  riskLevel: "LOW" | "MODERATE" | "HIGH" | "UNKNOWN";
  fetchedAt: string;
}

let gapCache: GapRiskSnapshot | null = null;
let gapCacheTime = 0;
const GAP_CACHE_TTL_MS = 15 * 60 * 1000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let yahooFinance: any = null;
let yahooLoadAttempted = false;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getYahooFinance(): Promise<any> {
  if (yahooLoadAttempted) return yahooFinance;
  yahooLoadAttempted = true;
  try {
    const yfModule = await import("yahoo-finance2");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Ctor = (yfModule.default ?? yfModule) as any;
    yahooFinance = new Ctor({ suppressNotices: ["yahooSurvey"] });
  } catch {
    logger.warn("yahoo-finance2 not installed — gap risk unavailable");
    yahooFinance = null;
  }
  return yahooFinance;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function changePct(quote: any): number | null {
  const price = quote?.regularMarketPrice;
  const prev = quote?.regularMarketPreviousClose;
  if (typeof price === "number" && typeof prev === "number" && prev > 0) {
    return ((price - prev) / prev) * 100;
  }
  return null;
}

export async function fetchGapRisk(): Promise<GapRiskSnapshot> {
  if (gapCache && Date.now() - gapCacheTime < GAP_CACHE_TTL_MS) return gapCache;

  const snapshot: GapRiskSnapshot = {
    spxFuturesChangePct: null,
    usdInrChangePct: null,
    giftNiftyChangePct: null,
    impliedGapPct: null,
    riskLevel: "UNKNOWN",
    fetchedAt: new Date().toISOString(),
  };

  try {
    const yf = await getYahooFinance();
    if (yf) {
      const [es, inr] = await Promise.all([
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        yf.quote("ES=F").catch(() => null) as Promise<any>,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        yf.quote("INR=X").catch(() => null) as Promise<any>,
      ]);

      snapshot.spxFuturesChangePct = changePct(es);
      snapshot.usdInrChangePct = changePct(inr);
      // GIFT Nifty is not reliably available on free feeds. ^NSEI pre-open
      // "change" is yesterday's session move, not overnight sentiment — using
      // it here previously mislabeled stale data as an implied gap.
      snapshot.giftNiftyChangePct = null;

      // Implied gap: scale ES=F overnight move by Nifty's beta to S&P (~0.6).
      if (snapshot.spxFuturesChangePct !== null) {
        snapshot.impliedGapPct = snapshot.spxFuturesChangePct * 0.6;
      }

      const absGap = snapshot.impliedGapPct !== null ? Math.abs(snapshot.impliedGapPct) : null;
      const inrShock = snapshot.usdInrChangePct !== null && Math.abs(snapshot.usdInrChangePct) > 0.5;
      if (absGap === null) {
        snapshot.riskLevel = "UNKNOWN";
      } else if (absGap > 1.0 || inrShock) {
        snapshot.riskLevel = "HIGH";
      } else if (absGap > 0.5) {
        snapshot.riskLevel = "MODERATE";
      } else {
        snapshot.riskLevel = "LOW";
      }
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "Gap risk fetch failed");
  }

  gapCache = snapshot;
  gapCacheTime = Date.now();
  logger.info(
    {
      impliedGapPct: snapshot.impliedGapPct,
      riskLevel: snapshot.riskLevel,
      es: snapshot.spxFuturesChangePct,
      inr: snapshot.usdInrChangePct,
    },
    "Overnight gap risk updated",
  );
  return snapshot;
}

export function getGapRisk(): GapRiskSnapshot | null {
  return gapCache;
}
