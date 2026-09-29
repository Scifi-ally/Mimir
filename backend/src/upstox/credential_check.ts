/**
 * Upstox credential shape validation.
 *
 * Why this exists
 * ───────────────
 * The auth flow previously checked only that `UPSTOX_API_KEY` / `_SECRET` were
 * non-empty. A placeholder value therefore sailed through, the user was handed a
 * real Upstox OAuth URL, and the failure surfaced as an opaque error on
 * Upstox's own login page with no indication that the problem was local. In this
 * repo the committed .env carries a UUID where the API key should be, which
 * looks "configured" to every presence check.
 *
 * Upstox issues 32-character alphanumeric API keys and 32-character API
 * secrets. A UUID is unambiguous evidence that the value is a placeholder, not
 * a real credential, so it is worth catching before the user is sent anywhere.
 *
 * This never logs or returns the secret itself, only which check failed.
 */

/** Real Upstox API keys and secrets are 32-char alphanumeric strings. */
const UPSTOX_CREDENTIAL_RE = /^[A-Za-z0-9]{32}$/;

/** A UUID can never be an Upstox key, so name it explicitly for a clear message. */
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
  ok: boolean;
  /** Human-readable reason, safe to surface in the UI. Never contains the value. */
  problem?: string;
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

  if (UUID_RE.test(trimmed)) {
    return {
      ok: false,
      problem:
        `${label} is a UUID, which is a placeholder rather than a real Upstox key. ` +
        `Upstox issues a 32-character alphanumeric key from ` +
        `https://upstox.com/developer/api-documentation`,
    };
  }

  if (!UPSTOX_CREDENTIAL_RE.test(trimmed)) {
    return {
      ok: false,
      problem:
        `${label} is ${trimmed.length} characters; Upstox API keys/secrets are ` +
        `32-character alphanumeric strings`,
    };
  }

  return { ok: true };
}

export function checkUpstoxCredentials(creds: {
  apiKey: string;
  apiSecret: string;
  dataApiKey?: string;
  dataApiSecret?: string;
  useDualApiKeys?: boolean;
  redirectUri?: string;
}): CredentialCheck {
  const keyCheck = checkOne("UPSTOX_API_KEY", creds.apiKey);
  if (!keyCheck.ok) return keyCheck;

  const secretCheck = checkOne("UPSTOX_API_SECRET", creds.apiSecret);
  if (!secretCheck.ok) return secretCheck;

  if (creds.useDualApiKeys) {
    const dataKey = checkOne("UPSTOX_DATA_API_KEY", creds.dataApiKey ?? "");
    if (!dataKey.ok) return dataKey;
    const dataSecret = checkOne("UPSTOX_DATA_API_SECRET", creds.dataApiSecret ?? "");
    if (!dataSecret.ok) return dataSecret;
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

  return { ok: true };
}
