import type { SessionState, MonitoredStock, Suggestion, MarketRegime, PaperAccount, PaperOrder } from "../lib/schemas";

export type { SessionState, MonitoredStock, Suggestion, MarketRegime, PaperAccount, PaperOrder };


export interface SystemStatus {
  wsConnected: boolean;
  dbConnected: boolean;
  schedulerRunning: boolean;
  upstoxAuthenticated: boolean;
  upstoxFeedAuthenticated?: boolean;
  upstoxDataAuthenticated?: boolean;
  upstoxConfigured: boolean;
  upstoxFeedConfigured?: boolean;
  upstoxDataConfigured?: boolean;
  useDualApiKeys?: boolean;
  isMarketOpen: boolean;
  signalsGenerated: number;
  aiMode: string;
  aiStatus: string;
  rankingProvider: string;
  currentMarketRegime: string;
  avgConfidence: number | null;
  avgRr: number | null;
  opportunityQualityGrade: string;
  upstoxTokenExpiry?: number | null;
  upstoxFeedTokenExpiry?: number | null;
  upstoxDataTokenExpiry?: number | null;
}

export interface WatchlistItem {
  symbol: string;
  name: string;
  category: string;
  condition: string;
  priority: number;
  ltp?: number | null;
  price?: number | null;
  prevClose?: number | null;
  changePct?: number | null;
  indicatorStatus?: string;
  suggestionLabel?: string;
  signalGenerated?: boolean;
  compositeScore?: number;
  components?: Record<string, number>;
  signalTags?: string[];
}

export interface Watchlist {
  forDate: string;
  isFallback?: boolean;
  hasScan?: boolean;
  momentumCandidates: WatchlistItem[];
  breakoutCandidates: WatchlistItem[];
  gapCandidates: WatchlistItem[];
  intradayCandidates: WatchlistItem[];
  avoidList: WatchlistItem[];
  generatedAt: string | null;
}

// Suggestion exported above

export interface DivergenceResult {
  fiiNet5d: number;
  diiNet5d: number;
  totalFlow5d: number;
  niftyReturn5d: number;
  isDiverging: boolean;
  divergenceType: "BULLISH" | "BEARISH" | "NONE";
  penaltyOrBoost: number;
}

export interface DashboardIndices {
  nifty50: IndexQuote;
  sensex: IndexQuote;
  bankNifty: IndexQuote;
  finnifty: IndexQuote;
  indiaVix: IndexQuote;
  fiiDiiDivergence?: DivergenceResult | null;
  fetchedAt: string;
}

interface IndexQuote {
  keyUsed: string | null;
  ltp: number | null;
  changePct: number | null;
}

// MarketRegime exported above

// MonitoredStock exported above

export interface IntradayMonitoring {
  active: boolean;
  monitoredStocksCount: number;
  lastMonitoringCycle: string | null;
  monitoringMaxStocks: number;
  monitoredStocks: MonitoredStock[];
}

export interface ScanStatus {
  running: boolean;
  mode: string;
  lastScanMessage: string;
  lastScanStatus?: string;
  scanSessionId?: string | null;
  postMarket?: {
    running: boolean;
    totalStocks: number;
    analyzedCount: number;
    candidatesFound: number;
    lastStatus: string;
    lastMessage: string | null;
  };
  offhours?: {
    running?: boolean;
    lastScanFinishedAt?: string | null;
    lastScanStartedAt?: string | null;
    activeCandidates?: Array<{ symbol: string; reason?: string }>;
  };
}

export interface Candle {
  ts: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TickUpdate {
  symbol: string;
  price: number;
  volume: number;
  bid?: number | null;
  ask?: number | null;
  timestamp: string;
}

export interface MonitoringUpdate {
  active: boolean;
  monitoredStocks: MonitoredStock[];
  monitoredStocksCount?: number;
  lastMonitoringCycle: string | null;
  monitoringMaxStocks?: number;
  maxLimit?: number;
}

export interface SymbolForecast {
  symbol: string;
  available: boolean;
  source?: string;
  trend?: string;
  forecastReturnPct?: number;
  medianForecast?: number[];
  quantileForecasts?: {
    q25?: number[];
    q75?: number[];
    q10?: number[];
    q90?: number[];
  };
  compositeScore?: number;
  components?: Record<string, number>;
  lastClose?: number | null;
  isFallback?: boolean;
  error?: string;
}

export interface SymbolInsights {
  symbol: string;
  name: string;
  sector: string;
  scan: {
    score: number;
    setupType: string;
    direction: string;
    condition?: string;
    mtfConfluenceScore: number;
    mtfScore?: number;
    mtfTotal?: number;
    provisional_trigger?: number;
    provisional_deviation?: number;
    rs60: number;
    reasoning: string;
  } | null;
  indicators: {
    rsi14: number;
    adx14: number;
    volumeRatio: number;
    ema9: number;
    ema20: number;
    trend: string;
    distFromEma20Pct: number;
    close?: number;
    vwap?: number;
  } | null;
  monitoring: MonitoredStock | null;
  ai: {
    compositeScore: number;
    components?: Record<string, number>;
    trend: string;
    forecastReturnPct: number;
    technicalPatterns: string[];
    isFallback?: boolean;
    source: string;
    techEdge?: number | null;
    regimeAlign?: number | null;
  } | null;
  fetchedAt: string;
}

export interface SymbolSearchResult {
  symbol: string;
  name: string;
  sector?: string;
}

export interface ScanProgress {
  current: number;
  total: number;
  currentStock?: string;
  status?: string;
  reason?: string;
}

export interface PaperPosition {
  id: string | number;
  suggestionId?: string | null;
  symbol: string;
  direction: "BUY" | "SELL" | string;
  quantity: number;
  avgEntryPrice: string;
  status: "OPEN" | "CLOSED" | string;
  realizedPnl: string;
  unrealizedPnl: string;
  trailingStopLoss?: string | null;
  createdAt: string;
  closedAt?: string | null;
  closeReason?: string | null;
}

export interface AlertRecord {
  id: string;
  symbol?: string | null;
  type: string;
  message: string;
  createdAt: string;
}

export interface SystemConfig {
  tradingCapital: number;
  maxRiskPerTradePct: number;
  maxDailyLossPct: number;
  maxOpenPositions: number;
  maxSectorExposure: number;
  minRiskReward: number;
  minDailyVolume: number;
  vixPauseThreshold: number;
  minSuggestionScore: number;
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
  tradingMode?: "PAPER" | "LIVE";
  upstoxApiKey?: string;
  upstoxApiSecret?: string;
  upstoxDataApiKey?: string;
  upstoxDataApiSecret?: string;
  useDualApiKeys?: boolean;
  upstoxRedirectUri?: string;
  stopLossMode: "FIXED" | "TRAILING" | "BREAKEVEN";
  maxDeployedCapitalPct?: number;
  discordWebhookUrl?: string;
  telegramBotToken?: string;
  telegramChatId?: string;
}

export type UpdateSystemConfig = Partial<SystemConfig>;
