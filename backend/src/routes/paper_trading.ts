import { Router } from "express";
import { db } from "../../db/src";
import {
  paperAccountsTable,
  paperOrdersTable,
  paperPositionsTable
} from "../../db/src/schema/paper_trading";
import { eq, desc, inArray } from "drizzle-orm";
import { logger } from "../lib/logger";
import { getConfig } from "../config";
import { broadcast } from "../ws/websocket_server";
import { createServerEvent } from "../ws/events";

const router = Router();

// Single source of truth for the paper account's starting balance: the same
// configured trading capital the engine sizes against (paper_engine.getStartingBalance).
// A hardcoded literal here silently diverged from config whenever a user changed
// their trading capital, so a freshly-created account started with the wrong base.
function getStartingBalance(): string {
  return getConfig().tradingCapital.toFixed(2);
}

router.get("/paper/account", async (_req, res) => {
  try {
    let [account] = await db.select().from(paperAccountsTable).limit(1);
    const targetBalance = getStartingBalance();
    if (!account) {
      [account] = await db.insert(paperAccountsTable).values({
        userId: "system",
        balance: targetBalance,
        startingBalance: targetBalance,
        allocatedMargin: "0.00"
      }).returning();
    }
    // NOTE: A read endpoint must never mutate account state. The previous
    // implementation reset balance/startingBalance to the default and zeroed
    // allocatedMargin whenever startingBalance > 50k — silently wiping funded
    // accounts on every poll and, with OPEN positions, overstating available
    // margin (committed margin still held, but allocatedMargin cleared). Any
    // intentional balance reset belongs in an explicit POST action, not GET.

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

    // Attach the actual exit reason from the order ledger — the UI must not
    // guess TARGET/STOP from the P&L sign.
    const suggestionIds = closedPositions
      .map((p) => p.suggestionId)
      .filter((id): id is string => id != null);
    const exitOrders = suggestionIds.length > 0
      ? await db.select({
          suggestionId: paperOrdersTable.suggestionId,
          orderType: paperOrdersTable.orderType,
          executedAt: paperOrdersTable.executedAt,
        })
          .from(paperOrdersTable)
          .where(inArray(paperOrdersTable.suggestionId, suggestionIds))
          .orderBy(desc(paperOrdersTable.executedAt))
      : [];
    const exitBySuggestion = new Map<string, string>();
    for (const o of exitOrders) {
      // Rows are newest-first; keep the latest non-entry order per suggestion.
      if (o.suggestionId && o.orderType !== "ENTRY" && !exitBySuggestion.has(o.suggestionId)) {
        exitBySuggestion.set(o.suggestionId, o.orderType);
      }
    }

    res.json(closedPositions.map((p) => ({
      ...p,
      closeReason: p.suggestionId ? exitBySuggestion.get(p.suggestionId) ?? null : null,
    })));
  } catch (error) {
    logger.error({ error }, "Failed to fetch paper history");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/paper/reset", async (_req, res) => {
  try {
    const [account] = await db.transaction(async (tx) => {
      await tx.delete(paperOrdersTable);
      await tx.delete(paperPositionsTable);
      await tx.delete(paperAccountsTable);
      return tx.insert(paperAccountsTable).values({
        userId: "system",
        balance: getStartingBalance(),
        startingBalance: getStartingBalance(),
        allocatedMargin: "0.00"
      }).returning();
    });
    
    logger.info("Paper Trading Account Reset");
    res.json(account);
    broadcast(createServerEvent.systemAlert({ message: "Paper trading account reset", severity: "info" }));
  } catch (error) {
    logger.error({ error }, "Failed to reset paper account");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
