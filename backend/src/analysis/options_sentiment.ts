
import { fetchOptionChainData } from "../market_data/option_chain";
import { logger } from "../lib/logger";

export interface OptionsSentimentState {
  pcr: number | null;          // Put-Call Ratio
  maxPain: number | null;      // Max Pain strike price
  sentimentScore: number;      // -100 to +100
  lastUpdated: string | null;
}

const DEFAULT_STATE: OptionsSentimentState = {
  pcr: null,
  maxPain: null,
  sentimentScore: 0,
  lastUpdated: null,
};

const _state: OptionsSentimentState = { ...DEFAULT_STATE };

export function getOptionsSentimentState(): OptionsSentimentState {
  return _state;
}

export async function fetchOptionsSentimentData(): Promise<OptionsSentimentState> {
  try {
    const data = await fetchOptionChainData();
    if (!data) {
      return _state;
    }

    // Compute sentiment score based on PCR and Spot distance to Max Pain
    // PCR > 1.0 is bullish (put sellers active), PCR < 1.0 is bearish
    const pcrScore = Math.max(-50, Math.min(50, (data.pcr - 1.0) * 50));
    
    // If spot price > maxPain, market has bullish momentum away from option sellers' anchor
    const spotDistPct = ((data.spotPrice - data.maxPain) / data.maxPain) * 100;
    const maxPainScore = Math.max(-50, Math.min(50, spotDistPct * 10));

    const totalScore = Math.round(Math.max(-100, Math.min(100, pcrScore + maxPainScore)));

    _state.pcr = data.pcr;
    _state.maxPain = data.maxPain;
    _state.sentimentScore = totalScore;
    _state.lastUpdated = data.fetchedAt.toISOString();

    logger.debug({ pcr: _state.pcr, maxPain: _state.maxPain, sentimentScore: _state.sentimentScore }, "Options sentiment state updated from live NSE Option Chain");
    return _state;
  } catch (err) {
    logger.warn({ err }, "Failed to update options sentiment state");
    return _state;
  }
}
