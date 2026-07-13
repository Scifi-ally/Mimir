import Redis from "ioredis";
import axios from "axios";
import { getConfig } from "../config";
import { logger } from "../lib/logger";

const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
const redis = new Redis(redisUrl);

const ALERTS_LIST_KEY = "mimir:alerts:history";
const ALERTS_PUBSUB_CHANNEL = "mimir:alerts:pubsub";

export interface AlertEvent {
  id: string;
  timestamp: string;
  symbol: string;
  message: string;
  type: "MTF" | "RSI" | "VWAP" | "SCORE";
}

// Store previous state in memory for fast transition detection during intraday scans
const previousState = new Map<string, {
  mtfScore?: number;
  rsi?: number;
  vwapStatus?: "above" | "below";
  compositeScore?: number;
}>();

import { randomUUID } from "crypto";

export async function detectAlerts(
  symbol: string,
  currentState: {
    mtfScore?: number;
    mtfDesc?: string;
    rsi?: number;
    close?: number;
    vwap?: number;
    compositeScore?: number;
  }
) {
  const prev = previousState.get(symbol) || {};
  const alerts: AlertEvent[] = [];
  const now = new Date().toISOString();
  
  // 1. MTF Confluence Change
  if (currentState.mtfScore !== undefined) {
    if (prev.mtfScore !== undefined && prev.mtfScore !== currentState.mtfScore) {
      alerts.push({
        id: randomUUID(),
        timestamp: now,
        symbol,
        message: `MTF flipped to ${currentState.mtfDesc || `${currentState.mtfScore}/3 ALIGN`}`,
        type: "MTF"
      });
    }
  }

  // 2. RSI crossing thresholds (Bullish > 60, Bearish < 40)
  if (currentState.rsi !== undefined && prev.rsi !== undefined) {
    if (prev.rsi <= 60 && currentState.rsi > 60) {
      alerts.push({ id: randomUUID(), timestamp: now, symbol, message: `RSI crossed bullish threshold (60)`, type: "RSI" });
    } else if (prev.rsi >= 40 && currentState.rsi < 40) {
      alerts.push({ id: randomUUID(), timestamp: now, symbol, message: `RSI crossed bearish threshold (40)`, type: "RSI" });
    }
  }

  // 3. VWAP Support Gained/Lost
  if (currentState.close !== undefined && currentState.vwap !== undefined) {
    const currentVwapStatus = currentState.close > currentState.vwap ? "above" : "below";
    if (prev.vwapStatus !== undefined && prev.vwapStatus !== currentVwapStatus) {
      alerts.push({
        id: randomUUID(),
        timestamp: now,
        symbol,
        message: currentVwapStatus === "above" ? "Gained VWAP Support" : "Lost VWAP Support",
        type: "VWAP"
      });
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (currentState as any).vwapStatus = currentVwapStatus;
  }

  // 4. Composite Score crossing 65 (Green) or 40 (Red)
  if (currentState.compositeScore !== undefined && prev.compositeScore !== undefined) {
    if (prev.compositeScore < 65 && currentState.compositeScore >= 65) {
      alerts.push({ id: randomUUID(), timestamp: now, symbol, message: `Composite Score surged into Green (>65)`, type: "SCORE" });
    } else if (prev.compositeScore >= 40 && currentState.compositeScore < 40) {
      alerts.push({ id: randomUUID(), timestamp: now, symbol, message: `Composite Score dropped into Red (<40)`, type: "SCORE" });
    }
  }

  // Update previous state
  previousState.set(symbol, {
    mtfScore: currentState.mtfScore ?? prev.mtfScore,
    rsi: currentState.rsi ?? prev.rsi,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vwapStatus: (currentState as any).vwapStatus ?? prev.vwapStatus,
    compositeScore: currentState.compositeScore ?? prev.compositeScore
  });

  // Publish alerts
  for (const alert of alerts) {
    try {
      const alertStr = JSON.stringify(alert);
      await redis.lpush(ALERTS_LIST_KEY, alertStr);
      await redis.ltrim(ALERTS_LIST_KEY, 0, 199);
      await redis.publish(ALERTS_PUBSUB_CHANNEL, alertStr);
      logger.info(`[Alert] ${symbol}: ${alert.message}`);

      // Dispatch Webhooks
      const config = getConfig();
      if (config.discordWebhookUrl) {
        axios.post(config.discordWebhookUrl, {
          content: `**[Mimir Alert] ${symbol}**: ${alert.message}`
        }).catch(err => logger.error({ err }, "Failed to send Discord webhook"));
      }

      if (config.telegramBotToken && config.telegramChatId) {
        axios.post(`https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`, {
          chat_id: config.telegramChatId,
          text: `<b>[Mimir Alert] ${symbol}</b>: ${alert.message}`,
          parse_mode: "HTML"
        }).catch(err => logger.error({ err }, "Failed to send Telegram webhook"));
      }

    } catch (err) {
      logger.error({ err }, "Failed to publish alert");
    }
  }
}

export async function getAlertHistory(): Promise<AlertEvent[]> {
  try {
    const events = await redis.lrange(ALERTS_LIST_KEY, 0, 199);
    return events.map((e: string) => JSON.parse(e));
  } catch (err) {
    logger.error({ err }, "Failed to get alert history");
    return [];
  }
}
