/**
 * Typed WebSocket event schemas with Zod validation
 * Ensures type safety for all server-to-client and client-to-server messages
 */
import { z } from "zod";
import { Packr } from "msgpackr";
import { logger } from "../lib/logger";

export const packr = new Packr({
  useRecords: false,
});

export const NewSuggestionEventSchema = z.object({
  event: z.literal("new_suggestion"),
  data: z.object({
    id: z.string().uuid(),
    symbol: z.string(),
    direction: z.enum(["BUY", "SELL"]),
    entryPrice: z.number(),
    stopLoss: z.number(),
    target1: z.number(),
    setupType: z.string(),
    riskReward: z.number(),
    scanSessionId: z.string().optional(),
     
    signalFactors: z.record(z.any()).optional(),
  }),
});
export type NewSuggestionEvent = z.infer<typeof NewSuggestionEventSchema>;

export const SuggestionUpdatedEventSchema = z.object({
  event: z.literal("suggestion_updated"),
  data: z.object({
    id: z.string().uuid(),
    status: z.string(),
    pnlInr: z.number().nullable().optional(),
    outcomePrice: z.number().optional(),
     
    aiEnrichment: z.record(z.any()).optional(),
  }),
});
export type SuggestionUpdatedEvent = z.infer<typeof SuggestionUpdatedEventSchema>;

export const MarketRegimeChangedEventSchema = z.object({
  event: z.literal("market_regime_changed"),
  data: z.object({
    regime: z.enum(["TRENDING_UP", "TRENDING_DOWN", "VOLATILE", "RANGING", "UNKNOWN"]),
    detailedRegime: z.string().optional(),
    confidence: z.number().optional(),
    volatility: z.string().optional(),
    strength: z.number().optional(),
    indiaVix: z.number().nullable(),
    niftyChange: z.number().nullable(),
    sectorBreadth: z.number().optional(),
    momentum: z.number().optional(),
    suggestionsPaused: z.boolean(),
    pauseReason: z.string().nullable(),
  }),
});
export type MarketRegimeChangedEvent = z.infer<typeof MarketRegimeChangedEventSchema>;

export const DailyLossLimitReachedEventSchema = z.object({
  event: z.literal("daily_loss_limit_reached"),
  data: z.object({
    totalDailyLoss: z.number(),
    limit: z.number(),
  }),
});
export type DailyLossLimitReachedEvent = z.infer<typeof DailyLossLimitReachedEventSchema>;

export const SystemAlertEventSchema = z.object({
  event: z.literal("system_alert"),
  data: z.object({
    message: z.string(),
    severity: z.enum(["info", "warning", "error"]).optional(),
    timestamp: z.string().datetime().optional(),
  }),
});
export type SystemAlertEvent = z.infer<typeof SystemAlertEventSchema>;

export const PongEventSchema = z.object({
  event: z.literal("pong"),
  data: z.record(z.unknown()).optional(),
});
export type PongEvent = z.infer<typeof PongEventSchema>;

export const ScanStartedEventSchema = z.object({
  event: z.literal("scan_started"),
  data: z.object({
    stocksToAnalyze: z.number(),
    timestamp: z.string(),
    scanSessionId: z.string().optional(),
  }),
});
export type ScanStartedEvent = z.infer<typeof ScanStartedEventSchema>;

export const ScanProgressEventSchema = z.object({
  event: z.literal("scan_progress"),
  data: z.object({
    current: z.number(),
    total: z.number(),
    currentStock: z.string().optional(),
    status: z.enum(["ANALYZING", "PASSED", "FAILED", "NEW_SUGGESTION", "REJECTED", "STOPPED"]).optional(),
    reason: z.string().optional(),
    scanSessionId: z.string().optional(),
  }),
});
export type ScanProgressEvent = z.infer<typeof ScanProgressEventSchema>;

export const ScanCompletedEventSchema = z.object({
  event: z.literal("scan_completed"),
  data: z.object({
    suggestionsGenerated: z.number(),
    duration: z.number(),
    scanSessionId: z.string().optional(),
    outcome: z.enum(["COMPLETED", "FAILED", "STOPPED"]).optional(),
    message: z.string().optional(),
  }),
});
export type ScanCompletedEvent = z.infer<typeof ScanCompletedEventSchema>;

export const TickUpdateEventSchema = z.object({
  event: z.literal("tick_update"),
  data: z.array(
    z.object({
      symbol: z.string(),
      price: z.number(),
      volume: z.number(),
      bid: z.number().nullable().optional(),
      ask: z.number().nullable().optional(),
      timestamp: z.string().datetime(),
    }),
  ),
});
export type TickUpdateEvent = z.infer<typeof TickUpdateEventSchema>;

