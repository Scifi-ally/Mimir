import type { OHLCV } from "./types";
import type { FeatureVector } from "./feature_engine";
import { dailyAvailableAt } from "./daily_session";
import { observeFactor, type FactorObservation } from "./factor_observation";
import { derivePriceFactors } from "./price_factors";

export interface MeasuredFactorSnapshot {
  version: "measured-factors-v1";
  symbol: string;
  asOf: string;
  factors: Record<string, FactorObservation>;
  coverage: { available: number; total: number; ratio: number };
  predictiveValidation: "not_established";
}

/** Factors describe observed conditions. Coverage is never a win probability. */
export function buildMeasuredFactors(
  symbol: string, candles: OHLCV[], features?: FeatureVector,
  macro: Record<string, FactorObservation> = {}, now = new Date(),
): MeasuredFactorSnapshot {
  const factors: Record<string, FactorObservation> = {};
  const completed = candles.filter(c => Number.isFinite(Date.parse(c.timestamp)) &&
    Date.parse(dailyAvailableAt(c.timestamp)) <= now.getTime());
  const last = completed.at(-1);
  const available = last ? dailyAvailableAt(last.timestamp) : null;
  // Four calendar days accommodate an ordinary weekend; longer holidays stay unavailable.
  const age = 4 * 86400_000;
  const add = (key: string, value: number | null | undefined, unit: string, kind: FactorObservation["kind"] = "derived") => {
    factors[key] = observeFactor(value, unit, "completed_daily_ohlcv", available, available, age, now.getTime(), kind);
  };
  const valid = completed.length > 0 && completed.every((c, i) =>
    [c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite) && c.low > 0 && c.volume > 0 &&
    c.low <= Math.min(c.open, c.close) && c.high >= Math.max(c.open, c.close, c.low) &&
    (i === 0 || dailyAvailableAt(c.timestamp) > dailyAvailableAt(completed[i - 1]!.timestamp)));
  const returnOver = (n: number) => valid && completed.length > n
    ? 100 * (last!.close / completed[completed.length - n - 1]!.close - 1) : null;
  add("close", valid ? last!.close : null, "INR", "measurement");
  for (const period of [5, 20, 60, 120]) add(`return_${period}d`, returnOver(period), "percent");
  const recent = completed.slice(-20);
  add("turnover_20d", valid && recent.length === 20
    ? recent.reduce((sum, c) => sum + c.close * c.volume, 0) / 20 : null, "INR/day", "proxy");
  add("overnight_gap", valid && completed.length > 1
    ? 100 * (last!.open / completed[completed.length - 2]!.close - 1) : null, "percent");
  add("intraday_range", valid ? 100 * (last!.high - last!.low) / last!.close : null, "percent");
  const keys: Array<[keyof FeatureVector, string]> = [
    ["rsi14", "index"], ["atrPct", "percent"], ["adx14", "index"],
    ["volumeRatio", "ratio"], ["ema20Dist", "percent"], ["ema50Dist", "percent"],
    ["ema200Dist", "percent"], ["rsVsNifty60d", "ratio"], ["rsVsSector60d", "ratio"],
    ["realizedVol20", "annualized_percent"], ["volOfVol", "percent"], ["bbWidthPct", "percent"],
  ];
  // Do not relabel a vector calculated using incomplete bars as completed-bar data.
  const vectorAligned = features && valid && completed.length === candles.length && !features.rankerIncomplete;
  for (const [key, unit] of keys) add(key, vectorAligned ? features[key] as number : null, unit);
  // Independently observed price indicators remain measurable without an AI,
  // sector membership, ranker training, or a complete ranker feature vector.
  const direct = derivePriceFactors(valid ? completed : []);
  for (const [key, observation] of Object.entries(direct)) add(key, observation.value, observation.unit);
  for (const [key, value] of Object.entries(macro)) factors[key] = { ...value };
  // Explicit gaps prevent neutral defaults from masquerading as measured inputs.
  for (const [key, unit, source] of [
    ["earnings_surprise", "percent", "NSE company filings"],
    ["earnings_event_distance", "sessions", "NSE board meetings"],
    ["valuation_pe", "ratio", "point-in-time financial statements"],
    ["revenue_growth", "percent", "point-in-time financial statements"],
    ["news_sentiment", "score", "timestamped deduplicated news"],
    ["news_novelty", "score", "timestamped deduplicated news"],
    ["geopolitical_event_intensity", "score", "timestamped event corpus"],
    ["policy_rate_surprise", "basis_points", "RBI decisions and prior expectations"],
    ["bid_ask_spread", "basis_points", "timestamped broker quotes"],
    ["order_book_imbalance", "ratio", "timestamped broker depth"],
    ["options_oi_change", "percent", "matched expiry/strike snapshots"],
    ["advance_decline_ratio", "ratio", "timestamped universe breadth"],
  ]) {
    factors[key!] = observeFactor(null, unit!, source!, null, null, age, now.getTime());
  }
  const values = Object.values(factors);
  const count = values.filter(f => f.status === "available").length;
  return { version: "measured-factors-v1", symbol, asOf: now.toISOString(), factors,
    coverage: { available: count, total: values.length, ratio: count / values.length },
    predictiveValidation: "not_established" };
}
