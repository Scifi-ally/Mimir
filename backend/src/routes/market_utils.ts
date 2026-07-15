import { createUpstoxClient } from "../lib/upstox-client";
import { getLastCompletedTradingDayStr, shiftISTDateStr } from "../lib/ist-time";
import { logger } from "../lib/logger";
import type { StockSector } from "../analysis/stock_scanner";

export const upstoxClient = createUpstoxClient({ cacheTimeMs: 15_000 });

export const INDEX_KEY_CANDIDATES = {
  nifty50: ["NSE_INDEX|Nifty 50"],
  sensex: ["BSE_INDEX|SENSEX", "BSE_INDEX|Sensex"],
  bankNifty: ["NSE_INDEX|Nifty Bank", "NSE_INDEX|NIFTY BANK"],
  finnifty: ["NSE_INDEX|Nifty Fin Service", "NSE_INDEX|NIFTY FIN SERVICE"],
  indiaVix: ["NSE_INDEX|India VIX"],
} as const;

export const INDEX_SYMBOL_ALIAS: Record<string, keyof typeof INDEX_KEY_CANDIDATES> = {
  NIFTY: "nifty50",
  "NIFTY50": "nifty50",
  SENSEX: "sensex",
  BANK: "bankNifty",
  BANKNIFTY: "bankNifty",
  FINNIFTY: "finnifty",
  VIX: "indiaVix",
  INDIAVIX: "indiaVix",
};

export function resolveIndexAsStock(rawSymbol: string) {
  const cleanSym = rawSymbol.replace(/\s+/g, "").toUpperCase();
  let indexKey = null;
  let symbolLabel = rawSymbol;

  if (INDEX_SYMBOL_ALIAS[cleanSym]) {
    indexKey = INDEX_KEY_CANDIDATES[INDEX_SYMBOL_ALIAS[cleanSym]][0];
    symbolLabel = rawSymbol;
  } else if (INDEX_SYMBOL_ALIAS[rawSymbol]) {
    indexKey = INDEX_KEY_CANDIDATES[INDEX_SYMBOL_ALIAS[rawSymbol]][0];
    symbolLabel = rawSymbol;
  } else if (rawSymbol === "INDIA VIX" || cleanSym === "INDIAVIX") {
    indexKey = INDEX_KEY_CANDIDATES.indiaVix[0];
    symbolLabel = "INDIA VIX";
  } else if (rawSymbol === "NIFTY 50" || cleanSym === "NIFTY50") {
    indexKey = INDEX_KEY_CANDIDATES.nifty50[0];
    symbolLabel = "NIFTY 50";
  }

  if (indexKey) {
    return {
      symbol: symbolLabel,
      key: indexKey,
      name: symbolLabel,
      sector: "INDEX" as StockSector,
    };
  }
  return null;
}

export const CANDLE_INTERVALS = [
  "1minute",
  "5minute",
  "15minute",
  "60minute",
  "240minute",
  "day",
  "week",
] as const;

export type CandleInterval = (typeof CANDLE_INTERVALS)[number];

export function isCandleInterval(value: string): value is CandleInterval {
  return (CANDLE_INTERVALS as readonly string[]).includes(value);
}

export async function fetchIndexPrevClose(
  key: string,
  token: string,
): Promise<number | null> {
  try {
    const toDate = getLastCompletedTradingDayStr(new Date());
    const fromDate = shiftISTDateStr(toDate, -7);
    const candles = await upstoxClient.fetchHistoricalCandles(
      key,
      "day",
      toDate,
      fromDate,
      token,
    );
    if (!candles.length) return null;
    const row = candles[0] as [string, number, number, number, number, number];
    const close = Number(row[4]);
    return Number.isFinite(close) && close > 0 ? close : null;
  } catch (err: unknown) {
    logger.error({ err, key }, "Failed to fetch index previous close");
    return null;
  }
}
