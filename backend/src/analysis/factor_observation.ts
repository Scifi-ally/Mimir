/** An observation is available only after its publication time, never its fetch time. */
export interface FactorObservation {
  value: number | null;
  unit: string;
  source: string;
  observedAt: string | null;
  availableAt: string | null;
  maxAgeMs: number;
  kind: "measurement" | "derived" | "proxy";
  status: "available" | "missing" | "stale" | "invalid" | "future";
  reason?: string;
}

export function observeFactor(
  value: unknown, unit: string, source: string, observedAt: string | null,
  availableAt: string | null, maxAgeMs: number, now = Date.now(),
  kind: FactorObservation["kind"] = "measurement",
): FactorObservation {
  const base = { value: null, unit, source, observedAt, availableAt, maxAgeMs, kind };
  if (value == null) return { ...base, status: "missing", reason: "Source did not supply this observation" };
  const observed = observedAt == null ? NaN : Date.parse(observedAt);
  const available = availableAt == null ? NaN : Date.parse(availableAt);
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isFinite(observed) ||
      !Number.isFinite(available) || available < observed || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
    return { ...base, status: "invalid", reason: "Finite value and verified source/publication times required" };
  }
  if (observed > now || available > now) return { ...base, status: "future", reason: "Observation was not available at decision time" };
  if (now - observed > maxAgeMs) return { ...base, status: "stale", reason: "Source observation exceeded freshness budget" };
  return { ...base, value, status: "available" };
}

export function refreshFactor(factor: FactorObservation, now = Date.now()): FactorObservation {
  if (factor.status !== "available") return { ...factor };
  return observeFactor(factor.value, factor.unit, factor.source, factor.observedAt,
    factor.availableAt, factor.maxAgeMs, now, factor.kind);
}
