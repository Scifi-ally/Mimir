import { describe, expect, it, vi } from "vitest";
vi.unmock("./option_chain");
import { parseOptionChainSourceTimestamp } from "./option_chain";

describe("NSE option-chain source timestamps", () => {
  it("parses NSE local timestamps as IST", () => {
    expect(parseOptionChainSourceTimestamp("02-Oct-2026 09:59:00")?.toISOString())
      .toBe("2026-10-02T04:29:00.000Z");
  });

  it("rejects missing, malformed, and invalid calendar timestamps", () => {
    expect(parseOptionChainSourceTimestamp(undefined)).toBeNull();
    expect(parseOptionChainSourceTimestamp("02-XXX-2026 09:59:00")).toBeNull();
    expect(parseOptionChainSourceTimestamp("31-Feb-2026 09:59:00")).toBeNull();
  });
});
