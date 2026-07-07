import type { Candle } from "@/types/api";

export interface SRLevel {
  price: number;
  type: "support" | "resistance";
  strength: number; // 1 to 10
  label: string; // e.g., "R1", "S2"
  sources: string[];
}

export function calculateSRLevels(
  dailyCandles: Candle[],
  currentPrice: number
): SRLevel[] {
  const candidateLevels: SRLevel[] = [];
  if (!dailyCandles || dailyCandles.length < 2) return candidateLevels;

  // Filter out today's incomplete candle if it exists (assuming today is last)
  // For safety, just take the second to last as "prevDay" assuming real-time data
  const prevDay = dailyCandles[dailyCandles.length - 2];
  const H = prevDay.high;
  const L = prevDay.low;
  const C = prevDay.close;

  // 1. Standard Pivot Points
  const P = (H + L + C) / 3;
  const R1 = 2 * P - L;
  const S1 = 2 * P - H;
  const R2 = P + (H - L);
  const S2 = P - (H - L);
  
  candidateLevels.push({ price: R1, type: "resistance", strength: 7, label: "R1", sources: ["Pivot R1"] });
  candidateLevels.push({ price: R2, type: "resistance", strength: 8, label: "R2", sources: ["Pivot R2"] });
  candidateLevels.push({ price: S1, type: "support", strength: 7, label: "S1", sources: ["Pivot S1"] });
  candidateLevels.push({ price: S2, type: "support", strength: 8, label: "S2", sources: ["Pivot S2"] });

  // 2. Previous Day High/Low
  candidateLevels.push({ price: H, type: currentPrice < H ? "resistance" : "support", strength: 9, label: "PDH", sources: ["Prev High"] });
  candidateLevels.push({ price: L, type: currentPrice > L ? "support" : "resistance", strength: 9, label: "PDL", sources: ["Prev Low"] });

  // 3. VWAP removed as data is unavailable in SymbolData

  // 4. Fibonacci Retracements (from recent swing high/low of last 10 days)
  if (dailyCandles.length > 5) {
    const recentCandles = dailyCandles.slice(-10);
    const recentHigh = Math.max(...recentCandles.map((c) => c.high));
    const recentLow = Math.min(...recentCandles.map((c) => c.low));
    const diff = recentHigh - recentLow;
    if (diff > 0) {
      const fib382 = recentHigh - diff * 0.382;
      const fib618 = recentHigh - diff * 0.618;
      candidateLevels.push({ price: fib382, type: currentPrice > fib382 ? "support" : "resistance", strength: 6, label: "Fib 38.2%", sources: ["Fib 38.2%"] });
      candidateLevels.push({ price: fib618, type: currentPrice > fib618 ? "support" : "resistance", strength: 6, label: "Fib 61.8%", sources: ["Fib 61.8%"] });
      candidateLevels.push({ price: recentHigh, type: currentPrice < recentHigh ? "resistance" : "support", strength: 8, label: "Swing High", sources: ["Swing High"] });
      candidateLevels.push({ price: recentLow, type: currentPrice > recentLow ? "support" : "resistance", strength: 8, label: "Swing Low", sources: ["Swing Low"] });
    }
  }

  // 5. Clustering / Merging logic (ATR approximation)
  // We approximate an ATR threshold of 0.25% of current price to merge overlapping levels.
  const threshold = currentPrice * 0.0025;
  const clustered: SRLevel[] = [];

  for (const level of candidateLevels) {
    const existing = clustered.find((c) => Math.abs(c.price - level.price) < threshold);
    if (existing) {
      // Merge into the stronger or average price, and combine sources
      existing.strength = Math.min(10, existing.strength + 2);
      if (!existing.sources.includes(level.sources[0])) {
        existing.sources.push(...level.sources);
      }
      // Weight the price slightly towards the new level
      existing.price = (existing.price + level.price) / 2;
      
      // Update type dynamically based on current price after merge
      existing.type = currentPrice > existing.price ? "support" : "resistance";
    } else {
      // Re-evaluate type strictly against current price
      level.type = currentPrice > level.price ? "support" : "resistance";
      clustered.push({ ...level, sources: [...level.sources] });
    }
  }

  return clustered;
}
