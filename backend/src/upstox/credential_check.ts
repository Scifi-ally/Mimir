/**
 * Upstox credential pre-flight.
 *
 * Why this exists
 * ───────────────
 * The auth flow only checked that `UPSTOX_API_KEY` / `_SECRET` were non-empty.
 * A placeholder therefore sailed through and the user was handed a real Upstox
 * OAuth URL, where the failure surfaced with no hint that the local config was
 * the problem.
 *
 * What it does and does NOT decide
 * ────────────────────────────────
 * Observed against the live API: posting to the exchange endpoint the app uses
 * (https://api-v2.upstox.com/login/authorization/token) with a deliberately
 * bogus `code` returns Upstox's own `UDAPI100057 "Invalid Auth code"`. Upstox
 * accepted the request and objected to the auth code - it did NOT reject the
 * client credentials. So a shape mismatch cannot prove the credentials are
 * invalid; only Upstox can.
 *
 * Therefore this module BLOCKS only on things that cannot possibly work (a
 * missing value, an explicitly named placeholder, a non-absolute redirect URI)
 * and WARNS - without blocking - when the shape merely looks unusual. The
 * warning is surfaced to the UI so a suspicious key is visible before login,
 * but it never prevents an attempt that might still succeed.
 *
 * This never logs or returns the secret itself, only which check failed.
 */

/** Upstox documents API keys/secrets as 32-character alphanumeric strings. */
const UPSTOX_CREDENTIAL_RE = /^[A-Za-z0-9]{32}$/;

/** A UUID is not Upstox's documented key shape, but Upstox remains the authority. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PLACEHOLDER_HINTS = [
  "your_api_key",
  "your_api_secret",
  "changeme",
  "placeholder",
  "example",
  "dummy",
  "insert_",
  "replace_",
];

export interface CredentialCheck {
  /** True when an authorization attempt is worth making. */
  ok: boolean;
  /** Blocking reason, safe to surface in the UI. Never contains the value. */
  problem?: string;
  /**
   * Non-blocking advisory, present when a value is shaped unlike a real Upstox
   * key. Surfaced in the UI, but the attempt is still allowed.
   */
  warning?: string;
}

function checkOne(label: string, value: string): CredentialCheck {
  const trimmed = (value ?? "").trim();

  if (!trimmed) {
    return { ok: false, problem: `${label} is not set` };
  }

  const lower = trimmed.toLowerCase();
  if (PLACEHOLDER_HINTS.some((h) => lower.includes(h))) {
    return { ok: false, problem: `${label} still contains a placeholder value` };
  }

  if (UPSTOX_CREDENTIAL_RE.test(trimmed)) {
    return { ok: true };
  }

  if (UUID_RE.test(trimmed)) {
    return {
      ok: true,
      warning:
        `${label} is UUID-shaped, not Upstox's documented 32-character ` +
        `alphanumeric key. Authorization will still be attempted; if it fails, ` +
        `check the key at https://upstox.com/developer/api-documentation`,
    };
  }

  return {
    ok: true,
    warning:
      `${label} is ${trimmed.length} characters; Upstox documents 32-character ` +
      `alphanumeric keys. Authorization will still be attempted.`,
  };
}

export function checkUpstoxCredentials(creds: {
  apiKey: string;
  apiSecret: string;
  dataApiKey?: string;
  dataApiSecret?: string;
  useDualApiKeys?: boolean;
  redirectUri?: string;
}): CredentialCheck {
  const warnings: string[] = [];

  const keyCheck = checkOne("UPSTOX_API_KEY", creds.apiKey);
  if (!keyCheck.ok) return keyCheck;
  if (keyCheck.warning) warnings.push(keyCheck.warning);

  const secretCheck = checkOne("UPSTOX_API_SECRET", creds.apiSecret);
  if (!secretCheck.ok) return secretCheck;
  if (secretCheck.warning) warnings.push(secretCheck.warning);

  if (creds.useDualApiKeys) {
    const dataKey = checkOne("UPSTOX_DATA_API_KEY", creds.dataApiKey ?? "");
    if (!dataKey.ok) return dataKey;
    if (dataKey.warning) warnings.push(dataKey.warning);
    const dataSecret = checkOne("UPSTOX_DATA_API_SECRET", creds.dataApiSecret ?? "");
    if (!dataSecret.ok) return dataSecret;
    if (dataSecret.warning) warnings.push(dataSecret.warning);
  }

  if (!creds.redirectUri) {
    return { ok: false, problem: "UPSTOX_REDIRECT_URI is not set" };
  }
  if (!/^https?:\/\//i.test(creds.redirectUri)) {
    return {
      ok: false,
      problem: `UPSTOX_REDIRECT_URI must be an absolute http(s) URL, got "${creds.redirectUri}"`,
    };
  }

  return { ok: true, warning: warnings.length ? warnings.join("; ") : undefined };
}
