import { describe, expect, it } from "vitest";
import { mapAdjustedCandles } from "./backfill_daily_candles_lib";

describe("daily candle backfill mapping", () => {
  it("adjusts historical prices and remains deterministic for repeated upserts", () => {
    const rows = [
      ["2020-01-01T00:00:00.000Z", 100, 110, 90, 105, 1000],
      ["2021-01-01T00:00:00.000Z", 50, 55, 45, 52, 2000],
    ];
    const mapped = mapAdjustedCandles("NSE_EQ|TEST", rows, [{ exDate: "2020-06-01", splitRatio: 0.5 }]);
    expect(mapped[0]?.close).toBe(52.5);
    expect(mapped[0]?.volume).toBe(2000);
    expect(mapped[1]?.close).toBe(52);
    expect(mapAdjustedCandles("NSE_EQ|TEST", rows, []).map((row) => row.timestamp))
      .toEqual(rows.map((row) => row[0]));
  });
});
