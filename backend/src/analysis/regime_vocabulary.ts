/**
 * Canonical breadth-regime vocabulary.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * The system historically carried TWO incompatible regime vocabularies and
 * compared them with exact string equality:
 *
 *   MarketBreadthEngine emits (breadth_engine.ts:26-37):
 *     "Risk-On" | "Bullish" | "Risk-Off" | "Bearish" | "Trending" | "Ranging"
 *
 *   Consumers compared against (intelligence_worker.ts:322, :405):
 *     "TRENDING_DOWN" | "BEARISH" | "TRENDING_UP" | "BULLISH"
 *
 * `orchestrator.ts:176` forwards the breadth snapshot's regime verbatim, so
 * "Bearish" !== "BEARISH" on case alone and neither penalty branch could ever
 * execute. The two EXTREME regimes, "Risk-On" and "Risk-Off", had no matching
 * token at all. The entire regime-aware penalty block was dead code.
 *
 * This module is the single place that maps any known spelling onto one
 * normalized bias, so a new producer cannot silently disable the gates again.
 */

export type RegimeBias = "risk_on" | "bullish" | "neutral" | "bearish" | "risk_off";

/**
 * Map any known regime label onto a normalized directional bias.
 *
 * Unknown, empty and malformed values deliberately resolve to "neutral" rather
 * than guessing a direction — a regime we cannot read must not be treated as
 * bullish or bearish.
 */
export function classifyBreadthRegime(regime: unknown): RegimeBias {
  if (typeof regime !== "string") return "neutral";
  // Normalize separators and case: "Risk-On", "RISK_ON", "risk on" all match.
  const key = regime.trim().toUpperCase().replace(/[\s_]+/g, "-");
  if (!key) return "neutral";

  switch (key) {
    // Breadth-engine vocabulary.
    case "RISK-ON":
      return "risk_on";
    case "BULLISH":
      return "bullish";
    case "RISK-OFF":
      return "risk_off";
    case "BEARISH":
      return "bearish";
    case "TRENDING":
    case "RANGING":
      return "neutral";

    // Legacy regime_detector vocabulary, still emitted by older cached rows and
    // by suggestions persisted before the taxonomy was unified.
    case "TRENDING-DOWN":
    case "BEAR-TREND":
    case "BEARISH-CONTRACTION":
      return "bearish";
    case "TRENDING-UP":
    case "BULL-TREND":
    case "BULLISH-EXPANSION":
      return "bullish";

    // Confluence-service vocabulary.
    case "HIGH-VOLATILITY":
    case "VOLATILE":
      return "neutral";

    default:
      return "neutral";
  }
}

/**
 * Score penalty for a trade that runs AGAINST the prevailing regime.
 *
 * The two extremes (Risk-On / Risk-Off) are penalised harder than the mild
 * bull/bear readings, because breadth that is extreme in either direction is
 * where counter-trend entries lose the most. The penalty is bounded to the 0-10
 * score scale's mid-band so it changes ranking without fabricating a verdict.
 */
export function counterTrendPenalty(bias: RegimeBias): number {
  switch (bias) {
    case "risk_off":
      return 7;
    case "bearish":
      return 5;
    case "risk_on":
      return 7;
    case "bullish":
      return 5;
    default:
      return 0;
  }
}

/**
 * True when a BUY is counter-trend for this regime, or a SELL is.
 */
export function isCounterTrend(bias: RegimeBias, direction: string | undefined): boolean {
  if (bias === "bearish" || bias === "risk_off") {
    return (direction ?? "BUY").toUpperCase() === "BUY";
  }
  if (bias === "bullish" || bias === "risk_on") {
    return (direction ?? "BUY").toUpperCase() === "SELL";
  }
  return false;
}
