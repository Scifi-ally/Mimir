import "../load-env.cjs";
import { eq } from "drizzle-orm";
import { db, tradingConfigTable } from "../db/src";
import { logger } from "./lib/logger";
import { protectSecret, revealSecret } from "./lib/secrets";

export interface TradingConfig {
  tradingCapital: number;
  maxRiskPerTradePct: number;
  maxDailyLossPct: number;
  maxOpenPositions: number;
  maxSectorExposure: number;
  minRiskReward: number;
  minDailyVolume: number;
  vixPauseThreshold: number;
  // Minimum score required (0-10) for a candidate to be considered
  minSuggestionScore: number;
  // Minimum multi-timeframe confluence (%) required to accept suggestions automatically
  minMtfConfluencePct: number;
  minAutoConfidencePct: number;
  brokeragePerOrderInr: number;
  slippageBps: number;
  confidenceThresholdByRegimeJson: string;
  maxSameDirectionOpenPositions: number;
  avoidFirstMinutes: number;
  avoidMiddayStartMinute: number;
  avoidMiddayEndMinute: number;
  weeklyLossLimitPct: number;
  rollingDrawdownPct: number;
  paperTradingEnabled: boolean;
  upstoxApiKey: string;
  upstoxApiSecret: string;
  upstoxDataApiKey: string;
  upstoxDataApiSecret: string;
  upstoxRedirectUri: string;
  stopLossMode: string;
}

export const defaultConfig: TradingConfig = {
  tradingCapital: 500000,
  maxRiskPerTradePct: 1.0,
  maxDailyLossPct: 3.0,
  maxOpenPositions: 5,
  maxSectorExposure: 2,
  minRiskReward: 1.5,
  minDailyVolume: 500000,
  vixPauseThreshold: 22,
  minSuggestionScore: 5.5,  // Significantly lowered to generate suggestions on slow days
  minMtfConfluencePct: 45,   // Significantly lowered for better balance on weak-pattern days
  minAutoConfidencePct: 55,  // Lower adaptive confidence floor
  brokeragePerOrderInr: 20,
  slippageBps: 5,
  confidenceThresholdByRegimeJson: '{"TRENDING_UP":70,"TRENDING_DOWN":70,"RANGING":74,"VOLATILE":78,"UNKNOWN":72}',
  maxSameDirectionOpenPositions: 3,
  avoidFirstMinutes: 10,
  avoidMiddayStartMinute: 150, // 11:45 IST (from 09:15)
  avoidMiddayEndMinute: 225,   // 13:00 IST
  weeklyLossLimitPct: 6,
  rollingDrawdownPct: 8,
  paperTradingEnabled: true,
  upstoxApiKey: process.env["UPSTOX_API_KEY"] ?? "",
  upstoxApiSecret: process.env["UPSTOX_API_SECRET"] ?? "",
  upstoxDataApiKey: process.env["UPSTOX_DATA_API_KEY"] ?? "",
  upstoxDataApiSecret: process.env["UPSTOX_DATA_API_SECRET"] ?? "",
  upstoxRedirectUri: (() => {
    if (process.env["UPSTOX_REDIRECT_URI"]) return process.env["UPSTOX_REDIRECT_URI"];
    // Auto-derive from Replit dev domain when running in Replit
    const devDomain = process.env["REPLIT_DEV_DOMAIN"];
    if (devDomain) return `https://${devDomain}/api/system/auth-callback`;
    return "http://localhost:5000/api/system/auth-callback";
  })(),
  stopLossMode: "FIXED",
};

let _config: TradingConfig = { ...defaultConfig };

export function getConfig(): TradingConfig {
  return _config;
}

function applyConfig(partial: Partial<TradingConfig>): TradingConfig {
  _config = { ..._config, ...partial };
  return _config;
}

