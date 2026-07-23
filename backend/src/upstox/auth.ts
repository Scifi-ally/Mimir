import axios from "axios";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";
import { getConfig } from "../config";
import { db, upstoxTokenTable } from "../../db/src";
import { protectSecret, revealSecret } from "../lib/secrets";

interface UpstoxToken {
  access_token: string;
  token_type: string;
  expires_in: number;
  obtained_at: number;
}

let _tradingToken: UpstoxToken | null = null;
let _dataToken: UpstoxToken | null = null;

// When a token expires, every in-flight request (one per instrument) fails with
// 401 and calls invalidateAccessToken in a burst. After the first call the token
// is already null and the rest are redundant, but each still logged a warning
// and hit the DB. Throttle per type so a storm collapses to one log + one delete.
const INVALIDATION_THROTTLE_MS = 60_000;
const _lastInvalidatedAt: Record<"trading" | "data", number> = { trading: 0, data: 0 };

function setAccessToken(token: UpstoxToken, type: "trading" | "data" = "trading"): void {
  if (type === "trading") _tradingToken = token;
  else _dataToken = token;
  logger.info(`Upstox ${type} access token saved`);
}

export async function initAccessTokenFromDb(): Promise<void> {
  try {
    const allRows = await db.select().from(upstoxTokenTable);
    
    for (const row of allRows) {
      const type = row.id === 2 ? "data" : "trading";
      setAccessToken({
        access_token: revealSecret(row.accessToken),
        token_type: row.tokenType,
        expires_in: row.expiresIn,
        obtained_at: row.obtainedAt.getTime(),
      }, type);
    }

    if (!isDirectlyAuthenticated("trading")) await clearPersistedAccessToken("trading");
    if (!isDirectlyAuthenticated("data")) await clearPersistedAccessToken("data");
  } catch (err) {
    logger.warn({ err }, "Failed to load persisted Upstox tokens");
  }
}

async function persistAccessToken(token: UpstoxToken, type: "trading" | "data" = "trading"): Promise<void> {
  const protectedToken = protectSecret(token.access_token) ?? token.access_token;
  const id = type === "trading" ? 1 : 2;

  await db
    .insert(upstoxTokenTable)
    .values({
      id,
      accessToken: protectedToken,
      tokenType: token.token_type,
      expiresIn: token.expires_in,
      obtainedAt: new Date(token.obtained_at),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: upstoxTokenTable.id,
      set: {
        accessToken: protectedToken,
        tokenType: token.token_type,
        expiresIn: token.expires_in,
        obtainedAt: new Date(token.obtained_at),
        updatedAt: new Date(),
      },
    });
}

async function clearPersistedAccessToken(type: "trading" | "data" = "trading"): Promise<void> {
  try {
    const id = type === "trading" ? 1 : 2;
    await db.delete(upstoxTokenTable).where(eq(upstoxTokenTable.id, id));
  } catch (err) {
    logger.warn({ err }, `Failed to clear expired Upstox ${type} token`);
  }
}

function getDirectToken(type: "trading" | "data"): UpstoxToken | null {
  const token = type === "trading" ? _tradingToken : _dataToken;
  if (!token) return null;
  const now = Date.now();
  const expiresAt = token.obtained_at + token.expires_in * 1000;
  if (now >= expiresAt - 60000) {
    logger.warn(`Upstox ${type} access token expired or about to expire`);
    if (type === "trading") _tradingToken = null;
    else _dataToken = null;
    return null;
  }
  return token;
}

export function isDirectlyAuthenticated(type: "trading" | "data" = "trading"): boolean {
  return getDirectToken(type) !== null;
}

export function getDirectTokenExpiryInfo(type: "trading" | "data" = "trading"): number | null {
  const token = getDirectToken(type);
  if (!token) return null;
  return token.obtained_at + token.expires_in * 1000;
}

export function getAccessToken(type: "trading" | "data" = "trading"): string | null {
  const direct = getDirectToken(type);
  return direct?.access_token ?? null;
}

export function isAuthenticated(type?: "trading" | "data"): boolean {
  if (type) {
    return getAccessToken(type) !== null;
  }
  return getAccessToken("trading") !== null && getAccessToken("data") !== null;
}

export function getTokenExpiryInfo(type: "trading" | "data" = "trading"): number | null {
  const token = getDirectToken(type);
  if (!token) return null;
  return token.obtained_at + token.expires_in * 1000;
}

export async function invalidateAccessToken(reason?: string, type: "trading" | "data" = "trading"): Promise<void> {
  const alreadyCleared = (type === "trading" ? _tradingToken : _dataToken) === null;
  const now = Date.now();
  const throttled = alreadyCleared && now - _lastInvalidatedAt[type] < INVALIDATION_THROTTLE_MS;

  if (type === "trading") _tradingToken = null;
  else _dataToken = null;

  // A redundant invalidation within the throttle window (the rest of a 401 burst)
  // is a no-op: token is already null, so skip the DB delete and the log.
  if (throttled) return;

  _lastInvalidatedAt[type] = now;
  await clearPersistedAccessToken(type);
  logger.warn({ reason: reason ?? "unspecified" }, `Upstox ${type} access token invalidated`);
}

// Invalidate whichever token (trading and/or data) matches the exact token value
// that just failed. Callers deep in retry wrappers don't know which type they
// were handed (getAccessToken silently falls back to the other key), so guessing
// a type wipes the wrong token — this resolves it by value instead.
export async function invalidateTokenByValue(tokenValue: string, reason?: string): Promise<void> {
  if (_tradingToken?.access_token === tokenValue) await invalidateAccessToken(reason, "trading");
  if (_dataToken?.access_token === tokenValue) await invalidateAccessToken(reason, "data");
}

export function getAuthorizationUrl(state: string, type: "trading" | "data" = "trading"): string {
  const cfg = getConfig();
  
  // Use data keys if dual keys are enabled, data type requested, and they exist
  const useDataKeys = Boolean(cfg.useDualApiKeys && type === "data" && cfg.upstoxDataApiKey && cfg.upstoxDataApiSecret);
  const client_id = useDataKeys ? cfg.upstoxDataApiKey : cfg.upstoxApiKey;
  
  const params = new URLSearchParams({
    response_type: "code",
    client_id,
    redirect_uri: cfg.upstoxRedirectUri,
    state,
  });
  return `https://api-v2.upstox.com/login/authorization/dialog?${params.toString()}`;
}

export async function exchangeCodeForToken(code: string, type: "trading" | "data" = "trading"): Promise<void> {
  const cfg = getConfig();
  
  const useDataKeys = Boolean(cfg.useDualApiKeys && type === "data" && cfg.upstoxDataApiKey && cfg.upstoxDataApiSecret);
  const client_id = useDataKeys ? cfg.upstoxDataApiKey : cfg.upstoxApiKey;
  const client_secret = useDataKeys ? cfg.upstoxDataApiSecret : cfg.upstoxApiSecret;

  try {
    const response = await axios.post(
      "https://api-v2.upstox.com/login/authorization/token",
      new URLSearchParams({
        code,
        client_id,
        client_secret,
        redirect_uri: cfg.upstoxRedirectUri,
        grant_type: "authorization_code",
      }),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }
    );

    const token = {
      access_token: response.data.access_token,
      token_type: response.data.token_type,
      expires_in: response.data.expires_in ?? 86400,
      obtained_at: Date.now(),
    };

    setAccessToken(token, type);
    await persistAccessToken(token, type);
  } catch (err) {
    logger.error({ err }, `Failed to exchange Upstox auth code for ${type} token`);
    throw err;
  }
}
