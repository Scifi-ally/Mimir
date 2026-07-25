export interface OHLCV {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}


export interface TechnicalSnapshot {
  close: number;
  ema9: number;
  ema20: number;
  ema50: number;
  ema200: number;
  rsi14: number;
  atr14: number;
  volumeRatio: number;
  adx14: number;
  high52w: number;
  low52w: number;
  distFromEma20Pct: number;
  trend: "UP" | "DOWN" | "SIDEWAYS";
  avgDailyVolume: number;
  swingLow: number;
  swingHigh: number;
  vwap: number;
  superTrend: number;
  vpvrPOC: number;
  volumeAnomaly: boolean;
  bbUpper?: number;
  bbLower?: number;
  bbMiddle?: number;
  bbBandwidth?: number;
}


export interface SetupCandidate {
  setupType: string;
  direction: "BUY" | "SELL";
  score: number;
  entryPrice: number;
  stopLoss: number;
  target1: number;
  target2: number;
  riskReward: number;
  reasoning: string;
  confluence: string[];
}


// ── Bollinger Bands ──────────────────────────────────────────────────────────

export interface BollingerBands {
  upper: number;
  middle: number;
  lower: number;
  bandwidth: number;
}


// ── MACD ─────────────────────────────────────────────────────────────────────

export interface MACDResult {
  macd: number;
  signal: number;
  histogram: number;
}