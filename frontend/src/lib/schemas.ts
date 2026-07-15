import { z } from "zod";

export const SessionStateSchema = z.object({
  session: z.enum(["OPEN", "PRE_MARKET", "POST_MARKET_SCAN", "CLOSED"]),
  phase: z.string(),
  isMarketOpen: z.boolean(),
  minutesUntilOpen: z.number().nullable(),
  opensIn: z.string().nullable(),
  marketOpenTime: z.string(),
  marketCloseTime: z.string(),
  postMarketScanWindow: z.string(),
  scanRunning: z.boolean(),
  scanMode: z.string(),
  scanMessage: z.string(),
  scanProgress: z.object({
    current: z.number(),
    total: z.number(),
  }).optional(),
  updatedAt: z.string(),
});

export const MonitoredStockSchema = z.object({
  symbol: z.string(),
  entryPrice: z.number().nullable(),
  currentPrice: z.number().nullable(),
  highOfDay: z.number(),
  lowOfDay: z.number(),
  signalGenerated: z.boolean(),
  lastCheckAt: z.string(),
});

export const SuggestionSchema = z.object({
  id: z.string(),
  symbol: z.string(),
  name: z.string(),
  exchange: z.string(),
  direction: z.enum(["BUY", "SELL"]),
  tradeType: z.string(),
  entryPrice: z.number(),
  stopLoss: z.number(),
  target1: z.number(),
  target2: z.number().nullable(),
  riskReward: z.number().nullable(),
  quantity: z.number().nullable(),
  maxRiskInr: z.number().nullable(),
  stopDistancePct: z.number().nullable(),
  setupType: z.string(),
  marketRegime: z.string(),
  reasoning: z.string(),
  validityTill: z.string(),
  expectedHoldMinutes: z.number().nullable().optional(),
  expiresAt: z.string().nullable().optional(),
  status: z.string(),
  outcomePrice: z.number().nullable(),
  pnlInr: z.number().nullable(),
  currentPrice: z.number().nullable(),
  generatedAt: z.string(),
  closedAt: z.string().nullable(),
   
  signalFactors: z.any().nullable().optional(),
});

export const MarketRegimeSchema = z.object({
  regime: z.string(),
  sessionPhase: z.string(),
  isMarketOpen: z.boolean(),
  indiaVix: z.number().nullable(),
  niftyChange: z.number().nullable(),
  sectorBreadth: z.number().optional(),
  momentum: z.number().optional(),
  suggestionsPaused: z.boolean(),
  pauseReason: z.string().nullable(),
  decisionReason: z.string(),
});

export type SessionState = z.infer<typeof SessionStateSchema>;
export type MonitoredStock = z.infer<typeof MonitoredStockSchema>;
export type Suggestion = z.infer<typeof SuggestionSchema>;
export type MarketRegime = z.infer<typeof MarketRegimeSchema>;

export const PaperAccountSchema = z.object({
  id: z.string().or(z.number()),
  userId: z.string().optional(),
  balance: z.string(),
  startingBalance: z.string().optional(),
  allocatedMargin: z.string().optional(),
  livePnl: z.string().optional(),
  equity: z.string().optional(),
  currency: z.string().optional(),
  createdAt: z.string().optional(),
});

export const PaperOrderSchema = z.object({
  id: z.string(),
  symbol: z.string(),
  direction: z.string(),
  quantity: z.number(),
  price: z.string(),
  status: z.string(),
  createdAt: z.string(),
});

export type PaperAccount = z.infer<typeof PaperAccountSchema>;
export type PaperOrder = z.infer<typeof PaperOrderSchema>;