function numberOrDefault(value: string | null | undefined, fallback: number): number {
  if (value == null) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function rowToConfig(row: typeof tradingConfigTable.$inferSelect): TradingConfig {
  return {
    tradingCapital: numberOrDefault(row.tradingCapital, defaultConfig.tradingCapital),
    maxRiskPerTradePct: numberOrDefault(row.maxRiskPerTradePct, defaultConfig.maxRiskPerTradePct),
    maxDailyLossPct: numberOrDefault(row.maxDailyLossPct, defaultConfig.maxDailyLossPct),
    maxOpenPositions: row.maxOpenPositions ?? defaultConfig.maxOpenPositions,
    maxSectorExposure: row.maxSectorExposure ?? defaultConfig.maxSectorExposure,
    minRiskReward: numberOrDefault(row.minRiskReward, defaultConfig.minRiskReward),
    minDailyVolume: row.minDailyVolume ?? defaultConfig.minDailyVolume,
    vixPauseThreshold: numberOrDefault(row.vixPauseThreshold, defaultConfig.vixPauseThreshold),
    minSuggestionScore: numberOrDefault(row.minSuggestionScore, defaultConfig.minSuggestionScore),
    minMtfConfluencePct: numberOrDefault(row.minMtfConfluencePct, defaultConfig.minMtfConfluencePct),
    minAutoConfidencePct: numberOrDefault(row.minAutoConfidencePct, defaultConfig.minAutoConfidencePct),
    brokeragePerOrderInr: numberOrDefault(row.brokeragePerOrderInr, defaultConfig.brokeragePerOrderInr),
    slippageBps: numberOrDefault(row.slippageBps, defaultConfig.slippageBps),
    confidenceThresholdByRegimeJson: row.confidenceThresholdByRegimeJson ?? defaultConfig.confidenceThresholdByRegimeJson,
    maxSameDirectionOpenPositions: row.maxSameDirectionOpenPositions ?? defaultConfig.maxSameDirectionOpenPositions,
    avoidFirstMinutes: row.avoidFirstMinutes ?? defaultConfig.avoidFirstMinutes,
    avoidMiddayStartMinute: row.avoidMiddayStartMinute ?? defaultConfig.avoidMiddayStartMinute,
    avoidMiddayEndMinute: row.avoidMiddayEndMinute ?? defaultConfig.avoidMiddayEndMinute,
    weeklyLossLimitPct: numberOrDefault(row.weeklyLossLimitPct, defaultConfig.weeklyLossLimitPct),
    rollingDrawdownPct: numberOrDefault(row.rollingDrawdownPct, defaultConfig.rollingDrawdownPct),
    paperTradingEnabled: row.paperTradingEnabled ?? defaultConfig.paperTradingEnabled,
    upstoxApiKey: row.upstoxApiKey ?? defaultConfig.upstoxApiKey,
    upstoxApiSecret: row.upstoxApiSecret ? revealSecret(row.upstoxApiSecret) : defaultConfig.upstoxApiSecret,
    upstoxDataApiKey: defaultConfig.upstoxDataApiKey,
    upstoxDataApiSecret: defaultConfig.upstoxDataApiSecret,
    upstoxRedirectUri: row.upstoxRedirectUri ?? defaultConfig.upstoxRedirectUri,
    stopLossMode: row.stopLossMode ?? defaultConfig.stopLossMode,
  };
}

function toDbValues(cfg: TradingConfig): typeof tradingConfigTable.$inferInsert {
  return {
    id: 1,
    tradingCapital: cfg.tradingCapital.toString(),
    maxRiskPerTradePct: cfg.maxRiskPerTradePct.toString(),
    maxDailyLossPct: cfg.maxDailyLossPct.toString(),
    maxOpenPositions: cfg.maxOpenPositions,
    maxSectorExposure: cfg.maxSectorExposure,
    minRiskReward: cfg.minRiskReward.toString(),
    minDailyVolume: cfg.minDailyVolume,
    vixPauseThreshold: cfg.vixPauseThreshold.toString(),
    minSuggestionScore: cfg.minSuggestionScore.toString(),
    minMtfConfluencePct: cfg.minMtfConfluencePct.toString(),
    minAutoConfidencePct: cfg.minAutoConfidencePct.toString(),
    brokeragePerOrderInr: cfg.brokeragePerOrderInr.toString(),
    slippageBps: cfg.slippageBps.toString(),
    confidenceThresholdByRegimeJson: cfg.confidenceThresholdByRegimeJson,
    maxSameDirectionOpenPositions: cfg.maxSameDirectionOpenPositions,
    avoidFirstMinutes: cfg.avoidFirstMinutes,
    avoidMiddayStartMinute: cfg.avoidMiddayStartMinute,
    avoidMiddayEndMinute: cfg.avoidMiddayEndMinute,
    weeklyLossLimitPct: cfg.weeklyLossLimitPct.toString(),
    rollingDrawdownPct: cfg.rollingDrawdownPct.toString(),
    paperTradingEnabled: cfg.paperTradingEnabled,
    upstoxApiKey: cfg.upstoxApiKey,
    upstoxApiSecret: protectSecret(cfg.upstoxApiSecret),
    upstoxRedirectUri: cfg.upstoxRedirectUri,
    stopLossMode: cfg.stopLossMode,
    updatedAt: new Date(),
  };
}

function toDbUpdateValues(cfg: TradingConfig): Partial<typeof tradingConfigTable.$inferInsert> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars, unused-imports/no-unused-vars
  const { id, ...values } = toDbValues(cfg);
  return values;
}export async function initConfigFromDb(): Promise<TradingConfig> {
  try {
    const [row] = await db
      .select()
      .from(tradingConfigTable)
      .where(eq(tradingConfigTable.id, 1))
      .limit(1);

    if (row) {
      return applyConfig(rowToConfig(row));
    }

    await db.insert(tradingConfigTable).values(toDbValues(_config));
    return _config;
  } catch (err) {
    logger.warn({ err }, "Config DB load failed; using environment/default config");
    return _config;
  }
}

export async function updateConfig(partial: Partial<TradingConfig>): Promise<TradingConfig> {
  const next = applyConfig(partial);

  await db
    .insert(tradingConfigTable)
    .values(toDbValues(next))
    .onConflictDoUpdate({
      target: tradingConfigTable.id,
      set: toDbUpdateValues(next),
    });

  return next;
}
