import { Router } from "express";
import { logger } from "../lib/logger";
import { db } from "../../db/src";
import { customScreenerTable, customScreenerMatchesTable, customScreenerTargetsTable, customScreenerRunsTable } from "../../db/src/schema/custom_screener";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";

const router = Router();
// Trigger nodemon restart

const indicatorSchema = z.string().trim().min(1).max(50).transform((value) => value.toUpperCase()).refine((value) => {
  if (Number.isFinite(Number(value))) return true;
  if (["PRICE", "CLOSE", "OPEN", "HIGH", "LOW", "VOLUME", "PREV_CLOSE", "MACD", "MACD_SIGNAL", "VWAP", "SUPERTREND", "MACD_HISTOGRAM", "VOLUME_RATIO", "CHANGE_PCT"].includes(value)) return true;
  const match = value.match(/^(SMA|EMA|RSI|ATR|ROC|ADX|BB_UPPER|BB_MIDDLE|BB_LOWER|BB_WIDTH)(\d{1,3})$/);
  return Boolean(match && Number(match[2]) >= 2 && Number(match[2]) <= 500);
}, "Unsupported indicator or invalid period");

const operatorSchema = z.enum([">", "<", ">=", "<=", "==", "!=", "CROSSES_ABOVE", "CROSSES_BELOW"]);
const scheduleModeSchema = z.enum(["MARKET_OPEN", "MARKET_CLOSE", "EVERY_MINUTE", "TIME", "ON_DEMAND", "EVERY_CANDLE"]);
const scheduleTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:mm format");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ruleNodeSchema: z.ZodType<any> = z.lazy(() => z.union([
  z.object({ type: z.literal("CONDITION"), indicatorA: indicatorSchema, operator: operatorSchema, indicatorB: indicatorSchema, alertMessage: z.string().optional() }).strict(),
  z.object({ type: z.enum(["AND", "OR"]), rules: z.array(ruleNodeSchema).min(1).max(50) }).strict(),
]));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function inspectRuleTree(node: any, depth = 0): { depth: number; count: number } {
  if (node.type === "CONDITION") return { depth, count: 1 };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return node.rules.reduce((result: { depth: number; count: number }, child: any) => {
    const inspected = inspectRuleTree(child, depth + 1);
    return { depth: Math.max(result.depth, inspected.depth), count: result.count + inspected.count };
  }, { depth, count: 0 });
}

const createScreenerSchema = z.object({
  symbol: z.string().trim().min(1).max(50).transform((value) => value.toUpperCase()).default("ALL"),
  targetType: z.enum(["ALL", "SUGGESTIONS", "OVERNIGHT", "CUSTOM"]).default("ALL"),
  outputName: z.string().trim().min(1).max(100).optional(),
  timeframe: z.enum(["1m", "5m", "15m", "1h", "1d"]),
  indicatorA: indicatorSchema.optional(),
  operator: operatorSchema.optional(),
  indicatorB: indicatorSchema.optional(),
  conditions: ruleNodeSchema.optional(),
  scheduleMode: scheduleModeSchema.default("MARKET_OPEN"),
  scheduleTime: scheduleTimeSchema.optional().nullable(),
}).strict().superRefine((data, context) => {
  if (data.targetType === "CUSTOM" && !data.outputName) {
    context.addIssue({ code: "custom", path: ["outputName"], message: "A custom watchlist name is required" });
  }
  if (!data.conditions && !(data.indicatorA && data.operator && data.indicatorB)) {
    context.addIssue({ code: "custom", path: ["conditions"], message: "At least one complete condition is required" });
  }
  if (data.conditions) {
    const { depth, count } = inspectRuleTree(data.conditions);
    if (depth > 5) context.addIssue({ code: "custom", path: ["conditions"], message: "Condition groups may be nested up to five levels" });
    if (count > 50) context.addIssue({ code: "custom", path: ["conditions"], message: "A screener may contain at most 50 conditions" });
  }
  if (data.scheduleMode === "TIME" && !data.scheduleTime) {
    context.addIssue({ code: "custom", path: ["scheduleTime"], message: "A run time is required for scheduled time mode" });
  }
});

router.get("/screener", async (_req, res, next) => {
  try {
    const screeners = await db.select().from(customScreenerTable).orderBy(desc(customScreenerTable.createdAt));
    return res.json(screeners);
  } catch (err) {
    return next(err);
  }
});

router.post("/screener", async (req, res, next) => {
  try {
    const data = createScreenerSchema.parse(req.body);
    const [inserted] = await db.insert(customScreenerTable).values({
      ...data,
      userId: "system",
      status: "ACTIVE",
    }).returning();
    return res.status(201).json(inserted);
  } catch (err) {
    return next(err);
  }
});

router.put("/screener/:id", async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
    
    const data = createScreenerSchema.parse(req.body);
    const [updated] = await db.update(customScreenerTable)
      .set(data)
      .where(eq(customScreenerTable.id, id))
      .returning();
      
    if (!updated) return res.status(404).json({ error: "Screener not found" });
    return res.json(updated);
  } catch (err) {
    return next(err);
  }
});

router.delete("/screener/:id", async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
    
    await db.delete(customScreenerTable).where(eq(customScreenerTable.id, id));
    return res.json({ success: true });
  } catch (err) {
    return next(err);
  }
});

router.patch("/screener/:id/toggle", async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
    
    const [existing] = await db.select({ status: customScreenerTable.status })
      .from(customScreenerTable)
      .where(eq(customScreenerTable.id, id))
      .limit(1);
    if (!existing) return res.status(404).json({ error: "Screener not found" });
    
    const newStatus = existing.status === "ACTIVE" ? "PAUSED" : "ACTIVE";
    const [updated] = await db.update(customScreenerTable)
      .set({ status: newStatus })
      .where(eq(customScreenerTable.id, id))
      .returning();
    return res.json(updated);
  } catch (err) {
    return next(err);
  }
});

