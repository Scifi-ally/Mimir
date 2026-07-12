import crypto from "node:crypto";
import type { ActiveSuggestion, RankedOpportunity, Direction } from "./types";
import { logger } from "../lib/logger";

export class SuggestionGenerator {
  private readonly suggestions = new Map<string, ActiveSuggestion>();

  async recoverState(): Promise<void> {
    try {
      const { db, suggestionsTable } = await import("../../db/src");
      const { findStockBySymbol } = await import("../analysis/stock_scanner");
      const { and, eq, gte } = await import("drizzle-orm");
      const { todayStartUTC } = await import("../lib/ist-time");

      const dbSuggestions = await db
        .select()
        .from(suggestionsTable)
        .where(
          and(
            eq(suggestionsTable.status, "ACTIVE"),
            gte(suggestionsTable.generatedAt, todayStartUTC())
          )
        );

      const now = Date.now();
      for (const row of dbSuggestions) {
        const generatedAtMs = row.generatedAt.getTime();
        const expiresAtMs = generatedAtMs + 20 * 60_000;
        if (expiresAtMs <= now) continue;

        const stock = await findStockBySymbol(row.symbol);
        if (!stock) continue;

        const canonicalKey = stock.key.trim().toUpperCase().replace(":", "|");
        const active: ActiveSuggestion = {
          id: row.id,
          instrumentKey: canonicalKey,
          symbol: row.symbol,
          direction: row.direction as Direction,
          setup: row.setupType,
          confidence: row.confidence ?? Math.round((Number(row.riskReward) || 2) * 10),
          entry: Number(row.entryPrice),
          stopLoss: Number(row.stopLoss),
          target: Number(row.target1),
          riskReward: Number(row.riskReward) || 2,
          reasoning: row.reasoning ? [row.reasoning] : [],
          generatedAt: generatedAtMs,
          expiresAt: expiresAtMs,
        };

        this.suggestions.set(canonicalKey, active);
        logger.info({ symbol: row.symbol, id: row.id }, "Recovered active suggestion from database");
      }
    } catch (err) {
      logger.warn({ err }, "Failed to recover active suggestions state from database");
    }
  }

  generate(opportunity: RankedOpportunity): ActiveSuggestion {
    this.expireStale();
    const existing = this.suggestions.get(opportunity.instrumentKey);
    if (existing && existing.expiresAt > Date.now()) {
      return { ...existing, isNew: false };
    }

    const generatedAt = Date.now();
    const suggestion: ActiveSuggestion = {
      id: crypto.randomUUID(),
      instrumentKey: opportunity.instrumentKey,
      symbol: opportunity.symbol,
      direction: opportunity.direction,
      setup: opportunity.setup,
      confidence: Math.round(opportunity.compositeScore * 10),
      entry: opportunity.entry,
      stopLoss: opportunity.stopLoss,
      target: opportunity.target,
      riskReward: opportunity.riskReward,
      reasoning: opportunity.rankReasoning,
      generatedAt,
      expiresAt: generatedAt + 20 * 60_000,
      isNew: true,
    };
    this.suggestions.set(opportunity.instrumentKey, suggestion);
    return suggestion;
  }

  expireStale(now = Date.now()): void {
    for (const [key, suggestion] of this.suggestions.entries()) {
      if (suggestion.expiresAt <= now) this.suggestions.delete(key);
    }
  }

  getActive(): ActiveSuggestion[] {
    this.expireStale();
    return Array.from(this.suggestions.values()).sort((a, b) => b.confidence - a.confidence);
  }

  size(): number {
    return this.getActive().length;
  }
}
