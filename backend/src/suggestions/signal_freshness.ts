export type SignalTradeType = "INTRADAY" | "SWING";

export interface SignalFreshnessInput {
  generatedAt?: string | number | Date | null;
  tradeType: SignalTradeType;
  now?: Date;
}

export interface SignalFreshnessResult {
  accepted: boolean;
  ageMinutes: number | null;
  maxAgeMinutes: number;
  reason: "fresh" | "stale_signal" | "missing_timestamp" | "invalid_timestamp";
}

const DEFAULT_INTRADAY_MAX_AGE_MINUTES = 5;
const DEFAULT_SWING_MAX_AGE_MINUTES = 60;
const MIN_MAX_AGE_MINUTES = 1;
const MAX_MAX_AGE_MINUTES = 24 * 60;

function configuredMinutes(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(MAX_MAX_AGE_MINUTES, Math.max(MIN_MAX_AGE_MINUTES, Math.floor(parsed)));
}

export function getMaxSignalAgeMinutes(tradeType: SignalTradeType): number {
  return tradeType === "INTRADAY"
    ? configuredMinutes("MIMIR_MAX_INTRADAY_SIGNAL_AGE_MINUTES", DEFAULT_INTRADAY_MAX_AGE_MINUTES)
    : configuredMinutes("MIMIR_MAX_SWING_SIGNAL_AGE_MINUTES", DEFAULT_SWING_MAX_AGE_MINUTES);
}

function parseTimestamp(value: SignalFreshnessInput["generatedAt"]): number | null {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === "number") {
    const ms = value < 10_000_000_000 ? value * 1000 : value;
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === "string" && value.trim()) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

export function evaluateSignalFreshness(input: SignalFreshnessInput): SignalFreshnessResult {
  const maxAgeMinutes = getMaxSignalAgeMinutes(input.tradeType);
  if (input.generatedAt == null || input.generatedAt === "") {
    return { accepted: false, ageMinutes: null, maxAgeMinutes, reason: "missing_timestamp" };
  }

  const timestampMs = parseTimestamp(input.generatedAt);
  if (timestampMs == null) {
    return { accepted: false, ageMinutes: null, maxAgeMinutes, reason: "invalid_timestamp" };
  }

  const nowMs = (input.now ?? new Date()).getTime();
  const ageMinutes = (nowMs - timestampMs) / 60_000;
  // Future timestamps are accepted as fresh but rounded to zero for telemetry;
  // a small clock skew must not discard a signal that was just generated.
  const nonNegativeAgeMinutes = Math.max(0, ageMinutes);
  const accepted = nonNegativeAgeMinutes <= maxAgeMinutes;
  return {
    accepted,
    ageMinutes: Math.round(nonNegativeAgeMinutes * 100) / 100,
    maxAgeMinutes,
    reason: accepted ? "fresh" : "stale_signal",
  };
}
