import { describe, expect, it } from "vitest";
import {
  isUsableInstitutionalFlowSourceDate,
  normalizeInstitutionalFlowCategory,
  parseInstitutionalFlowNetValue,
  parseInstitutionalFlowSourceDate,
} from "./fii_dii_validation";

describe("institutional flow source parsing", () => {
  it("preserves valid NSE report dates and rejects invalid or missing dates", () => {
    expect(parseInstitutionalFlowSourceDate("2026-10-02")).toBe("2026-10-02");
    expect(parseInstitutionalFlowSourceDate("02-Oct-2026")).toBe("2026-10-02");
    expect(parseInstitutionalFlowSourceDate("02-10-2026")).toBe("2026-10-02");
    expect(parseInstitutionalFlowSourceDate("2026-02-30")).toBeNull();
    expect(parseInstitutionalFlowSourceDate(undefined)).toBeNull();
    expect(isUsableInstitutionalFlowSourceDate("2026-10-02", "2026-10-02")).toBe(true);
    expect(isUsableInstitutionalFlowSourceDate("2026-09-27", "2026-10-02")).toBe(false);
    expect(isUsableInstitutionalFlowSourceDate("2026-10-03", "2026-10-02")).toBe(false);
  });

  it("parses grouped source values completely without truncation or zero substitution", () => {
    expect(parseInstitutionalFlowNetValue("1,234.56")).toBe(1234.56);
    expect(parseInstitutionalFlowNetValue("-42.5")).toBe(-42.5);
    expect(parseInstitutionalFlowNetValue("1foo")).toBeNull();
    expect(parseInstitutionalFlowNetValue("12,34.56")).toBeNull();
    expect(parseInstitutionalFlowNetValue("")).toBeNull();
    expect(parseInstitutionalFlowNetValue(null)).toBeNull();
  });

  it("accepts NSE category labels with the source footnote markers", () => {
    expect(normalizeInstitutionalFlowCategory("FII/FPI *")).toBe("FII");
    expect(normalizeInstitutionalFlowCategory("DII **")).toBe("DII");
    expect(normalizeInstitutionalFlowCategory("OTHER")).toBeNull();
  });
});

