import { getGlobalMacroState } from "./global_macro";
import { getOptionsSentimentState } from "./options_sentiment";
import { getInternalsScore } from "./market_internals";

export interface CompositeMarketContext {
  macroScore: number;
  sentimentScore: number;
  internalsScore: number;
  compositeScore: number;
  regime: "RISK_OFF" | "NEUTRAL" | "RISK_ON";
}

/**
 * Calculates a unified -100 to +100 composite market context score.
 * This synthesizes macroeconomic factors, options sentiment, and market internals (breadth/velocity).
 * Note: Order Flow (OFI) is per-symbol and is handled during signal generation, not global context.
 */
export function getCompositeMarketContext(): CompositeMarketContext {
  const macro = getGlobalMacroState().macroScore;
  const options = getOptionsSentimentState().sentimentScore;
  const internals = getInternalsScore();

  // Weighted average: Internals (live action) > Options > Macro (slow moving)
  const weightInternals = 0.5;
  const weightOptions = 0.3;
  const weightMacro = 0.2;

  const compositeScore = Math.round(
    (internals * weightInternals) +
    (options * weightOptions) +
    (macro * weightMacro)
  );

  let regime: "RISK_OFF" | "NEUTRAL" | "RISK_ON" = "NEUTRAL";
  if (compositeScore <= -40) regime = "RISK_OFF";
  else if (compositeScore >= 40) regime = "RISK_ON";

  return {
    macroScore: macro,
    sentimentScore: options,
    internalsScore: internals,
    compositeScore,
    regime
  };
}
