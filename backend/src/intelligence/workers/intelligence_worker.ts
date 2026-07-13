import { parentPort } from "node:worker_threads";
import axios from "axios";
import { buildSnapshot, type OHLCV } from "../../analysis/technical";
import type { CandidateSignal, MarketState, TechnicalOpportunity, RankedOpportunity } from "../types";

if (!parentPort) {
  process.exit(1);
}

function getAiServiceUrl(): string {
  return process.env.AI_SERVICE_URL || "http://localhost:8001";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
parentPort.on("message", async (msg: { id: string; type: string; payload: any }) => {
  const { id, type, payload } = msg;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let result: any = null;

    switch (type) {
      case "CANDIDATE_DETECTION": {
        const state = payload.state as MarketState;
        result = evaluateCandidateStateless(state);
        break;
      }
      case "TECHNICAL_ANALYSIS": {
        const { candidate, candles } = payload as { candidate: CandidateSignal; candles: OHLCV[] };
        result = analyzeTechnicalStateless(candidate, candles);
        break;
      }
      case "AI_RANKING": {
        const { opportunities, maxOpportunities, regime } = payload as { 
          opportunities: Array<{ opportunity: TechnicalOpportunity; candles: OHLCV[] }>; 
          maxOpportunities: number;
          regime?: string;
        };
        result = await rankAiOpportunities(opportunities, maxOpportunities, regime);
        break;
      }
      case "HISTORICAL_LOADING": {
        const { instrumentKey, timeframe, fromDate, toDate, accessToken } = payload as {
          instrumentKey: string;
          timeframe: string;
          fromDate: string;
          toDate: string;
          accessToken: string;
        };
        result = await loadHistoricalCandles(instrumentKey, timeframe, fromDate, toDate, accessToken);
        break;
      }
      default:
        throw new Error(`Unknown task type: ${type}`);
    }

    parentPort!.postMessage({ id, success: true, result });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    parentPort!.postMessage({ id, success: false, error: err.message || String(err) });
  }
});

function evaluateCandidateStateless(state: MarketState): CandidateSignal | null {
  const rangePct = state.open > 0 ? ((state.high - state.low) / state.open) * 100 : 0;
  const dayHighProximity = state.high > 0 ? ((state.high - state.ltp) / state.high) * 100 : 100;
  const relativeVolume = state.previousVolume > 0 ? state.volume / state.previousVolume : 1;
  const momentum = Math.abs(state.percentageChange);
  const turnoverCr = state.turnover / 10_000_000;

  const reasons: string[] = [];
  let score = 0;

  if (relativeVolume >= 1.15) {
    score += Math.min(3, relativeVolume);
    reasons.push(`relative volume ${relativeVolume.toFixed(2)}x`);
  }
  if (rangePct >= 0.8) {
    score += Math.min(2.5, rangePct);
    reasons.push(`range expansion ${rangePct.toFixed(2)}%`);
  }
  if (dayHighProximity <= 0.35 && state.percentageChange > 0) {
    score += 1.5;
    reasons.push("near day high");
  }
  if (momentum >= 0.6) {
    score += Math.min(2, momentum);
    reasons.push(`momentum ${state.percentageChange.toFixed(2)}%`);
  }
  if (turnoverCr >= 1) {
    score += Math.min(1, turnoverCr / 25);
    reasons.push(`turnover ${turnoverCr.toFixed(1)}cr`);
  }

  if (score < 3) {
    return null;
  }

  return {
    instrumentKey: state.instrumentKey,
    symbol: state.symbol,
    score: Number(score.toFixed(2)),
    reasons,
    state,
    detectedAt: Date.now(),
  };
}

function analyzeTechnicalStateless(candidate: CandidateSignal, candles: OHLCV[]): TechnicalOpportunity | null {
  const fallback = candidate.state;
  const snap = candles.length >= 20 ? buildSnapshot(candles) : null;
  const atr = snap?.atr14 ?? Math.max(fallback.ltp * 0.006, fallback.high - fallback.low);
  
  if (fallback.ltp <= 0 || atr <= 0) return null;

  const direction = fallback.percentageChange >= 0 ? "BUY" : "SELL";
  const entry = fallback.ltp;
  const stopLoss =
    direction === "BUY"
      ? Math.max(0.05, entry - atr * 1.2)
      : entry + atr * 1.2;
  const risk = Math.abs(entry - stopLoss);
  const target = direction === "BUY" ? entry + risk * 2 : entry - risk * 2;
  
  if (risk <= 0 || target <= 0) return null;

  const trendAligned =
    snap == null ||
    (direction === "BUY" ? snap.ema9 >= snap.ema20 : snap.ema9 <= snap.ema20);
  
  if (!trendAligned && candidate.score < 5.5) return null;

  const score = Math.min(
    10,
    candidate.score + (trendAligned ? 1.2 : -0.6) + (snap?.volumeRatio && snap.volumeRatio > 1.2 ? 0.6 : 0),
  );

  if (score < 5.2) return null;

  return {
    instrumentKey: candidate.instrumentKey,
    symbol: candidate.symbol,
    direction,
    setup: direction === "BUY" ? "LIVE_MOMENTUM_CONTINUATION" : "LIVE_BEAR_MOMENTUM",
    score: Number(score.toFixed(2)),
    entry: Number(entry.toFixed(2)),
    stopLoss: Number(stopLoss.toFixed(2)),
    target: Number(target.toFixed(2)),
    riskReward: 2,
    reasoning: [...candidate.reasons, trendAligned ? "technical trend aligned" : "early momentum candidate"],
    qualifiedAt: Date.now(),
  };
}

