import { describe, it, expect } from "vitest";
import { checkUpstoxCredentials } from "../upstox/credential_check";

const REAL_KEY = "a".repeat(32);
const REAL_SECRET = "b".repeat(32);
const URI = "http://localhost:5000/api/system/auth-callback";

describe("checkUpstoxCredentials", () => {
  it("accepts well-formed 32-char alphanumeric credentials with no warning", () => {
    const r = checkUpstoxCredentials({ apiKey: REAL_KEY, apiSecret: REAL_SECRET, redirectUri: URI });
    expect(r.ok).toBe(true);
    expect(r.warning).toBeUndefined();
  });

  it("blocks a missing key", () => {
    const r = checkUpstoxCredentials({ apiKey: "", apiSecret: REAL_SECRET, redirectUri: URI });
    expect(r.ok).toBe(false);
    expect(r.problem).toMatch(/not set/i);
  });

  it("blocks an explicitly named placeholder", () => {
    const r = checkUpstoxCredentials({
      apiKey: "your_api_key_here_pad_it_out_x", apiSecret: REAL_SECRET, redirectUri: URI,
    });
    expect(r.ok).toBe(false);
    expect(r.problem).toMatch(/placeholder/i);
  });

  it("ALLOWS a UUID-shaped key but warns, because only Upstox can decide validity", () => {
    // The real API was probed: posting to the exchange endpoint with a bogus
    // auth code returns Upstox's UDAPI100057 "Invalid Auth code", not an
    // invalid-client error. Upstox never rejected these credentials outright,
    // so a shape mismatch must not block the attempt.
    const r = checkUpstoxCredentials({
      apiKey: "ff949a1a-8bcb-4262-8122-6c465a1b79d9", apiSecret: REAL_SECRET, redirectUri: URI,
    });
    expect(r.ok).toBe(true);
    expect(r.problem).toBeUndefined();
    expect(r.warning).toMatch(/UUID-shaped/);
    expect(r.warning).toMatch(/still be attempted/);
  });

  it("allows an odd-length key with a warning rather than blocking", () => {
    const r = checkUpstoxCredentials({ apiKey: "x".repeat(10), apiSecret: REAL_SECRET, redirectUri: URI });
    expect(r.ok).toBe(true);
    expect(r.warning).toMatch(/32-character/);
  });

  it("warns about the data pair too when dual keys are on", () => {
    const r = checkUpstoxCredentials({
      apiKey: REAL_KEY, apiSecret: REAL_SECRET,
      dataApiKey: "24c44e9d-76af-4906-ae5c-a5ab7d126042", dataApiSecret: REAL_SECRET,
      useDualApiKeys: true, redirectUri: URI,
    });
    expect(r.ok).toBe(true);
    expect(r.warning).toMatch(/DATA_API_KEY/);
  });

  it("skips the data pair when dual keys are off", () => {
    const r = checkUpstoxCredentials({
      apiKey: REAL_KEY, apiSecret: REAL_SECRET,
      dataApiKey: "", dataApiSecret: "", useDualApiKeys: false, redirectUri: URI,
    });
    expect(r.ok).toBe(true);
  });

  it("blocks a non-absolute redirect URI", () => {
    const r = checkUpstoxCredentials({
      apiKey: REAL_KEY, apiSecret: REAL_SECRET, redirectUri: "localhost:5000/cb",
    });
    expect(r.ok).toBe(false);
    expect(r.problem).toMatch(/absolute http/i);
  });

  it("blocks a missing redirect URI", () => {
    const r = checkUpstoxCredentials({ apiKey: REAL_KEY, apiSecret: REAL_SECRET, redirectUri: "" });
    expect(r.ok).toBe(false);
    expect(r.problem).toMatch(/REDIRECT_URI/);
  });

  it("never echoes the credential value in problem or warning", () => {
    const secret = "SECRETVALUE".repeat(3);
    const r = checkUpstoxCredentials({ apiKey: "y".repeat(7), apiSecret: secret, redirectUri: URI });
    const text = `${r.problem ?? ""} ${r.warning ?? ""}`;
    expect(text).not.toContain(secret);
  });
});
