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
  // Minimum average daily traded VALUE (₹). Share count alone admits penny
  // stocks (₹5 × 500k shares = ₹25L — unfillable without moving the price).
  // 5 crore matches MIN_TURNOVER in scripts/research_meanrev.ts.
  minDailyTurnoverInr: number;
  // Hard regime gate: block BUY in TRENDING_DOWN and SELL in TRENDING_UP at
  // ANY VIX level (legacy behavior only gated when VIX > 18). Counter-trend
  // entries are the classic bleed in a directional market.
  strictRegimeGate: boolean;
  // Max NEW suggestions inserted per trading day. Discovery lists 20+ deep are
  // for scanning; a trade list is 2-3 high-conviction names.
  maxSuggestionsPerDay: number;
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
  maxDeployedCapitalPct: number;
  paperTradingEnabled: boolean;
  // "PAPER" (default) — fills simulated only. "LIVE" — every engine fill is
  // mirrored to the broker as a real order. Both flags must agree for live:
  // tradingMode === "LIVE" AND paperTradingEnabled === false.
  tradingMode: "PAPER" | "LIVE";
  upstoxApiKey: string;
  upstoxApiSecret: string;
  upstoxDataApiKey: string;
  upstoxDataApiSecret: string;
  useDualApiKeys: boolean;
  upstoxRedirectUri: string;
  discordWebhookUrl: string;
  telegramBotToken: string;
  telegramChatId: string;
  stopLossMode: string;
}

export const defaultConfig: TradingConfig = {
  tradingCapital: 10000,
  // 1% of capital risked per trade (was 1.5%). Survival math: at 1% a 10-loss
  // streak draws down ~10%; at 1.5% the same streak is ~14% and needs a 16%
  // gain to recover. DB row overrides this default.
  maxRiskPerTradePct: 1.0,
  maxDailyLossPct: 3.0,
  maxOpenPositions: 5,
  maxSectorExposure: 2,
  minRiskReward: 1.8,
  minDailyVolume: 500000,
  minDailyTurnoverInr: 50_000_000, // ₹5 crore
  strictRegimeGate: true,
  maxSuggestionsPerDay: 5,
  vixPauseThreshold: 22,
  minSuggestionScore: 7.5,  // Raised to enforce high quality setups only
  minMtfConfluencePct: 75,   // Raised for strong multi-timeframe alignment
  minAutoConfidencePct: 80,  // Raised for higher AI conviction
  brokeragePerOrderInr: 20,
  slippageBps: 5,
  confidenceThresholdByRegimeJson: '{"TRENDING_UP":70,"TRENDING_DOWN":70,"RANGING":74,"VOLATILE":78,"UNKNOWN":72}',
  maxSameDirectionOpenPositions: 2,
  avoidFirstMinutes: 10,
  avoidMiddayStartMinute: 150, // 11:45 IST (from 09:15)
  avoidMiddayEndMinute: 225,   // 13:00 IST
  weeklyLossLimitPct: 6,
  rollingDrawdownPct: 8,
  maxDeployedCapitalPct: 90,
  paperTradingEnabled: true,
  tradingMode: "PAPER",
  upstoxApiKey: process.env["UPSTOX_API_KEY"] ?? "",
  upstoxApiSecret: process.env["UPSTOX_API_SECRET"] ?? "",
  upstoxDataApiKey: process.env["UPSTOX_DATA_API_KEY"] ?? "",
  upstoxDataApiSecret: process.env["UPSTOX_DATA_API_SECRET"] ?? "",
  useDualApiKeys: false,
  upstoxRedirectUri: (() => {
    if (process.env["UPSTOX_REDIRECT_URI"]) return process.env["UPSTOX_REDIRECT_URI"];
    // Auto-derive from Replit dev domain when running in Replit
    const devDomain = process.env["REPLIT_DEV_DOMAIN"];
    if (devDomain) return `https://${devDomain}/api/system/auth-callback`;
    return "http://localhost:5000/api/system/auth-callback";
  })(),
  discordWebhookUrl: "",
  telegramBotToken: "",
  telegramChatId: "",
  stopLossMode: "FIXED",
};

let _config: TradingConfig = { ...defaultConfig };

