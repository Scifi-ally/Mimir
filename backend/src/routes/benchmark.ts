import { Router } from "express";
import { db } from "../../db/src";
import { paperPositionsTable, paperAccountsTable } from "../../db/src/schema/paper_trading";
import { asc } from "drizzle-orm";
import yahooFinance from "yahoo-finance2";

const router = Router();

router.get("/oos", async (_req, res) => {
  try {
    const [account] = await db.select().from(paperAccountsTable).limit(1);
    if (!account) {
      res.json({ strategyReturnPct: 0, benchmarkReturnPct: 0, alphaPct: 0 });
      return;
    }

    const positions = await db.select().from(paperPositionsTable).orderBy(asc(paperPositionsTable.createdAt));

    if (positions.length === 0) {
      res.json({ strategyReturnPct: 0, benchmarkReturnPct: 0, alphaPct: 0 });
      return;
    }

    const firstTradeDate = positions[0].createdAt;
    const startingBalance = Number(account.startingBalance);
    const currentBalance = Number(account.balance);
    const strategyReturnPct = ((currentBalance - startingBalance) / startingBalance) * 100;

    let benchmarkReturnPct = 0;
    try {
      const historicalData = await yahooFinance.historical("^NSEI", {
        period1: firstTradeDate,
        period2: new Date(),
        interval: "1d"
      }) as any[];
      if (historicalData.length >= 2) {
        const startPrice = historicalData[0].close;
        const endPrice = historicalData[historicalData.length - 1].close;
        if (startPrice && endPrice) {
          benchmarkReturnPct = ((endPrice - startPrice) / startPrice) * 100;
        }
      }
    } catch (err) {
      console.warn("Failed to fetch Nifty50 historical data for benchmark:", err);
    }

    res.json({
      strategyReturnPct,
      benchmarkReturnPct,
      alphaPct: strategyReturnPct - benchmarkReturnPct,
      firstTradeDate
    });
  } catch {
    res.status(500).json({ error: "Failed to fetch benchmark" });
  }
});

export const benchmarkRouter = router;