router.get("/screener/matches", async (_req, res, next) => {
  try {
    const matches = await db.select({
      id: customScreenerMatchesTable.id,
      screenerId: customScreenerMatchesTable.screenerId,
      symbol: customScreenerMatchesTable.symbol,
      timeframe: customScreenerMatchesTable.timeframe,
      condition: customScreenerMatchesTable.condition,
      matchedAt: customScreenerMatchesTable.matchedAt,
      acknowledged: customScreenerMatchesTable.acknowledged,
    })
    .from(customScreenerMatchesTable)
    .where(eq(customScreenerMatchesTable.acknowledged, false))
    .orderBy(desc(customScreenerMatchesTable.matchedAt))
    .limit(50);
    
    return res.json(matches);
  } catch (err) {
    return next(err);
  }
});

import { isAuthenticated } from "../upstox/auth";

router.post("/screener/run", async (req, res, next) => {
  try {
    if (!isAuthenticated()) {
      return res.status(401).json({ error: "Upstox is not authenticated. Please connect your broker account to run the custom scanner." });
    }

    const { screenerId } = req.body || {};
    

    let activeQuery = db.select({ id: customScreenerTable.id })
      .from(customScreenerTable)
      .where(eq(customScreenerTable.status, "ACTIVE"));
      
    if (screenerId) {
      activeQuery = db.select({ id: customScreenerTable.id })
        .from(customScreenerTable)
        .where(and(eq(customScreenerTable.status, "ACTIVE"), eq(customScreenerTable.id, screenerId)));
    }
    
    const activeScreeners = await activeQuery;

    const { runCustomScreener } = await import("../analysis/custom_screener_engine");
    const { getTargetTradingSessionDate } = await import("../market_data/market_state");
    
    const targetSession = getTargetTradingSessionDate();
    
    // 1. Mark existing active scan for this session as inactive
    await db.update(customScreenerRunsTable)
      .set({ isActive: false })
      .where(and(
        eq(customScreenerRunsTable.tradingSessionDate, targetSession),
        eq(customScreenerRunsTable.isActive, true)
      ));
      
    // 2. Create new MANUAL run
    const [newRun] = await db.insert(customScreenerRunsTable).values({
      tradingSessionDate: targetSession,
      status: "RUNNING",
      triggerType: "MANUAL",
      isActive: true,
    }).returning({ id: customScreenerRunsTable.id });
    
    // Run asynchronously to avoid blocking the HTTP request
    runCustomScreener({ 
      screenerIds: screenerId ? [screenerId] : undefined,
      runId: newRun.id 
    }).catch((err) => {
      logger.error({ err }, "Error running custom screener asynchronously");
    });

    return res.json({
      success: true,
      message: "Manual screener started. This replaces any previous scan for the current trading session.",
      activeScreeners: activeScreeners.length,
      newMatches: 0,
      newTargets: 0,
      totalMatches: 0,
      totalTargets: 0,
      runAt: new Date().toISOString(),
    });
  } catch (err) {
    return next(err);
  }
});

router.post("/screener/matches/:id/acknowledge", async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
    
    await db.update(customScreenerMatchesTable)
      .set({ acknowledged: true })
      .where(eq(customScreenerMatchesTable.id, id));
    return res.json({ success: true });
  } catch (err) {
    return next(err);
  }
});

router.get("/screener/targets", async (_req, res, next) => {
  try {
    const targets = await db.select().from(customScreenerTargetsTable).orderBy(desc(customScreenerTargetsTable.createdAt));
    return res.json(targets);
  } catch (err) {
    return next(err);
  }
});

const createTargetSchema = z.object({
  symbol: z.string().trim().min(1).max(50).transform((v) => v.toUpperCase()),
  screenerId: z.number().int().positive().optional().nullable(),
});

router.post("/screener/targets", async (req, res, next) => {
  try {
    const data = createTargetSchema.parse(req.body);
    if (data.screenerId) {
      const [watchlist] = await db.select({
        id: customScreenerTable.id,
        targetType: customScreenerTable.targetType,
      })
        .from(customScreenerTable)
        .where(eq(customScreenerTable.id, data.screenerId))
        .limit(1);

      if (!watchlist) return res.status(404).json({ error: "Custom watchlist not found" });
      if (watchlist.targetType !== "CUSTOM") return res.status(400).json({ error: "Targets can only be added to custom watchlists" });
    }

    const duplicateWhere = data.screenerId
      ? and(eq(customScreenerTargetsTable.screenerId, data.screenerId), eq(customScreenerTargetsTable.symbol, data.symbol))
      : and(isNull(customScreenerTargetsTable.screenerId), eq(customScreenerTargetsTable.symbol, data.symbol));
    const [existing] = await db.select()
      .from(customScreenerTargetsTable)
      .where(duplicateWhere)
      .limit(1);
    if (existing) return res.status(200).json(existing);

    const [inserted] = await db.insert(customScreenerTargetsTable).values({
      symbol: data.symbol,
      userId: "system",
      screenerId: data.screenerId ?? null,
    }).returning();
    return res.status(201).json(inserted);
  } catch (err) {
    return next(err);
  }
});

router.delete("/screener/targets/:id", async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
    await db.delete(customScreenerTargetsTable).where(eq(customScreenerTargetsTable.id, id));
    return res.json({ success: true });
  } catch (err) {
    return next(err);
  }
});

export default router;
