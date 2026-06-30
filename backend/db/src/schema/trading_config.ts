import { pgTable, integer, decimal, text, timestamp, boolean, varchar } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const tradingConfigTable = pgTable("trading_config", {
  id: integer("id").primaryKey().default(1),
  tradingCapital: decimal("trading_capital", {
    precision: 12,
    scale: 2,
  })
    .notNull()
    .default("500000"),
  maxRiskPerTradePct: decimal("max_risk_per_trade_pct", {
    precision: 5,
    scale: 2,
  })
    .notNull()
    .default("1.0"),
  maxDailyLossPct: decimal("max_daily_loss_pct", { precision: 5, scale: 2 })
    .notNull()
    .default("3.0"),
  maxOpenPositions: integer("max_open_positions").notNull().default(5),
  maxSectorExposure: integer("max_sector_exposure").notNull().default(2),
  minRiskReward: decimal("min_risk_reward", { precision: 5, scale: 2 })
    .notNull()
    .default("1.5"),
  minDailyVolume: integer("min_daily_volume").notNull().default(500000),
  vixPauseThreshold: decimal("vix_pause_threshold", { precision: 5, scale: 2 })
    .notNull()
    .default("22"),
  minSuggestionScore: decimal("min_suggestion_score", { precision: 5, scale: 2 })
    .notNull()
    .default("5.5"),
  minMtfConfluencePct: decimal("min_mtf_confluence_pct", { precision: 5, scale: 2 })
    .notNull()
    .default("45"),
  minAutoConfidencePct: decimal("min_auto_confidence_pct", { precision: 5, scale: 2 })
    .notNull()
    .default("55"),
  brokeragePerOrderInr: decimal("brokerage_per_order_inr", { precision: 10, scale: 2 })
    .notNull()
    .default("20"),
  slippageBps: decimal("slippage_bps", { precision: 8, scale: 2 })
    .notNull()
    .default("5"),
  confidenceThresholdByRegimeJson: text("confidence_threshold_by_regime_json")
    .notNull()
    .default('{"TRENDING_UP":70,"TRENDING_DOWN":70,"RANGING":74,"VOLATILE":78,"UNKNOWN":72}'),
  maxSameDirectionOpenPositions: integer("max_same_direction_open_positions").notNull().default(3),
  avoidFirstMinutes: integer("avoid_first_minutes").notNull().default(10),
  avoidMiddayStartMinute: integer("avoid_midday_start_minute").notNull().default(150),
  avoidMiddayEndMinute: integer("avoid_midday_end_minute").notNull().default(225),
  weeklyLossLimitPct: decimal("weekly_loss_limit_pct", { precision: 5, scale: 2 })
    .notNull()
    .default("6"),
  rollingDrawdownPct: decimal("rolling_drawdown_pct", { precision: 5, scale: 2 })
    .notNull()
    .default("8"),
  paperTradingEnabled: boolean("paper_trading_enabled").notNull().default(true),
  upstoxApiKey: text("upstox_api_key"),
  upstoxApiSecret: text("upstox_api_secret"),
  upstoxRedirectUri: text("upstox_redirect_uri"),
  upstoxDataApiKey: text("upstox_data_api_key"),
  upstoxDataApiSecret: text("upstox_data_api_secret"),
  stopLossMode: varchar("stop_loss_mode", { length: 20 }).notNull().default("FIXED"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertTradingConfigSchema = createInsertSchema(
  tradingConfigTable
).omit({ id: true, updatedAt: true });
export type InsertTradingConfig = z.infer<typeof insertTradingConfigSchema>;
export type TradingConfig = typeof tradingConfigTable.$inferSelect;
