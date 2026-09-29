import { describe, it, expect } from "vitest";
import { checkUpstoxCredentials } from "../upstox/credential_check";

const REAL_KEY = "a".repeat(32);
const REAL_SECRET = "b".repeat(32);

describe("checkUpstoxCredentials", () => {
  it("accepts well-formed 32-char alphanumeric credentials", () => {
    const r = checkUpstoxCredentials({
      apiKey: REAL_KEY,
      apiSecret: REAL_SECRET,
      redirectUri: "http://localhost:5000/api/system/auth-callback",
    });
    expect(r.ok).toBe(true);
  });

  it("rejects a missing key", () => {
    const r = checkUpstoxCredentials({
      apiKey: "",
      apiSecret: REAL_SECRET,
      redirectUri: "http://localhost:5000/api/system/auth-callback",
    });
    expect(r.ok).toBe(false);
    expect(r.problem).toMatch(/not set/i);
  });

  it("rejects a UUID placeholder and says why", () => {
    // This is the value that shipped in the committed .env: it is "configured"
    // as far as a presence check is concerned, so authorization failed opaquely
    // at Upstox's own login page.
    const r = checkUpstoxCredentials({
      apiKey: "ff949a1a-8bcb-4262-8122-6c465a1b79d9",
      apiSecret: REAL_SECRET,
      redirectUri: "http://localhost:5000/api/system/auth-callback",
    });
    expect(r.ok).toBe(false);
    expect(r.problem).toMatch(/UUID/i);
  });

  it("rejects an explicitly named placeholder", () => {
    const r = checkUpstoxCredentials({
      apiKey: "your_api_key_here_pad_it_out_x",
      apiSecret: REAL_SECRET,
      redirectUri: "http://localhost:5000/api/system/auth-callback",
    });
    expect(r.ok).toBe(false);
    expect(r.problem).toMatch(/placeholder/i);
  });

  it("rejects a wrong-length key", () => {
    const r = checkUpstoxCredentials({
      apiKey: "tooshort",
      apiSecret: REAL_SECRET,
      redirectUri: "http://localhost:5000/api/system/auth-callback",
    });
    expect(r.ok).toBe(false);
    expect(r.problem).toMatch(/32-character/);
  });

  it("validates the data pair too when dual keys are on", () => {
    const r = checkUpstoxCredentials({
      apiKey: REAL_KEY,
      apiSecret: REAL_SECRET,
      dataApiKey: "ff949a1a-8bcb-4262-8122-6c465a1b79d9",
      dataApiSecret: REAL_SECRET,
      useDualApiKeys: true,
      redirectUri: "http://localhost:5000/api/system/auth-callback",
    });
    expect(r.ok).toBe(false);
    expect(r.problem).toMatch(/DATA_API_KEY/);
  });

  it("skips the data pair when dual keys are off", () => {
    const r = checkUpstoxCredentials({
      apiKey: REAL_KEY,
      apiSecret: REAL_SECRET,
      dataApiKey: "",
      dataApiSecret: "",
      useDualApiKeys: false,
      redirectUri: "http://localhost:5000/api/system/auth-callback",
    });
    expect(r.ok).toBe(true);
  });

  it("requires an absolute redirect URI", () => {
    const r = checkUpstoxCredentials({
      apiKey: REAL_KEY,
      apiSecret: REAL_SECRET,
      redirectUri: "localhost:5000/api/system/auth-callback",
    });
    expect(r.ok).toBe(false);
    expect(r.problem).toMatch(/absolute http/i);
  });

  it("never echoes the credential value in the problem message", () => {
    const secret = "SECRETVALUE".repeat(4);
    const r = checkUpstoxCredentials({
      apiKey: "x".repeat(31),
      apiSecret: secret,
      redirectUri: "http://localhost:5000/api/system/auth-callback",
    });
    expect(r.ok).toBe(false);
    expect(r.problem).not.toContain(secret);
  });
});
