import { Router } from "express";
import { db } from "../../db/src";
import { suggestionsTable, learningAnalyticsTable } from "../../db/src";
import { eq, desc, and, gte, lte, count } from "drizzle-orm";
import {
  GetSuggestionHistoryQueryParams,
  GetSuggestionParams,
  CreateSuggestionBody,
  ModifyStopLossBody,
  ModifyTargetBody,
} from "../schemas";
import { fetchLTPForSymbols } from "../suggestions/generator";
import { todayStartUTC } from "../lib/ist-time";
import { logger } from "../lib/logger";
import { logApiError, sendFallback } from "../lib/api-errors";
import { runLearningPipeline } from "../analysis/learning_engine";
import { broadcast } from "../ws/websocket_server";
import { createServerEvent } from "../ws/events";

const router = Router();

// GET /api/suggestions/active
router.get("/suggestions/active", async (req, res) => {
  try {
    const symbolParam = req.query.symbol as string | undefined;
    const conditions = [eq(suggestionsTable.status, "ACTIVE")];
    if (symbolParam) {
      conditions.push(eq(suggestionsTable.symbol, symbolParam.toUpperCase()));
    }

    const suggestions = await db
      .select()
      .from(suggestionsTable)
      .where(and(...conditions))
      .orderBy(desc(suggestionsTable.generatedAt));

    logger.debug({ count: suggestions.length }, "Retrieved active suggestions");
    if (suggestions.length > 0) {
      const symbols = suggestions.map((s) => s.symbol).join(", ");
      logger.debug({ symbols }, "Symbols with active suggestions");
      logger.debug({
        symbol: suggestions[0].symbol,
        direction: suggestions[0].direction,
        entryPrice: suggestions[0].entryPrice,
        stopLoss: suggestions[0].stopLoss,
        target1: suggestions[0].target1,
        riskReward: suggestions[0].riskReward,
        status: suggestions[0].status,
        generatedAt: suggestions[0].generatedAt,
      }, "First suggestion details");
    }

    const prices = await fetchLTPForSymbols([
      ...new Set(suggestions.map((s) => s.symbol)),
    ]);
    const result = suggestions.map((s) => serializeSuggestion(s, prices));
    logger.debug({ returnCount: result.length }, "Returning serialized suggestions");
    res.json(result);
  } catch (err) {
    logger.error({ err }, "Error fetching active suggestions");
    logApiError(req, err);
    sendFallback(res, [], "active-suggestions-error");
  }
});

// GET /api/suggestions/today
router.get("/suggestions/today", async (req, res) => {
  try {
    const todayStart = todayStartUTC();

    const suggestions = await db
      .select()
      .from(suggestionsTable)
      .where(gte(suggestionsTable.generatedAt, todayStart))
      .orderBy(desc(suggestionsTable.generatedAt))
      .limit(500);

    const activeSymbols = suggestions
      .filter((s) => s.status === "ACTIVE")
      .map((s) => s.symbol);
    const prices = await fetchLTPForSymbols([...new Set(activeSymbols)]);

    res.json(suggestions.map((s) => serializeSuggestion(s, prices)));
  } catch (err) {
    logApiError(req, err);
    sendFallback(res, [], "today-suggestions-error");
  }
});

// GET /api/suggestions/history
router.get("/suggestions/history", async (req, res) => {
  const parsed = GetSuggestionHistoryQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query parameters" });
    return;
  }

  let { page = 1, limit = 50 } = parsed.data;
  const { status, setup_type, direction, from_date, to_date } = parsed.data;

  // Validate pagination bounds
  page = Math.max(1, Math.min(page, 10000)); // Max 10k pages
  limit = Math.max(1, Math.min(limit, 100)); // Max 100 per page to prevent abuse

  try {
    const conditions = [];

    if (status) conditions.push(eq(suggestionsTable.status, status));
    if (setup_type) conditions.push(eq(suggestionsTable.setupType, setup_type));
    if (direction) conditions.push(eq(suggestionsTable.direction, direction));
    if (from_date) {
      conditions.push(gte(suggestionsTable.generatedAt, new Date(from_date)));
    }
    if (to_date) {
      const end = new Date(to_date);
      end.setHours(23, 59, 59, 999);
      conditions.push(lte(suggestionsTable.generatedAt, end));
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    // Execute both queries in parallel for efficiency
    const [rows, totalResult] = await Promise.all([
      db
        .select()
        .from(suggestionsTable)
        .where(whereClause)
        .orderBy(desc(suggestionsTable.generatedAt))
        .limit(limit)
        .offset((page - 1) * limit),
      db.select({ count: count() }).from(suggestionsTable).where(whereClause),
    ]);

    const activeSymbols = rows
      .filter((r) => r.status === "ACTIVE")
      .map((r) => r.symbol);
    
    let prices: Record<string, number> = {};
    if (activeSymbols.length > 0) {
      const { fetchLTPForSymbols } = await import("../suggestions/generator");
      prices = await fetchLTPForSymbols([...new Set(activeSymbols)]);
    }

    res.json({
      data: rows.map((row) => serializeSuggestion(row, prices)),
      total: totalResult[0]?.count ?? 0,
      page,
      limit,
    });
  } catch (err) {
    logApiError(req, err);
    sendFallback(res, { data: [], total: 0, page, limit }, "suggestion-history-error");
  }
});