export const MonitoringUpdateEventSchema = z.object({
  event: z.literal("monitoring_update"),
  data: z.object({
    active: z.boolean(),
    monitoredStocks: z.array(
      z.object({
        symbol: z.string(),
        entryPrice: z.number().nullable(),
        currentPrice: z.number().nullable(),
        highOfDay: z.number(),
        lowOfDay: z.number(),
        signalGenerated: z.boolean(),
        lastCheckAt: z.string(),
      })
    ),
    monitoredStocksCount: z.number().optional(),
    lastMonitoringCycle: z.string().nullable(),
    monitoringMaxStocks: z.number().optional(),
    maxLimit: z.number().optional(),
  }),
});
export type MonitoringUpdateEvent = z.infer<typeof MonitoringUpdateEventSchema>;

export const MarketIntelligenceUpdateEventSchema = z.object({
  event: z.literal("market_intelligence_update"),
  data: z.object({
    snapshot: z.object({
      status: z.string(),
      universeSize: z.number(),
      marketStates: z.number(),
      activeCandidates: z.number(),
      qualifiedOpportunities: z.number(),
      activeSuggestions: z.number(),
      startedAt: z.string().nullable(),
      updatedAt: z.string(),
    }),
    topMovers: z.array(
      z.object({
        symbol: z.string(),
        ltp: z.number(),
        changePct: z.number(),
        volume: z.number(),
      }),
    ),
    suggestions: z.array(
      z.object({
        id: z.string(),
        symbol: z.string(),
        direction: z.enum(["BUY", "SELL"]),
        setup: z.string(),
        confidence: z.number(),
        entry: z.number(),
        stopLoss: z.number(),
        target: z.number(),
        riskReward: z.number(),
        expiresAt: z.number(),
      }),
    ),
    breadth: z
      .object({
        advancers: z.number(),
        decliners: z.number(),
        newHighs: z.number(),
        newLows: z.number(),
        regime: z.string(),
        updatedAt: z.number(),
      })
      .nullable(),
  }),
});
export type MarketIntelligenceUpdateEvent = z.infer<typeof MarketIntelligenceUpdateEventSchema>;

export const PositionUpdateEventSchema = z.object({
  event: z.literal("position_update"),
  data: z.object({
    id: z.string().uuid(),
    symbol: z.string(),
    entryPrice: z.number(),
    stopLoss: z.number(),
    target1: z.number(),
    direction: z.enum(["BUY", "SELL"]),
    mode: z.string(),
  }),
});
export type PositionUpdateEvent = z.infer<typeof PositionUpdateEventSchema>;


export const SessionStateChangedEventSchema = z.object({
  event: z.literal("session_state_changed"),
  data: z.object({
    session: z.string(),
    phase: z.string(),
    minutesUntilOpen: z.number().nullable(),
    opensIn: z.string().nullable(),
  }),
});
export type SessionStateChangedEvent = z.infer<typeof SessionStateChangedEventSchema>;

export const IndicesUpdateEventSchema = z.object({
  event: z.literal("indices_update"),
  data: z.object({
    nifty: z.object({ ltp: z.number().nullable(), changePct: z.number().nullable() }).optional(),
    banknifty: z.object({ ltp: z.number().nullable(), changePct: z.number().nullable() }).optional(),
    finnifty: z.object({ ltp: z.number().nullable(), changePct: z.number().nullable() }).optional(),
    sensex: z.object({ ltp: z.number().nullable(), changePct: z.number().nullable() }).optional(),
    vix: z.object({ ltp: z.number().nullable(), changePct: z.number().nullable() }).optional(),
  }),
});
export type IndicesUpdateEvent = z.infer<typeof IndicesUpdateEventSchema>;

export const WatchlistCountsEventSchema = z.object({
  event: z.literal("watchlist_counts"),
  data: z.record(z.number()),
});
export type WatchlistCountsEvent = z.infer<typeof WatchlistCountsEventSchema>;

export const ServerEventSchema = z.discriminatedUnion("event", [
  NewSuggestionEventSchema,
  SuggestionUpdatedEventSchema,
  MarketRegimeChangedEventSchema,
  DailyLossLimitReachedEventSchema,
  SystemAlertEventSchema,
  ScanStartedEventSchema,
  ScanProgressEventSchema,
  ScanCompletedEventSchema,
  TickUpdateEventSchema,
  PongEventSchema,
  MonitoringUpdateEventSchema,
  MarketIntelligenceUpdateEventSchema,
  PositionUpdateEventSchema,
  SessionStateChangedEventSchema,
  IndicesUpdateEventSchema,
  WatchlistCountsEventSchema,
]);
export type ServerEvent = z.infer<typeof ServerEventSchema>;

/**
 * â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
 * CLIENT â†’ SERVER EVENTS
 * â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
 */

export const PingEventSchema = z.object({
  event: z.literal("ping"),
  data: z.record(z.unknown()).optional(),
});
export type PingEvent = z.infer<typeof PingEventSchema>;

export const SubscribeEventSchema = z.object({
  event: z.literal("subscribe"),
  data: z.object({
    topic: z.string(),
  }),
});
export type SubscribeEvent = z.infer<typeof SubscribeEventSchema>;

export const UnsubscribeEventSchema = z.object({
  event: z.literal("unsubscribe"),
  data: z.object({
    topic: z.string(),
  }),
});
export type UnsubscribeEvent = z.infer<typeof UnsubscribeEventSchema>;

