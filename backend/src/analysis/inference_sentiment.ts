/** Classifier output requires fresh source evidence; missing is never neutral. */
export function inferenceSentiment(value: unknown, evidence: unknown, now = Date.now()): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1 || !evidence || typeof evidence !== "object") return null;
  const meta = evidence as Record<string, unknown>;
  const observed = typeof meta.observed_at === "string" ? Date.parse(meta.observed_at) : NaN;
  const available = typeof meta.available_at === "string" ? Date.parse(meta.available_at) : NaN;
  if (meta.available !== true || typeof meta.source !== "string" || !meta.source ||
    !Number.isFinite(observed) || !Number.isFinite(available) || observed > available || available > now ||
    now - observed > 72 * 3600_000) return null;
  return value;
}