// GET /api/suggestions/learning/insights
// IMPORTANT: Must be defined BEFORE /suggestions/:id to avoid 'learning' being captured as :id
router.get("/suggestions/learning/insights", async (req, res) => {
  try {
    const insights = await db
      .select()
      .from(learningAnalyticsTable)
      .orderBy(desc(learningAnalyticsTable.updatedAt));

    res.json(insights);
  } catch (err) {
    logApiError(req, err);
    sendFallback(res, [], "learning-insights-error");
  }
});

// POST /api/suggestions/learning/trigger
// IMPORTANT: Must be defined BEFORE /suggestions/:id to avoid 'learning' being captured as :id
router.post("/suggestions/learning/trigger", async (req, res) => {
  try {
    await runLearningPipeline();
    res.json({ success: true, message: "Learning pipeline executed successfully" });
  } catch (err) {
    req.log.error({ err }, "Failed to trigger learning pipeline");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/suggestions/:id
router.get("/suggestions/:id", async (req, res) => {
  const parsed = GetSuggestionParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid params" });
    return;
  }

  try {
    const [suggestion] = await db
      .select()
      .from(suggestionsTable)
      .where(eq(suggestionsTable.id, parsed.data.id))
      .limit(1);

    if (!suggestion) {
      res.status(404).json({ error: "Suggestion not found" });
      return;
    }

    res.json(serializeSuggestion(suggestion));
  } catch (err) {
    req.log.error({ err }, "Failed to get suggestion");
    res.status(500).json({ error: "Internal server error" });
  }
});

function serializeSuggestion(
  s: typeof suggestionsTable.$inferSelect,
  prices: Record<string, number> = {},
) {
  return {
    id: s.id,
    symbol: s.symbol,
    name: s.name ?? s.symbol,
    exchange: s.exchange,
    direction: s.direction,
    tradeType: s.tradeType,
    entryPrice: parseFloat(s.entryPrice),
    stopLoss: parseFloat(s.stopLoss),
    target1: parseFloat(s.target1),
    target2: s.target2 != null ? parseFloat(s.target2) : null,
    riskReward: s.riskReward != null ? parseFloat(s.riskReward) : null,
    quantity: s.quantity,
    maxRiskInr: s.maxRiskInr != null ? parseFloat(s.maxRiskInr) : null,
    stopDistancePct:
      s.stopDistancePct != null ? parseFloat(s.stopDistancePct) : null,
    setupType: s.setupType,
    marketRegime: s.marketRegime ?? "UNKNOWN",
    reasoning: s.reasoning ?? "",
    validityTill: s.validityTill ?? "15:00",
    status: s.status,
    outcomePrice: s.outcomePrice != null ? parseFloat(s.outcomePrice) : null,
    pnlInr: s.pnlInr != null ? parseFloat(s.pnlInr) : null,
    currentPrice:
      s.status === "ACTIVE"
        ? (prices[s.symbol] ?? null)
        : s.outcomePrice != null
          ? parseFloat(s.outcomePrice)
          : null,
    confidence: s.confidence ?? 0,
    generatedAt: s.generatedAt.toISOString(),
    closedAt: s.closedAt?.toISOString() ?? null,
    signalFactors: s.signalFactors,
  };
}

// NOTE: /suggestions/learning/* routes moved above /suggestions/:id to prevent route collision

// POST /api/suggestions/:id/accept
router.post("/suggestions/:id/accept", async (req, res) => {
  try {
    const id = req.params.id;
    await db
      .update(suggestionsTable)
      .set({ status: "ACTIVE" })
      .where(eq(suggestionsTable.id, id));
    res.json({ success: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    logApiError(req, err);
    res.status(500).json({ error: "Failed to accept suggestion" });
  }
});

// POST /api/suggestions/:id/reject
router.post("/suggestions/:id/reject", async (req, res) => {
  try {
    const id = req.params.id;
    await db
      .update(suggestionsTable)
      .set({ status: "REJECTED", closedAt: new Date() })
      .where(eq(suggestionsTable.id, id));
    res.json({ success: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    logApiError(req, err);
    res.status(500).json({ error: "Failed to reject suggestion" });
  }
});

// POST /api/suggestions/:id/close
router.post("/suggestions/:id/close", async (req, res) => {
  try {
    const id = req.params.id;
    await db
      .update(suggestionsTable)
      .set({ status: "EXPIRED", closedAt: new Date() })
      .where(eq(suggestionsTable.id, id));
    res.json({ success: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    logApiError(req, err);
    res.status(500).json({ error: "Failed to close position" });
  }
});

// POST /api/suggestions/:id/modify-stop
router.post("/suggestions/:id/modify-stop", async (req, res) => {
  try {
    const id = req.params.id;
    const parsed = ModifyStopLossBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid stopLoss value" });
      return;
    }
    const { stopLoss } = parsed.data;
    await db
      .update(suggestionsTable)
      .set({ stopLoss: stopLoss.toFixed(2) })
      .where(eq(suggestionsTable.id, id));
    res.json({ success: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    logApiError(req, err);
    res.status(500).json({ error: "Failed to modify stop loss" });
  }
});

// POST /api/suggestions/:id/modify-target
router.post("/suggestions/:id/modify-target", async (req, res) => {
  try {
    const id = req.params.id;
    const parsed = ModifyTargetBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid target1 value" });
      return;
    }
    const { target1 } = parsed.data;
    await db
      .update(suggestionsTable)
      .set({ target1: target1.toFixed(2) })
      .where(eq(suggestionsTable.id, id));
    res.json({ success: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    logApiError(req, err);
    res.status(500).json({ error: "Failed to modify target" });
  }
});

// POST /api/suggestions
router.post("/suggestions", async (req, res) => {
  try {
    const parsed = CreateSuggestionBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.format() });
      return;
    }

    const { symbol, direction, entryPrice, stopLoss, target1, quantity, status } = parsed.data;

    const entry = entryPrice;
    const stop = stopLoss;
    const target = target1;
    const qty = quantity;
    
    const risk = Math.abs(entry - stop);
    const reward = Math.abs(target - entry);
    const rr = risk > 0 ? reward / risk : 0;

    const [inserted] = await db
      .insert(suggestionsTable)
      .values({
        symbol: symbol.toUpperCase(),
        name: symbol.toUpperCase(),
        exchange: "NSE",
        direction,
        tradeType: "INTRADAY",
        setupType: "MANUAL",
        entryPrice: entry.toFixed(2),
        stopLoss: stop.toFixed(2),
        target1: target.toFixed(2),
        riskReward: rr.toFixed(2),
        quantity: qty,
        status,
        reasoning: "Manually entered order via terminal ticket.",
      })
      .returning();

    if (inserted) {
      req.log.info({
        id: inserted.id,
        symbol: inserted.symbol,
        setupType: inserted.setupType,
        direction: inserted.direction,
        entryPrice: inserted.entryPrice
      }, "Database write: manual suggestion inserted");
    }

    // Broadcast updates via websocket
    
    if (status === "PENDING") {
      const serialized = serializeSuggestion(inserted);
      broadcast(
        createServerEvent.newSuggestion({
          id: serialized.id,
          symbol: serialized.symbol,
          direction: serialized.direction as "BUY" | "SELL",
          entryPrice: serialized.entryPrice,
          stopLoss: serialized.stopLoss,
          target1: serialized.target1,
          setupType: serialized.setupType,
          riskReward: serialized.riskReward ?? 0,
        }),
        "suggestions",
      );
    } else {
      broadcast(createServerEvent.positionUpdate({
        id: inserted.id,
        symbol: inserted.symbol,
        entryPrice: entry,
        stopLoss: stop,
        target1: target,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        direction: direction as any,
        mode: "MANUAL"
      }), "positions");
    }

    res.json(serializeSuggestion(inserted));
  // eslint-disable-next-line unused-imports/no-unused-vars, @typescript-eslint/no-unused-vars
  } catch (err) {
    res.status(500).json({ error: "Failed to create order" });
  }
});

export default router;
