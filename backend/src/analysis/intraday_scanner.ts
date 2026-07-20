/**
 * Intraday Scanner
 * ─────────────────────────────────────────────────────────────────────────────
 * Continuous market analysis using 1h and 4h timeframes during trading hours
 * Captures all setups as they develop intraday, not just pre-market watches
 */

import { logger } from "../lib/logger";
import { NSE_UNIVERSE } from "./stock_scanner";
import { analyzeMultiTimeframe } from "./multi_timeframe";
import { getISTDateStr } from "../lib/ist-time";
import { db } from "../../db/src";
import { overnightWatchlistTable } from "../../db/src";
import { eq } from "drizzle-orm";

export interface IntradayCandidate {
  symbol: string;
  name: string;
  direction: "BUY" | "SELL";
  confluenceScore: number;
  dailyTrend: string;
  hourlyTrend: string;
  reason: string;
  timestamp: Date;
}

/**
 * Run intraday analysis to find fresh setups developing during market hours
 * Focuses on hourly and 4-hour timeframe confluence for quick trades
 */
export async function runIntradayAnalysis(): Promise<IntradayCandidate[]> {
  logger.info(
    { universe: NSE_UNIVERSE.length },
    "Intraday analysis: scanning for developing setups on 1h/4h timeframes",
  );

  const candidates: IntradayCandidate[] = [];

  // Scan the full tracked universe, not just the most obvious names.
  // This is how we surface quieter / hidden setups while the market is live.
  const stocks = NSE_UNIVERSE;
  const batchSize = 8;

  for (let i = 0; i < stocks.length; i += batchSize) {
    const chunk = stocks.slice(i, i + batchSize);

    const chunkResults = await Promise.all(
      chunk.map(async (stock) => {
        try {
          const mtf = await analyzeMultiTimeframe(stock.key);
          const signal = mtf.signal;

          // Intraday-focused filter: require 1h or 4h to have clear signal
          if (!signal.hourlyConfirm || signal.direction === "NEUTRAL")
            return null;

          // Keep only exceptionally strong live setups so the output stays streamlined (<20 stocks).
          if (signal.confluenceScore < 75) return null;
          
          const isFresh = signal.crossover1h || signal.crossover4h;
          // If it's just an ongoing trend without a fresh crossover, it must be extremely strong
          if (!isFresh && signal.confluenceScore < 85) return null;

          const reason = `${signal.dailyTrend} daily/${signal.hourlyConfirm ? "confirmed" : "neutral"} hourly | Confluence: ${signal.confluenceScore}% | ${
            signal.crossover1h
              ? "1h crossover"
              : signal.crossover4h
                ? "4h crossover"
                : "EMA alignment"
          }`;

          return {
            symbol: stock.symbol,
            name: stock.name,
            direction: signal.direction,
            confluenceScore: signal.confluenceScore,
            dailyTrend: signal.dailyTrend,
            hourlyTrend: signal.hourlyConfirm ? "CONFIRMED" : "NEUTRAL",
            reason,
            timestamp: new Date(),
          } satisfies IntradayCandidate;
        } catch (err) {
          logger.debug(
            { err, symbol: stock.symbol },
            "Intraday analysis failed for stock",
          );
          return null;
        }
      }),
    );

    for (const result of chunkResults) {
      if (result) candidates.push(result);
    }

    if (i + batchSize < stocks.length) {
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  const ranked = candidates
    .sort((a, b) => {
      if (b.confluenceScore !== a.confluenceScore)
        return b.confluenceScore - a.confluenceScore;
      return a.symbol.localeCompare(b.symbol);
    })
    .slice(0, 20);

  logger.info(
    {
      scanned: stocks.length,
      found: ranked.length,
      timestamp: new Date().toISOString(),
      top: ranked.slice(0, 5).map((c) => `${c.symbol}:${c.confluenceScore}`),
    },
    "Intraday scan complete",
  );
  return ranked;
}

/**
 * Update the overnight watchlist with intraday-developed opportunities
 * Enriches the watchlist with stocks showing strong hourly/4h signals
 */
export async function enrichWatchlistWithIntradayOpportunities(): Promise<void> {
  const todayIST = getISTDateStr();
  const intradayOps = await runIntradayAnalysis();

  if (!intradayOps.length) {
    logger.info("No new intraday opportunities found");
    return;
  }

  logger.info(
    { count: intradayOps.length, date: todayIST },
    "Enriching watchlist with intraday signals",
  );

  // Add intraday candidates to watchlist without removing existing ones
  const existing = await db
    .select()
    .from(overnightWatchlistTable)
    .where(eq(overnightWatchlistTable.forDate, todayIST));

  const existingSymbols = new Set(existing.map((e) => e.symbol));

  const newCandidates = intradayOps
    .filter((c) => !existingSymbols.has(c.symbol))
    .slice(0, 12) // Limit to keep the watchlist focused even though we scan the full universe
    .map((c) => {
      const rawCondition = `[${c.confluenceScore}% MTF] ${c.reason}`;
      let condition = rawCondition.replace(/₹/g, 'Rs.').replace(/…/g, '...');
      condition = condition.replace(/[^\x20-\x7E]/g, '');
      const maxLength = 250;
      if (condition.length > maxLength && !(condition.startsWith('{') && condition.endsWith('}'))) {
        condition = `${condition.slice(0, maxLength - 3).trimEnd()}...`;
      }
      return {
        forDate: todayIST,
        symbol: c.symbol,
        name: c.name ? c.name.substring(0, 95) : "",
        category: c.direction === "BUY" ? "INTRADAY_BUY" : "INTRADAY_SELL",
        condition,
        priority: c.confluenceScore > 75 ? 10 : c.confluenceScore > 60 ? 8 : 6,
      };
    });

  if (!newCandidates.length) {
    logger.info("All intraday opportunities already in watchlist");
    return;
  }

  await db.insert(overnightWatchlistTable).values(newCandidates);

  logger.info(
    {
      added: newCandidates.length,
      totalNow: existing.length + newCandidates.length,
      date: todayIST,
    },
    "Watchlist enriched with intraday signals",
  );
}

// ── IST helper ────────────────────────────────────────────────────────────────
