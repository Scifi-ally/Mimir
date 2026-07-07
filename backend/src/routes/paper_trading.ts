import { Router } from "express";
import { db } from "../../db/src";
import { 
  paperAccountsTable, 
  paperOrdersTable, 
  paperPositionsTable 
} from "../../db/src/schema/paper_trading";
import { eq, desc } from "drizzle-orm";
import { logger } from "../lib/logger";

const router = Router();

router.get("/paper/account", async (_req, res) => {
  try {
    let [account] = await db.select().from(paperAccountsTable).limit(1);
    if (!account) {
      [account] = await db.insert(paperAccountsTable).values({
        userId: "system",
        balance: "10000.00",
        startingBalance: "10000.00",
        allocatedMargin: "0.00"
      }).returning();
    }

    // Get live unrealized PNL
    const openPositions = await db.select().from(paperPositionsTable)
      .where(eq(paperPositionsTable.status, "OPEN"));
    
    let totalUnrealized = 0;
    openPositions.forEach(p => {
      totalUnrealized += parseFloat(p.unrealizedPnl);
    });

    res.json({
      ...account,
      livePnl: totalUnrealized.toFixed(2),
      equity: (parseFloat(account.balance) + totalUnrealized).toFixed(2)
    });
  } catch (error) {
    logger.error({ error }, "Failed to fetch paper account");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/paper/positions", async (_req, res) => {
  try {
    const openPositions = await db.select()
      .from(paperPositionsTable)
      .where(eq(paperPositionsTable.status, "OPEN"))
      .orderBy(desc(paperPositionsTable.createdAt));
    res.json(openPositions);
  } catch (error) {
    logger.error({ error }, "Failed to fetch paper positions");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/paper/history", async (_req, res) => {
  try {
    const closedPositions = await db.select()
      .from(paperPositionsTable)
      .where(eq(paperPositionsTable.status, "CLOSED"))
      .orderBy(desc(paperPositionsTable.closedAt))
      .limit(50);
    res.json(closedPositions);
  } catch (error) {
    logger.error({ error }, "Failed to fetch paper history");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/paper/reset", async (_req, res) => {
  try {
    await db.transaction(async (tx) => {
      await tx.delete(paperOrdersTable);
      await tx.delete(paperPositionsTable);
      await tx.delete(paperAccountsTable);
    });
    
    const [account] = await db.insert(paperAccountsTable).values({
      userId: "system",
      balance: "10000.00",
      startingBalance: "10000.00",
      allocatedMargin: "0.00"
    }).returning();
    
    logger.info("Paper Trading Account Reset");
    res.json(account);
  } catch (error) {
    logger.error({ error }, "Failed to reset paper account");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
