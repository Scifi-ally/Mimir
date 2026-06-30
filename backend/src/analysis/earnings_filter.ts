/**
 * Earnings Evasion Filter
 * ─────────────────────────────────────────────────────────────────────────────
 * Checks if a stock has an earnings report within a configurable window.
 * Uses yahoo-finance2 to fetch earnings dates ONLY for final signal candidates
 * (typically 5-15 stocks) to stay well within rate limits.
 *
 * Integration: Called from signal_generator.ts after all other gates pass,
 * right before a signal is emitted.
 */

import { logger } from "../lib/logger";

// ── In-memory cache to avoid re-fetching the same symbol within a session ────

interface EarningsCache {
  earningsDate: Date | null;
  fetchedAt: number;
}

const earningsCache = new Map<string, EarningsCache>();
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

// ── Yahoo Finance 2 lazy import ──────────────────────────────────────────────
// We lazy-import yahoo-finance2 so the module doesn't crash if the package
// is missing — it gracefully degrades to "no earnings data available".

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let yahooFinance: any = null;
let yahooLoadAttempted = false;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getYahooFinance(): Promise<any> {
  if (yahooLoadAttempted) return yahooFinance;
  yahooLoadAttempted = true;
  try {
    yahooFinance = await import("yahoo-finance2");
    // yahoo-finance2 exports default in ESM
    if (yahooFinance.default) yahooFinance = yahooFinance.default;
    logger.info("yahoo-finance2 loaded successfully for earnings evasion");
  } catch {
    logger.warn(
      "yahoo-finance2 not installed — earnings evasion filter disabled. Run: npm install yahoo-finance2",
    );
    yahooFinance = null;
  }
  return yahooFinance;
}

// ── Fetch earnings date for a single symbol ──────────────────────────────────

export async function getNextEarningsDate(
  symbol: string,
): Promise<Date | null> {
  // Check cache first
  const cached = earningsCache.get(symbol);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.earningsDate;
  }

  const yf = await getYahooFinance();
  if (!yf) return null;

  try {
    // Convert NSE symbol to Yahoo format (e.g., "RELIANCE" → "RELIANCE.NS")
    const yahooSymbol = symbol.includes(".") ? symbol : `${symbol}.NS`;

    const result = await yf.quoteSummary(yahooSymbol, {
      modules: ["calendarEvents"],
    });

    const earningsDateRaw =
      result?.calendarEvents?.earnings?.earningsDate?.[0];

    let earningsDate: Date | null = null;
    if (earningsDateRaw) {
      earningsDate =
        earningsDateRaw instanceof Date
          ? earningsDateRaw
          : new Date(earningsDateRaw);

      // Validate the date is real
      if (isNaN(earningsDate.getTime())) {
        earningsDate = null;
      }
    }

    earningsCache.set(symbol, { earningsDate, fetchedAt: Date.now() });

    if (earningsDate) {
      logger.debug(
        { symbol, earningsDate: earningsDate.toISOString() },
        "Fetched next earnings date",
      );
    }

    return earningsDate;
  } catch (err) {
    logger.debug(
      {
        symbol,
        error: err instanceof Error ? err.message : String(err),
      },
      "Failed to fetch earnings date — skipping earnings check for this symbol",
    );

    // Cache the failure so we don't retry immediately
    earningsCache.set(symbol, { earningsDate: null, fetchedAt: Date.now() });
    return null;
  }
}

// ── Main filter function ─────────────────────────────────────────────────────

export interface EarningsCheckResult {
  hasUpcomingEarnings: boolean;
  earningsDate: Date | null;
  daysUntilEarnings: number | null;
  riskLevel: "NONE" | "CAUTION" | "HIGH_RISK";
}

export async function checkEarningsRisk(
  symbol: string,
  windowDays = 3,
): Promise<EarningsCheckResult> {
  const earningsDate = await getNextEarningsDate(symbol);

  if (!earningsDate) {
    return {
      hasUpcomingEarnings: false,
      earningsDate: null,
      daysUntilEarnings: null,
      riskLevel: "NONE",
    };
  }

  const now = new Date();
  const diffMs = earningsDate.getTime() - now.getTime();
  const daysUntil = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

  if (daysUntil <= 0) {
    // Earnings already passed — no risk
    return {
      hasUpcomingEarnings: false,
      earningsDate,
      daysUntilEarnings: daysUntil,
      riskLevel: "NONE",
    };
  }

  if (daysUntil <= windowDays) {
    return {
      hasUpcomingEarnings: true,
      earningsDate,
      daysUntilEarnings: daysUntil,
      riskLevel: "HIGH_RISK",
    };
  }

  if (daysUntil <= windowDays * 2) {
    return {
      hasUpcomingEarnings: true,
      earningsDate,
      daysUntilEarnings: daysUntil,
      riskLevel: "CAUTION",
    };
  }

  return {
    hasUpcomingEarnings: false,
    earningsDate,
    daysUntilEarnings: daysUntil,
    riskLevel: "NONE",
  };
}
