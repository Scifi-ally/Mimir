import { describe, expect, it } from "vitest";
import {
  createAnalysisTrace,
  recordAnalysisStage,
  runAnalysisStage,
} from "./analysis_contracts";

describe("analysis contracts", () => {
  it("records ordered stage metadata and degraded components", () => {
    const trace = createAnalysisTrace();
    recordAnalysisStage(trace, "feature_engineering", "ok", Date.now() - 4, {
      candidateCount: 3,
      source: "feature_engine",
    });
    recordAnalysisStage(trace, "model_inference", "degraded", Date.now() - 2, {
      candidateCount: 3,
      source: "native_fallback",
      reason: "AI service unavailable",
    });

    expect(trace.traceId).toMatch(/[0-9a-f-]{36}/);
    expect(trace.stages.map((stage) => stage.stage)).toEqual([
      "feature_engineering",
      "model_inference",
    ]);
    expect(trace.degradedComponents).toEqual(["native_fallback"]);
    expect(trace.stages[1]?.reason).toBe("AI service unavailable");
  });

  it("records failed stages and rethrows the original error", async () => {
    const trace = createAnalysisTrace();
    await expect(
      runAnalysisStage(trace, "risk_state", async () => {
        throw new Error("risk state unavailable");
      }, { source: "risk_engine" }),
    ).rejects.toThrow("risk state unavailable");

    expect(trace.stages[0]?.status).toBe("failed");
    expect(trace.stages[0]?.reason).toBe("risk state unavailable");
    expect(trace.degradedComponents).toEqual(["risk_engine"]);
  });
});
