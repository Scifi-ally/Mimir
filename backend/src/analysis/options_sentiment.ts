
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
  // Option chain integration is not yet implemented.
  // Returning a disabled/neutral state to prevent fake data in production.
  return _state;
}
