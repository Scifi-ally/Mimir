/**
 * ETF Suggestion Service
 * ─────────────────────────────────────────────────────────────────────────────
 * Synchronizes low-turnover, consistent profit ETF Dual-Momentum rotation
 * signals with Mimir's suggestion database, WebSocket broadcaster, and paper trading engine.
 */
import { db } from "../../db/src";
import { suggestionsTable } from "../../db/src";
import { eq, and, inArray } from "drizzle-orm";
import { broadcast } from "../ws/websocket_server";
import { createServerEvent } from "../ws/events";
import { intelligenceBus } from "../intelligence/event_bus";
import { logger } from "../lib/logger";
import { readEtfRotationSignal, runEtfSignalJob } from "./strategy_lab";
import { getConfig } from "../config";

const ETF_NAMES: Record<string, string> = {
  GOLDBEES: "Nippon India ETF Gold BeES",
  NIFTYBEES: "Nippon India ETF Nifty BeES",
  JUNIORBEES: "Nippon India ETF Junior BeES",
  MON100: "Motilal Oswal Nasdaq 100 ETF",
  BANKBEES: "Nippon India ETF Bank BeES",
  SILVERBEES: "Nippon India ETF Silver BeES",
  LIQUIDBEES: "Nippon India ETF Liquid BeES",
};

export interface EtfSyncResult {
  action: "CREATED" | "ALREADY_ACTIVE" | "HOLD_CASH" | "ERROR";
  suggestion?: typeof suggestionsTable.$inferSelect;
  signal?: Record<string, unknown>;
  message?: string;
}

export async function syncEtfSuggestionToEngine(capitalOverride?: number): Promise<EtfSyncResult> {
  try {
    const capital = capitalOverride ?? getConfig().tradingCapital ?? 10_000;
    let signal = await readEtfRotationSignal();
    if (!signal) {
      signal = await runEtfSignalJob(capital);
    }

    const target = signal.target as string | undefined;
    const targetReturns = (signal.lookback_returns_pct as Record<string, number | null>) ?? {};

    if (!target || target === "CASH" || target === "WARMUP") {
      logger.info({ target }, "ETF Rotation signal is currently CASH / defensive preservation");
      return { action: "HOLD_CASH", signal, message: "Model is holding CASH / LIQUIDBEES for capital preservation." };
    }

    const existing = await db
      .select()
      .from(suggestionsTable)
      .where(
        and(
          eq(suggestionsTable.symbol, target),
          eq(suggestionsTable.setupType, "ETF_DUAL_MOMENTUM"),
          inArray(suggestionsTable.status, ["ACTIVE", "PENDING"])
        )
      )
      .limit(1);

    if (existing.length > 0) {
      logger.debug({ symbol: target, id: existing[0].id }, "ETF Rotation suggestion is already active in database");
      return { action: "ALREADY_ACTIVE", suggestion: existing[0], signal };
    }

    // Determine representative entry price and quantity
    const units = (signal.indicative_units_for_capital as number) || Math.max(1, Math.floor(capital / 150));
    const estimatedEntry = units > 0 ? capital / units : 100.0;
    const entryRounded = Math.round(estimatedEntry * 100) / 100;
    const stopRounded = Math.round(entryRounded * 0.92 * 100) / 100; // 8% capital preservation stop
    const target1Rounded = Math.round(entryRounded * 1.15 * 100) / 100; // 15% target
    const target2Rounded = Math.round(entryRounded * 1.30 * 100) / 100; // 30% target
    const rr = 1.88;
    const returnVal = targetReturns[target] != null ? `${targetReturns[target]}%` : "positive";

    const reasoning = `[ETF DUAL MOMENTUM 63D] Rotated into ${target} (${returnVal} 63-day return leading asset class basket). Cross-asset momentum rotation beats single-stock friction with ~4 trades/yr.`;

    const now = new Date();
    const expiry = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // 30-day horizon

    const [inserted] = await db
      .insert(suggestionsTable)
      .values({
        symbol: target,
        name: ETF_NAMES[target] || `${target} ETF`,
        exchange: "NSE",
        direction: "BUY",
        tradeType: "SWING",
        setupType: "ETF_DUAL_MOMENTUM",
        entryPrice: entryRounded.toFixed(2),
        stopLoss: stopRounded.toFixed(2),
        target1: target1Rounded.toFixed(2),
        target2: target2Rounded.toFixed(2),
        riskReward: rr.toFixed(2),
        quantity: units,
        maxRiskInr: Math.round(capital * 0.08).toFixed(2),
        stopDistancePct: "8.00",
        marketRegime: "TRENDING",
        confidence: 78,
        aiScore: 85,
        patternScore: 80,
        chronosScore: 75,
        technicalScore: 82,
        sentimentScore: 65,
        rankingMode: "dual_momentum_63d",
        status: "ACTIVE",
        reasoning,
        validityTill: expiry.toISOString().split("T")[0],
        expectedHoldMinutes: 30 * 24 * 60,
        expiresAt: expiry,
        highestPrice: entryRounded.toFixed(2),
        lowestPrice: entryRounded.toFixed(2),
        atr: (entryRounded * 0.02).toFixed(2),
      })
      .returning();

    if (inserted) {
      logger.info(
        { id: inserted.id, symbol: inserted.symbol, units, entry: entryRounded },
        "ETF Rotation suggestion created and activated in database"
      );

      broadcast(
        createServerEvent.newSuggestion({
          id: inserted.id,
          symbol: inserted.symbol,
          direction: "BUY",
          entryPrice: entryRounded,
          stopLoss: stopRounded,
          target1: target1Rounded,
          setupType: "ETF_DUAL_MOMENTUM",
          riskReward: rr,
        }),
        "suggestions"
      );

      intelligenceBus.publish("suggestionGenerated", {
        suggestion: {
          id: inserted.id,
          instrumentKey: `NSE_EQ|${inserted.symbol}`,
          symbol: inserted.symbol,
          direction: "BUY",
          setup: "ETF_DUAL_MOMENTUM",
          confidence: 78,
          entry: entryRounded,
          stopLoss: stopRounded,
          target: target1Rounded,
          target1: target1Rounded,
          riskReward: rr,
          reasoning: [reasoning],
          generatedAt: Date.now(),
          expiresAt: expiry.getTime(),
        } as any,
      });

      intelligenceBus.publish("suggestionTriggered", {
        suggestionId: inserted.id,
        fillPrice: entryRounded,
      });

      return { action: "CREATED", suggestion: inserted, signal };
    }

    return { action: "ERROR", message: "Insert returned no row", signal };
  } catch (err) {
    logger.error({ err }, "Error synchronizing ETF suggestion to engine");
    return { action: "ERROR", message: String(err) };
  }
}
