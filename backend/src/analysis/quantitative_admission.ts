/** A rule score ranks setups; it is not a measured probability. */
export function quantitativeAdmission(
  probability: number | null | undefined, validatedModel: boolean, incompleteFeatures: boolean,
): string | null {
  if (incompleteFeatures) return "unmeasured_ranker_features";
  if (!validatedModel) return "no_validated_quantitative_model";
  if (typeof probability !== "number" || !Number.isFinite(probability) || probability <= 0 || probability > 1) {
    return "invalid_quantitative_probability";
  }
  return null;
}

export function directionalContext(rs: number, sectorChangePct: number, direction: "BUY" | "SELL") {
  const sign = direction === "BUY" ? 1 : -1;
  return {
    rs: Math.max(0, Math.min(100, 50 + sign * (rs - 1) * 250)),
    sector: Math.max(0, Math.min(100, 50 + sign * sectorChangePct * 25)),
  };
}
