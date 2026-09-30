import { describe, it, expect } from "vitest";
import { fmtInr } from "./format";

describe("fmtInr", () => {
  it("keeps full precision below a thousand", () => {
    expect(fmtInr(0)).toBe("₹0.00");
    expect(fmtInr(999.5)).toBe("₹999.50");
  });

  it("abbreviates thousands so the value fits a metric tile", () => {
    // "₹10,000.00" is what fmtNum produced, and it was ellipsised to "₹10,000…".
    expect(fmtInr(10000)).toBe("₹10.0k");
    expect(fmtInr(10000).length).toBeLessThanOrEqual(7);
  });

  it("uses Indian lakh/crore units", () => {
    expect(fmtInr(120000)).toBe("₹1.20L");
    expect(fmtInr(15000000)).toBe("₹1.50Cr");
  });

  it("drops pointless decimals", () => {
    expect(fmtInr(1500000)).toBe("₹15.0L");
    expect(fmtInr(120000000)).toBe("₹12.0Cr");
  });

  it("keeps the sign outside the symbol", () => {
    expect(fmtInr(-10000)).toBe("-₹10.0k");
  });

  it("honours compact:false for the exact figure", () => {
    expect(fmtInr(10000, { compact: false })).toBe("₹10,000.00");
  });

  it("renders a dash for non-numeric input", () => {
    expect(fmtInr(undefined)).toBe("—");
    expect(fmtInr("abc")).toBe("—");
    expect(fmtInr(null)).toBe("—");
  });

  it("never produces a string long enough to be ellipsised", () => {
    for (const v of [0, 1, 999, 1000, 99999, 100000, 9999999, 10000000, 1e9, 1e12]) {
      expect(fmtInr(v).length, `${v} -> ${fmtInr(v)}`).toBeLessThanOrEqual(9);
    }
  });
});
