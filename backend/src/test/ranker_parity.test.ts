import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { RANKER_FEATURE_KEYS } from "../analysis/feature_engine";

describe("Ranker Feature Parity CI Guardrail", () => {
  it("RANKER_FEATURE_KEYS matches canonical ranker_features_manifest.json exactly", () => {
    const manifestPath = path.resolve(__dirname, "../../config/ranker_features_manifest.json");
    expect(fs.existsSync(manifestPath)).toBe(true);

    const manifestKeys: string[] = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    expect(RANKER_FEATURE_KEYS.length).toBe(manifestKeys.length);
    expect(Array.from(RANKER_FEATURE_KEYS)).toEqual(manifestKeys);
  });

  it("Trained Python ranker_meta.json feature_keys matches RANKER_FEATURE_KEYS exactly", () => {
    const metaPath = path.resolve(__dirname, "../../ai_service/ranker_meta.json");
    if (!fs.existsSync(metaPath)) {
      console.warn("ranker_meta.json not found — skipping trained model feature verification");
      return;
    }

    const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    const modelFeatureKeys: string[] = meta.feature_keys ?? [];

    expect(modelFeatureKeys.length).toBe(RANKER_FEATURE_KEYS.length);
    expect(modelFeatureKeys).toEqual(Array.from(RANKER_FEATURE_KEYS));
  });
});