export function getConfig(): TradingConfig {
  return { ..._config };
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
  const rawCap = numberOrDefault(row.tradingCapital, defaultConfig.tradingCapital);
  // CRITICAL FIX (Issue #5): Removed arbitrary capital override logic
  // Previously reset capital to 10000 if it was 500000, 100000, or > 50000
  // This caused silent data corruption without user consent
  const tradingCapital = rawCap;
  
  logger.debug({ tradingCapital, rawValue: row.tradingCapital }, "Loaded trading capital from config");
  
  return {
    tradingCapital,
    maxRiskPerTradePct: numberOrDefault(row.maxRiskPerTradePct, defaultConfig.maxRiskPerTradePct),
    maxDailyLossPct: numberOrDefault(row.maxDailyLossPct, defaultConfig.maxDailyLossPct),
    maxOpenPositions: row.maxOpenPositions ?? defaultConfig.maxOpenPositions,
    maxSectorExposure: row.maxSectorExposure ?? defaultConfig.maxSectorExposure,
    minRiskReward: numberOrDefault(row.minRiskReward, defaultConfig.minRiskReward),
    minDailyVolume: row.minDailyVolume ?? defaultConfig.minDailyVolume,
    // Not DB-persisted (no column yet) — override via MIN_DAILY_TURNOVER_INR env
    minDailyTurnoverInr: numberOrDefault(process.env["MIN_DAILY_TURNOVER_INR"], defaultConfig.minDailyTurnoverInr),
    strictRegimeGate: process.env["STRICT_REGIME_GATE"] !== "false",
    maxSuggestionsPerDay: numberOrDefault(process.env["MAX_SUGGESTIONS_PER_DAY"], defaultConfig.maxSuggestionsPerDay),
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
    maxDeployedCapitalPct: numberOrDefault(row.maxDeployedCapitalPct, defaultConfig.maxDeployedCapitalPct),
    paperTradingEnabled: row.paperTradingEnabled ?? defaultConfig.paperTradingEnabled,
    tradingMode: row.tradingMode === "LIVE" ? "LIVE" : "PAPER",
    upstoxApiKey: row.upstoxApiKey ?? defaultConfig.upstoxApiKey,
    // MEDIUM FIX (Issue #23): Handle empty strings properly when revealing secrets
    upstoxApiSecret: row.upstoxApiSecret && row.upstoxApiSecret.length > 0 ? revealSecret(row.upstoxApiSecret) : defaultConfig.upstoxApiSecret,
    upstoxDataApiKey: row.upstoxDataApiKey ?? defaultConfig.upstoxDataApiKey,
    upstoxDataApiSecret: row.upstoxDataApiSecret && row.upstoxDataApiSecret.length > 0 ? revealSecret(row.upstoxDataApiSecret) : defaultConfig.upstoxDataApiSecret,
    useDualApiKeys: row.useDualApiKeys ?? defaultConfig.useDualApiKeys,
    upstoxRedirectUri: row.upstoxRedirectUri ?? defaultConfig.upstoxRedirectUri,
    discordWebhookUrl: row.discordWebhookUrl ?? defaultConfig.discordWebhookUrl,
    telegramBotToken: row.telegramBotToken && row.telegramBotToken.length > 0 ? revealSecret(row.telegramBotToken) : defaultConfig.telegramBotToken,
    telegramChatId: row.telegramChatId ?? defaultConfig.telegramChatId,
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
    maxDeployedCapitalPct: cfg.maxDeployedCapitalPct.toString(),
    paperTradingEnabled: cfg.paperTradingEnabled,
    tradingMode: cfg.tradingMode,
    upstoxApiKey: cfg.upstoxApiKey,
    upstoxApiSecret: protectSecret(cfg.upstoxApiSecret),
    upstoxDataApiKey: cfg.upstoxDataApiKey,
    upstoxDataApiSecret: protectSecret(cfg.upstoxDataApiSecret),
    useDualApiKeys: cfg.useDualApiKeys,
    upstoxRedirectUri: cfg.upstoxRedirectUri,
    discordWebhookUrl: cfg.discordWebhookUrl,
    telegramBotToken: protectSecret(cfg.telegramBotToken),
    telegramChatId: cfg.telegramChatId,
    stopLossMode: cfg.stopLossMode,
    updatedAt: new Date(),
  };
}

function toDbUpdateValues(cfg: TradingConfig): Partial<typeof tradingConfigTable.$inferInsert> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars, unused-imports/no-unused-vars
  const { id, ...values } = toDbValues(cfg);
  return values;
}

export async function initConfigFromDb(): Promise<TradingConfig> {
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

let configUpdatePromise = Promise.resolve();

export async function updateConfig(partial: Partial<TradingConfig>): Promise<TradingConfig> {
  let resolveLock: () => void;
  const nextLock = new Promise<void>(res => { resolveLock = res; });
  const currentLock = configUpdatePromise;
  configUpdatePromise = nextLock;
  
  await currentLock;
  
  // CRITICAL FIX (Issue #4): Only resolve lock after successful DB write
  // Previously, resolveLock was called in finally block even on errors,
  // causing lost updates when retries happened
  try {
    const next = applyConfig(partial);

    await db
      .insert(tradingConfigTable)
      .values(toDbValues(next))
      .onConflictDoUpdate({
        target: tradingConfigTable.id,
        set: toDbUpdateValues(next),
      });

    // Success - release lock and return
    resolveLock!();
    return { ...next };
  } catch (err) {
    // Error - release lock to prevent deadlock, but log the failure
    logger.error({ err }, "Config update failed - lock released but update lost");
    resolveLock!();
    throw err; // Re-throw to notify caller
  }
}
