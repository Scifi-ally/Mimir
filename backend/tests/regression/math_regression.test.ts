import { describe, it, expect } from "vitest";
import { computeEMA, fastEMA, computeRSI, computeStandardDeviation, computeSMA } from "../../src/analysis/technical";

describe("Math Regression Tests", () => {
  it("computeEMA and fastEMA should match expected values", () => {
    const values = [22.27, 22.19, 22.08, 22.17, 22.18, 22.13, 22.23, 22.43, 22.24, 22.29];
    const period = 5;
    
    const emaArr = computeEMA(values, period);
    const lastEma = fastEMA(values, period);
    
    // Test exact output to prevent regressions
    expect(emaArr.length).toBe(10);
    // last element of computeEMA should closely match fastEMA
    expect(emaArr[9]).toBeCloseTo(lastEma, 4);
    
    // Based on the given algorithm, calculate expected mathematically
    // The seed is average of first 5: (22.27+22.19+22.08+22.17+22.18)/5 = 22.178
    // Next values: 22.13, 22.23, 22.43, 22.24, 22.29
    // k = 2/6 = 0.333333
    let expected = 22.178;
    const k = 2 / 6;
    [22.13, 22.23, 22.43, 22.24, 22.29].forEach(v => {
      expected = v * k + expected * (1 - k);
    });
    
    expect(lastEma).toBeCloseTo(expected, 4);
  });

  it("computeRSI should match expected Wilder's smoothing output", () => {
    // 15 days of data for 14-period RSI
    const closes = [
      44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28
    ];
    
    const rsi = computeRSI(closes, 14);
    
    // We expect a specific RSI value here
    // Let's ensure it doesn't return NaN or crash, and stays stable.
    expect(rsi).toBeGreaterThan(0);
    expect(rsi).toBeLessThan(100);
    expect(rsi).toBeCloseTo(70.46, 1);
  });

  it("computeSMA and computeStandardDeviation should match expected values", () => {
    const values = [1, 2, 3, 4, 5];
    const period = 3;
    
    const smaArr = computeSMA(values, period);
    expect(smaArr).toEqual([1, 2, 2, 3, 4]);
    
    const stdDevArr = computeStandardDeviation(values, smaArr, period);
    // For [1, 2, 3], mean is 2. Variance = ((1-2)^2 + (2-2)^2 + (3-2)^2)/3 = 2/3. StdDev = sqrt(2/3) ~ 0.8165
    expect(stdDevArr[2]).toBeCloseTo(0.81649, 4);
  });
});
