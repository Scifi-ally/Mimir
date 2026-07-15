import { Router } from "express";
import { getConfig, updateConfig } from "../config";
import { UpdateConfigBody } from "../schemas";

const router = Router();
const SECRET_MASK = "********";

function serializeConfig(cfg: ReturnType<typeof getConfig>, reveal = false) {
  return {
    tradingCapital: cfg.tradingCapital,
    maxRiskPerTradePct: cfg.maxRiskPerTradePct,
    maxDailyLossPct: cfg.maxDailyLossPct,
    maxOpenPositions: cfg.maxOpenPositions,
    maxSectorExposure: cfg.maxSectorExposure,
    minRiskReward: cfg.minRiskReward,
    minDailyVolume: cfg.minDailyVolume,
    vixPauseThreshold: cfg.vixPauseThreshold,
    minSuggestionScore: cfg.minSuggestionScore,
    minMtfConfluencePct: cfg.minMtfConfluencePct,
    minAutoConfidencePct: cfg.minAutoConfidencePct,
    brokeragePerOrderInr: cfg.brokeragePerOrderInr,
    slippageBps: cfg.slippageBps,
    confidenceThresholdByRegimeJson: cfg.confidenceThresholdByRegimeJson,
    maxSameDirectionOpenPositions: cfg.maxSameDirectionOpenPositions,
    avoidFirstMinutes: cfg.avoidFirstMinutes,
    avoidMiddayStartMinute: cfg.avoidMiddayStartMinute,
    avoidMiddayEndMinute: cfg.avoidMiddayEndMinute,
    weeklyLossLimitPct: cfg.weeklyLossLimitPct,
    rollingDrawdownPct: cfg.rollingDrawdownPct,
    paperTradingEnabled: cfg.paperTradingEnabled,
    upstoxApiKey: cfg.upstoxApiKey,
    upstoxApiSecret: reveal ? (cfg.upstoxApiSecret || "") : (cfg.upstoxApiSecret ? SECRET_MASK : ""),
    upstoxDataApiKey: cfg.upstoxDataApiKey,
    upstoxDataApiSecret: reveal ? (cfg.upstoxDataApiSecret || "") : (cfg.upstoxDataApiSecret ? SECRET_MASK : ""),
    upstoxRedirectUri: cfg.upstoxRedirectUri,
    stopLossMode: cfg.stopLossMode,
    maxDeployedCapitalPct: cfg.maxDeployedCapitalPct,
    discordWebhookUrl: cfg.discordWebhookUrl,
    telegramBotToken: reveal ? (cfg.telegramBotToken || "") : (cfg.telegramBotToken ? SECRET_MASK : ""),
    telegramChatId: cfg.telegramChatId,
  };
}

// GET /api/config
router.get("/config", (req, res) => {
  const cfg = getConfig();
  const reveal = req.query.reveal === "true" || req.query.reveal === "1";
  res.json(serializeConfig(cfg, reveal));
});

// PATCH /api/config
router.patch("/config", async (req, res) => {
  const parsed = UpdateConfigBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid config data" });
    return;
  }

  try {
    const updated = await updateConfig({
      ...(parsed.data.tradingCapital != null && { tradingCapital: parsed.data.tradingCapital }),
      ...(parsed.data.maxRiskPerTradePct != null && { maxRiskPerTradePct: parsed.data.maxRiskPerTradePct }),
      ...(parsed.data.maxDailyLossPct != null && { maxDailyLossPct: parsed.data.maxDailyLossPct }),
      ...(parsed.data.maxOpenPositions != null && { maxOpenPositions: parsed.data.maxOpenPositions }),
      ...(parsed.data.maxSectorExposure != null && { maxSectorExposure: parsed.data.maxSectorExposure }),
      ...(parsed.data.minRiskReward != null && { minRiskReward: parsed.data.minRiskReward }),
      ...(parsed.data.minDailyVolume != null && { minDailyVolume: parsed.data.minDailyVolume }),
      ...(parsed.data.vixPauseThreshold != null && { vixPauseThreshold: parsed.data.vixPauseThreshold }),
      ...(parsed.data.minSuggestionScore != null && { minSuggestionScore: parsed.data.minSuggestionScore }),
      ...(parsed.data.minMtfConfluencePct != null && { minMtfConfluencePct: parsed.data.minMtfConfluencePct }),
      ...(parsed.data.minAutoConfidencePct != null && { minAutoConfidencePct: parsed.data.minAutoConfidencePct }),
      ...(parsed.data.brokeragePerOrderInr != null && { brokeragePerOrderInr: parsed.data.brokeragePerOrderInr }),
      ...(parsed.data.slippageBps != null && { slippageBps: parsed.data.slippageBps }),
      ...(parsed.data.confidenceThresholdByRegimeJson != null && { confidenceThresholdByRegimeJson: parsed.data.confidenceThresholdByRegimeJson }),
      ...(parsed.data.maxSameDirectionOpenPositions != null && { maxSameDirectionOpenPositions: parsed.data.maxSameDirectionOpenPositions }),
      ...(parsed.data.avoidFirstMinutes != null && { avoidFirstMinutes: parsed.data.avoidFirstMinutes }),
      ...(parsed.data.avoidMiddayStartMinute != null && { avoidMiddayStartMinute: parsed.data.avoidMiddayStartMinute }),
      ...(parsed.data.avoidMiddayEndMinute != null && { avoidMiddayEndMinute: parsed.data.avoidMiddayEndMinute }),
      ...(parsed.data.weeklyLossLimitPct != null && { weeklyLossLimitPct: parsed.data.weeklyLossLimitPct }),
      ...(parsed.data.rollingDrawdownPct != null && { rollingDrawdownPct: parsed.data.rollingDrawdownPct }),
      ...(parsed.data.paperTradingEnabled != null && { paperTradingEnabled: parsed.data.paperTradingEnabled }),
      ...(parsed.data.upstoxApiKey != null && { upstoxApiKey: parsed.data.upstoxApiKey }),
      ...(parsed.data.upstoxApiSecret != null &&
        parsed.data.upstoxApiSecret !== "" &&
        parsed.data.upstoxApiSecret !== SECRET_MASK && { upstoxApiSecret: parsed.data.upstoxApiSecret }),
      ...(parsed.data.upstoxDataApiKey != null && { upstoxDataApiKey: parsed.data.upstoxDataApiKey }),
      ...(parsed.data.upstoxDataApiSecret != null &&
        parsed.data.upstoxDataApiSecret !== "" &&
        parsed.data.upstoxDataApiSecret !== SECRET_MASK && { upstoxDataApiSecret: parsed.data.upstoxDataApiSecret }),
      ...(parsed.data.upstoxRedirectUri != null && { upstoxRedirectUri: parsed.data.upstoxRedirectUri }),
      ...(parsed.data.stopLossMode != null && { stopLossMode: parsed.data.stopLossMode }),
      ...(parsed.data.maxDeployedCapitalPct != null && { maxDeployedCapitalPct: parsed.data.maxDeployedCapitalPct }),
      ...(parsed.data.discordWebhookUrl != null && { discordWebhookUrl: parsed.data.discordWebhookUrl }),
      ...(parsed.data.telegramBotToken != null &&
        parsed.data.telegramBotToken !== "" &&
        parsed.data.telegramBotToken !== SECRET_MASK && { telegramBotToken: parsed.data.telegramBotToken }),
      ...(parsed.data.telegramChatId != null && { telegramChatId: parsed.data.telegramChatId }),
    });

    res.json(serializeConfig(updated));
  } catch (err) {
    req.log.error({ err }, "Failed to update config");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
