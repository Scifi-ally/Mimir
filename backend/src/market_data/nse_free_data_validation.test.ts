import { describe, expect, it } from "vitest";
import { parseNseTradeDate } from "./nse_free_data_validation";

describe("NSE archive trade-date parsing", () => {
  it("accepts the CSV date formats and validates the calendar date", () => {
    expect(parseNseTradeDate("02-OCT-2026")).toBe("2026-10-02");
    expect(parseNseTradeDate("2026-10-02")).toBe("2026-10-02");
    expect(parseNseTradeDate("31-FEB-2026")).toBeNull();
    expect(parseNseTradeDate(undefined)).toBeNull();
  });
});
