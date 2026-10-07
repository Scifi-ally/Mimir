import { Router } from "express";
import { db } from "../../db/src";
import { paperPositionsTable, paperAccountsTable } from "../../db/src/schema/paper_trading";
import { asc } from "drizzle-orm";
import { yahooFinance } from "../lib/yahoo-client";

const router = Router();

router.get("/oos", async (_req, res) => {
  try {
    const [account] = await db.select().from(paperAccountsTable).limit(1);
    if (!account) {
      res.json({ strategyReturnPct: null, benchmarkReturnPct: null, alphaPct: null, available: false, reason: "paper_account_missing" });
      return;
    }

    const positions = await db.select().from(paperPositionsTable).orderBy(asc(paperPositionsTable.createdAt));

    if (positions.length === 0) {
      res.json({ strategyReturnPct: null, benchmarkReturnPct: null, alphaPct: null, available: false, reason: "no_recorded_trades" });
      return;
    }

    const firstTradeDate = positions[0].createdAt;
    const startingBalance = Number(account.startingBalance);
    const currentBalance = Number(account.balance);
    // Balance records realized equity. Open positions need fresh independent marks,
    // which this ledger does not retain with observation timestamps.
    const hasOpenPositions = positions.some(p => p.status === "OPEN");
    const strategyReturnPct = !hasOpenPositions && Number.isFinite(startingBalance) && startingBalance > 0
      && Number.isFinite(currentBalance) ? ((currentBalance - startingBalance) / startingBalance) * 100 : null;

    let benchmarkReturnPct: number | null = null;
    try {
      const historicalData = await yahooFinance.historical("^NSEI", {
        period1: firstTradeDate,
        period2: new Date(),
        interval: "1d"
      }) as Array<{ close: number }>;
      if (historicalData.length >= 2) {
        const startPrice = historicalData[0].close;
        const endPrice = historicalData[historicalData.length - 1].close;
        if (Number.isFinite(startPrice) && Number.isFinite(endPrice) && startPrice > 0 && endPrice > 0) {
          benchmarkReturnPct = ((endPrice - startPrice) / startPrice) * 100;
        }
      }
    } catch (err) {
      console.warn("Failed to fetch Nifty50 historical data for benchmark:", err);
    }

    res.json({
      strategyReturnPct,
      benchmarkReturnPct,
      alphaPct: null, // A return difference is not estimated factor-adjusted alpha.
      benchmarkDifferencePct: strategyReturnPct !== null && benchmarkReturnPct !== null ? strategyReturnPct - benchmarkReturnPct : null,
      available: strategyReturnPct !== null && benchmarkReturnPct !== null,
      reason: hasOpenPositions ? "open_position_marks_unverified" : benchmarkReturnPct === null ? "benchmark_unavailable" : null,
      evidenceKind: "recorded_paper_trades",
      benchmarkKind: "nifty_price_index_excludes_dividends",
      firstTradeDate
    });
  } catch {
    res.status(500).json({ error: "Failed to fetch benchmark" });
  }
});

export const benchmarkRouter = router;
