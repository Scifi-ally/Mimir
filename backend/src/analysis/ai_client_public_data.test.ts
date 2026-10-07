import { beforeEach, describe, expect, it, vi } from "vitest";
import axios from "axios";
import { batchInference } from "./ai_client";
import { inferenceSentiment } from "./inference_sentiment";

vi.mock("axios", () => ({ default: { post: vi.fn() } }));
vi.mock("./divergence_engine", () => ({ getFiiDiiDivergence: async () => ({ penaltyOrBoost: 0 }) }));
vi.mock("./order_flow", () => ({ computeOFI: () => ({ ofiRatio: 0 }) }));
const candidate = { symbol: "RECORDED", ohlcv: Array.from({ length: 60 }, () => [100, 101, 99, 100, 1000]), features: {} };

describe("public model data does not invent missing evidence", () => {
  beforeEach(() => vi.mocked(axios.post).mockReset());
  it("abstains during service failure instead of publishing a synthetic forecast", async () => {
    vi.mocked(axios.post).mockRejectedValueOnce(new Error("service unavailable"));
    expect((await batchInference([candidate])).size).toBe(0);
  });
  it("does not publish a per-candidate neutral error placeholder", async () => {
    vi.mocked(axios.post).mockResolvedValueOnce({ data: { results: [{ symbol: candidate.symbol,
      scored: false, technicalRanking: { source: "error" }, composite_score: 50 }] } });
    expect((await batchInference([candidate])).size).toBe(0);
  });
  it("keeps missing sentiment unknown while preserving an observed neutral score", () => {
    const now = Date.parse("2026-10-04T10:00:00Z");
    const meta = { available: true, source: "recorded RSS", observed_at: "2026-10-04T09:00:00Z", available_at: "2026-10-04T09:05:00Z" };
    expect(inferenceSentiment(0, undefined, now)).toBeNull();
    expect(inferenceSentiment(null, meta, now)).toBeNull();
    expect(inferenceSentiment(0, meta, now)).toBe(0);
    expect(inferenceSentiment(.8, meta, now + 73 * 3600_000)).toBeNull();
    expect(inferenceSentiment(.8, { ...meta, observed_at: "2026-10-05T09:00:00Z" }, now)).toBeNull();
  });
});
