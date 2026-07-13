import { Router } from "express";
import { db } from "../../db/src";
import { paperPositionsTable, paperAccountsTable } from "../../db/src/schema/paper_trading";
import { asc } from "drizzle-orm";

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
    
    // In a real system we would query historical DB for Nifty50 at firstTradeDate.
    // For this simulation, we'll fetch current Nifty50 LTP and compare to an estimated starting point or 
    // ideally the historical Nifty 50 on that date. Since we don't have a historical Nifty50 DB table handy,
    // we'll return the system's PnL relative to the starting balance.
    
    const startingBalance = Number(account.startingBalance);
    const currentBalance = Number(account.balance);
    const strategyReturnPct = ((currentBalance - startingBalance) / startingBalance) * 100;

    // Fetch current Nifty 50 (omitted since unused)
    
    // Fallback benchmark return logic (mocked if no historical data is available)
    const benchmarkReturnPct = 0; // Requires historical indexing to calculate properly

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
