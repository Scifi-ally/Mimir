import { beforeEach, describe, expect, it, vi } from "vitest";

const { quote } = vi.hoisted(() => ({ quote: vi.fn() }));
vi.mock("yahoo-finance2", () => ({ default: class { quote = quote; } }));

import { getMarketState } from "./market_state";
import {
  getMarketFeedSnapshot,
  initMarketFeed,
  resetMarketFeedCache,
  updateMarketFeed,
} from "./market_feed";

describe("market feed partial results", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    quote.mockReset();
    resetMarketFeedCache();
  });

  it("publishes a fresh VIX quote when the Nifty quote is unavailable", async () => {
    quote.mockResolvedValueOnce({ regularMarketPreviousClose: 100 });
    await initMarketFeed();

    quote.mockImplementation(async (symbol: string) =>
      symbol === "^INDIAVIX" ? { regularMarketPrice: 14.2 } : null,
    );

    const polling = updateMarketFeed();
    await vi.advanceTimersByTimeAsync(20_000);
    await polling;

    const snapshot = getMarketFeedSnapshot();
    expect(snapshot.status).toBe("partial");
    expect(snapshot.niftyLtp).toBeNull();
    expect(snapshot.vixLtp).toBe(14.2);
    expect(getMarketState().indiaVix).toBe(14.2);
  });
});