export const SubscribeSymbolEventSchema = z.object({
  event: z.literal("subscribe_symbol"),
  data: z.object({
    symbol: z.string(),
  }),
});
export type SubscribeSymbolEvent = z.infer<typeof SubscribeSymbolEventSchema>;
export const UnsubscribeSymbolEventSchema = z.object({
  event: z.literal("unsubscribe_symbol"),
  data: z.object({
    symbol: z.string(),
  }),
});
export type UnsubscribeSymbolEvent = z.infer<typeof UnsubscribeSymbolEventSchema>;

export const SubscribeSymbolsEventSchema = z.object({
  event: z.literal("subscribe_symbols"),
  data: z.object({
    symbols: z.array(z.string()),
  }),
});
export type SubscribeSymbolsEvent = z.infer<typeof SubscribeSymbolsEventSchema>;

export const SubscribeWatchlistEventSchema = z.object({
  event: z.literal("subscribe_watchlist"),
  data: z.object({
    symbols: z.array(z.string()),
  }),
});
export type SubscribeWatchlistEvent = z.infer<typeof SubscribeWatchlistEventSchema>;

export const AuthEventSchema = z.object({
  event: z.literal("auth"),
  data: z.object({
    token: z.string(),
  }),
});
export type AuthEvent = z.infer<typeof AuthEventSchema>;

export const ClientEventSchema = z.discriminatedUnion("event", [
  PingEventSchema,
  SubscribeEventSchema,
  UnsubscribeEventSchema,
  SubscribeSymbolEventSchema,
  UnsubscribeSymbolEventSchema,
  SubscribeSymbolsEventSchema,
  SubscribeWatchlistEventSchema,
  AuthEventSchema,
]);
export type ClientEvent = z.infer<typeof ClientEventSchema>;

/**
 * Parse and validate a client event from JSON or MsgPack
 * Returns null if parsing fails
 */
export function parseClientEvent(raw: string | Buffer | Uint8Array): ClientEvent | null {
  try {
    let parsed;
    if (typeof raw === "string") {
      parsed = JSON.parse(raw);
    } else {
      parsed = packr.unpack(raw);
    }
    return ClientEventSchema.parse(parsed);
  } catch (err) {
    logger.warn({ err }, "Suppressed error: failed to parse ClientEvent");
    return null;
  }
}

/**
 * Helper to create strongly-typed server events
 */
export const createServerEvent = {
  newSuggestion: (data: NewSuggestionEvent["data"]): NewSuggestionEvent => ({
    event: "new_suggestion",
    data,
  }),
  suggestionUpdated: (data: SuggestionUpdatedEvent["data"]): SuggestionUpdatedEvent => ({
    event: "suggestion_updated",
    data,
  }),
  marketRegimeChanged: (data: MarketRegimeChangedEvent["data"]): MarketRegimeChangedEvent => ({
    event: "market_regime_changed",
    data,
  }),
  dailyLossLimitReached: (data: DailyLossLimitReachedEvent["data"]): DailyLossLimitReachedEvent => ({
    event: "daily_loss_limit_reached",
    data,
  }),
  systemAlert: (data: SystemAlertEvent["data"]): SystemAlertEvent => ({
    event: "system_alert",
    data,
  }),
  pong: (): PongEvent => ({
    event: "pong",
  }),
  scanStarted: (data: ScanStartedEvent["data"]): ScanStartedEvent => ({
    event: "scan_started",
    data,
  }),
  scanProgress: (data: ScanProgressEvent["data"]): ScanProgressEvent => ({
    event: "scan_progress",
    data,
  }),
  scanCompleted: (data: ScanCompletedEvent["data"]): ScanCompletedEvent => ({
    event: "scan_completed",
    data,
  }),
  tickUpdate: (data: TickUpdateEvent["data"]): TickUpdateEvent => ({
    event: "tick_update",
    data,
  }),
  monitoringUpdate: (data: MonitoringUpdateEvent["data"]): MonitoringUpdateEvent => ({
    event: "monitoring_update",
    data,
  }),
  marketIntelligenceUpdate: (
    data: MarketIntelligenceUpdateEvent["data"],
  ): MarketIntelligenceUpdateEvent => ({
    event: "market_intelligence_update",
    data,
  }),
  positionUpdate: (data: PositionUpdateEvent["data"]): PositionUpdateEvent => ({
    event: "position_update",
    data,
  }),
  sessionStateChanged: (
    session: string,
    phase: string,
    minutesUntilOpen: number | null,
    opensIn: string | null
  ): SessionStateChangedEvent => ({
    event: "session_state_changed",
    data: { session, phase, minutesUntilOpen, opensIn },
  }),
  indicesUpdate: (data: IndicesUpdateEvent["data"]): IndicesUpdateEvent => ({
    event: "indices_update",
    data,
  }),
  watchlistCounts: (counts: Record<string, number>): WatchlistCountsEvent => ({
    event: "watchlist_counts",
    data: counts,
  }),
};
