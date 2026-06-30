import type { OHLCV } from "../analysis/technical";
import type { StockSector, UniverseStock } from "../analysis/stock_scanner";

export type InstrumentKey = string;
export type Direction = "BUY" | "SELL";
export type Timeframe = "1m" | "5m" | "15m" | "30m" | "1h" | "1d";
export type ServiceHealth = "idle" | "starting" | "running" | "degraded" | "stopped";

export interface MarketTickEvent {
  instrumentKey: InstrumentKey;
  symbol: string;
  ltp: number;
  volume: number;
  bid?: number | null;
  ask?: number | null;
  timestamp: number;
}

export interface ConnectionStatusEvent {
  status: "connected" | "connecting" | "disconnected" | "reconnecting" | "failed";
  source: "upstox_ws" | "upstox_http_fallback";
  timestamp: number;
  reason?: string;
}

export interface MarketStatusEvent {
  phase: "PRE_MARKET" | "MARKET" | "POST_MARKET" | "OFF_HOURS";
  isOpen: boolean;
  timestamp: number;
}

export interface MarketState {
  instrumentKey: InstrumentKey;
  symbol: string;
  ltp: number;
  open: number;
  high: number;
  low: number;
  volume: number;
  previousVolume: number;
  percentageChange: number;
  turnover: number;
  firstSeenAt: number;
  updatedAt: number;
  sector?: StockSector;
}

export interface Candle extends OHLCV {
  instrumentKey: InstrumentKey;
  symbol: string;
  timeframe: Timeframe;
  startTime: number;
  endTime: number;
  closed: boolean;
}

export interface CandleClosedEvent {
  instrumentKey: InstrumentKey;
  symbol: string;
  timeframe: Timeframe;
  candle: Candle;
}

export interface CandidateSignal {
  instrumentKey: InstrumentKey;
  symbol: string;
  score: number;
  reasons: string[];
  state: MarketState;
  detectedAt: number;
}

export interface CandidateCreatedEvent {
  candidate: CandidateSignal;
}

export interface CandidateRemovedEvent {
  instrumentKey: InstrumentKey;
  symbol: string;
  reason: string;
  removedAt: number;
}

export interface TechnicalOpportunity {
  instrumentKey: InstrumentKey;
  symbol: string;
  direction: Direction;
  setup: string;
  score: number;
  entry: number;
  stopLoss: number;
  target: number;
  riskReward: number;
  reasoning: string[];
  qualifiedAt: number;
}

export interface OpportunityQualifiedEvent {
  opportunity: TechnicalOpportunity;
}

export interface RankedOpportunity extends TechnicalOpportunity {
  aiScore: number | null;
  compositeScore: number;
  rankReasoning: string[];
}

export interface SuggestionGeneratedEvent {
  suggestion: ActiveSuggestion;
}

export interface ActiveSuggestion {
  id: string;
  instrumentKey: InstrumentKey;
  symbol: string;
  direction: Direction;
  setup: string;
  confidence: number;
  entry: number;
  stopLoss: number;
  target: number;
  riskReward: number;
  reasoning: string[];
  generatedAt: number;
  expiresAt: number;
}

export interface BreadthSnapshot {
  advancers: number;
  decliners: number;
  newHighs: number;
  newLows: number;
  sectorStrength: Record<string, number>;
  regime: "Bullish" | "Bearish" | "Trending" | "Ranging" | "Risk-On" | "Risk-Off";
  updatedAt: number;
}

export interface IntelligenceConfig {
  maxUniverseSize: number;
  minUniverseSize: number;
  maxCandidates: number;
  maxTechnicalSymbols: number;
  maxAiOpportunities: number;
  candleBufferSize: number;
  frontendFlushMs: number;
}

export interface IntelligenceSnapshot {
  status: ServiceHealth;
  universeSize: number;
  marketStates: number;
  activeCandidates: number;
  qualifiedOpportunities: number;
  activeSuggestions: number;
  breadth: BreadthSnapshot | null;
  startedAt: string | null;
  updatedAt: string;
}

export interface InternalEvents {
  marketTick: MarketTickEvent;
  processedTick: MarketTickEvent;
  connectionStatus: ConnectionStatusEvent;
  marketStatus: MarketStatusEvent;
  candleClosed: CandleClosedEvent;
  candidateCreated: CandidateCreatedEvent;
  candidateRemoved: CandidateRemovedEvent;
  opportunityQualified: OpportunityQualifiedEvent;
  suggestionGenerated: SuggestionGeneratedEvent;
  breadthUpdated: BreadthSnapshot;
  universeUpdated: UniverseStock[];
  dailyLossLimitReached: { lossAmount: number; limitAmount: number };
}