async function rankAiOpportunities(
  payloads: Array<{ opportunity: TechnicalOpportunity; candles: OHLCV[] }>, 
  maxOpportunities: number,
  regime?: string
): Promise<RankedOpportunity[]> {
  const limited = payloads.slice(0, maxOpportunities);
  if (limited.length === 0) return [];

  try {
    const candidates = limited.map(p => ({
      symbol: p.opportunity.symbol,
      ohlcv: p.candles.map(c => [c.open, c.high, c.low, c.close, c.volume])
    }));

    const response = await axios.post<{ results: AiRankResult[] }>(
      `${getAiServiceUrl()}/inference/batch`,
      { candidates },
      { timeout: 14000 },
    );
    const results = Array.isArray(response.data.results) ? response.data.results : [];
    const scoreMap = new Map<string, AiRankResult>();
    for (const res of results) {
       scoreMap.set(res.symbol, res);
    }

    return limited.map(p => {
      const opp = p.opportunity;
      const aiResult = scoreMap.get(opp.symbol);
      if (aiResult) {
        let aiScore = Math.min(10, aiResult.composite_score / 10);
        
        // Regime-aware signal filtering
        if (regime === "TRENDING_DOWN" || regime === "BEARISH") {
          if (opp.direction === "BUY") {
            aiScore -= 5; // Heavily penalize LONG signals in bear/down regime
          }
        } else if (regime === "TRENDING_UP" || regime === "BULLISH") {
          if (opp.direction === "SELL") {
            aiScore -= 5; // Heavily penalize SHORT signals in bull/up regime
          }
        }
        
        aiScore = Math.max(0, aiScore);

        return {
          ...opp,
          aiScore,
          compositeScore: Number((opp.score * 0.4 + aiScore * 0.6).toFixed(2)),
          rankReasoning: [
             `AI Score: ${aiResult.composite_score.toFixed(1)}`,
             `Technical Ranking Bullish: ${(aiResult.technicalRanking.bullish_probability * 100).toFixed(1)}%`,
             `Chronos Trend: ${aiResult.chronos?.trend ?? "N/A"}`,
             ...(Array.isArray(opp?.reasoning) ? opp.reasoning : [])
          ],
        };
      }
      return deterministicFallback(opp, regime);
    }).sort((a, b) => b.compositeScore - a.compositeScore);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, unused-imports/no-unused-vars, @typescript-eslint/no-unused-vars
  } catch (err: any) {
    return limited.map(p => deterministicFallback(p.opportunity, regime)).sort((a, b) => b.compositeScore - a.compositeScore);
  }
}

interface AiRankResult {
  symbol: string;
  world_sentiment_score?: number;
  composite_score: number;
  components?: Record<string, number>;
  technicalRanking: {
    bullish_probability: number;
  };
  chronos?: {
    trend: string;
  };
}

function deterministicFallback(opportunity: TechnicalOpportunity, regime?: string): RankedOpportunity {
  const reasoningList = Array.isArray(opportunity?.reasoning) ? opportunity.reasoning : [];
  const regimeBonus = reasoningList.some((r) => r && typeof r === "string" && r.includes("trend aligned")) ? 0.8 : 0;
  let aiScore = Math.min(10, (opportunity?.score || 0) + regimeBonus);

  // Regime-aware signal filtering
  if (regime === "TRENDING_DOWN" || regime === "BEARISH") {
    if (opportunity?.direction === "BUY") {
      aiScore -= 5;
    }
  } else if (regime === "TRENDING_UP" || regime === "BULLISH") {
    if (opportunity?.direction === "SELL") {
      aiScore -= 5;
    }
  }

  aiScore = Math.max(0, aiScore);
  return {
    ...opportunity,
    aiScore,
    compositeScore: Number(((opportunity?.score || 0) * 0.75 + aiScore * 0.25).toFixed(2)),
    rankReasoning: ["deterministic AI fallback ranker", ...reasoningList],
  };
}

async function withRetry<T>(
  fn: () => Promise<T>,
  retries = 3,
  delay = 1000
): Promise<T> {
  try {
    return await fn();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    if (
      retries <= 0 ||
      (err.response?.status &&
        err.response.status >= 400 &&
        err.response.status < 500 &&
        err.response.status !== 429)
    ) {
      throw err;
    }
    const is429 = err.response?.status === 429;
    let nextDelay = delay;
    if (is429) {
      const retryAfter = err.response.headers?.["retry-after"];
      if (retryAfter) {
        const parsed = parseInt(String(retryAfter), 10);
        if (!isNaN(parsed) && parsed > 0) {
          nextDelay = parsed * 1000;
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, nextDelay));
    return withRetry(fn, retries - 1, nextDelay * 2);
  }
}

async function loadHistoricalCandles(
  instrumentKey: string,
  timeframe: string,
  fromDate: string,
  toDate: string,
  accessToken: string,
): Promise<OHLCV[]> {
  const url = `https://api.upstox.com/v2/historical-candle/${encodeURIComponent(instrumentKey)}/${timeframe}/${toDate}/${fromDate}`;
  
  const response = await withRetry(
    () => axios.get(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      timeout: 15000,
    }),
    3,
    500
  );

  const rawCandles = response.data?.data?.candles ?? [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const formatted: OHLCV[] = rawCandles.map((c: any[]): OHLCV => ({
    timestamp: c[0],
    open: Number(c[1]),
    high: Number(c[2]),
    low: Number(c[3]),
    close: Number(c[4]),
    volume: Number(c[5]),
  })).reverse();

  return formatted;
}
