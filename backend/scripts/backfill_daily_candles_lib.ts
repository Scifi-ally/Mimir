import { adjustCandlesForCorporateActions, type SplitAdjustment } from "../src/market_data/corporate_actions";

export interface BackfillCandle {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export function mapAdjustedCandles(
  instrumentKey: string,
  rows: unknown[][],
  adjustments: SplitAdjustment[],
): Array<BackfillCandle & { instrumentKey: string; interval: "day" }> {
  const parsed: BackfillCandle[] = rows.flatMap((row) => {
    const timestamp = typeof row[0] === "string" ? row[0] : "";
    const values = row.slice(1, 6).map(Number);
    if (!timestamp || values.some((value) => !Number.isFinite(value)) || values[1]! <= 0 || values[2]! <= 0) {
      return [];
    }
    return [{
      timestamp,
      open: values[0]!,
      high: values[1]!,
      low: values[2]!,
      close: values[3]!,
      volume: Math.max(0, Math.round(values[4]!)),
    }];
  });

  return adjustCandlesForCorporateActions(parsed, adjustments).map((candle) => ({
    ...candle,
    instrumentKey,
    interval: "day" as const,
  }));
}
