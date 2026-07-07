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

function setAccessToken(token: UpstoxToken, type: "trading" | "data" = "trading"): void {
  if (type === "trading") _tradingToken = token;
  else _dataToken = token;
  logger.info(`Upstox ${type} access token saved`);
}

export async function initAccessTokenFromDb(): Promise<void> {
  try {
    await db
      .select()
      .from(upstoxTokenTable);
    
    // I need to use raw SQL or a proper query
    // Let me rewrite this cleanly
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

    if (!getAccessToken("trading")) await clearPersistedAccessToken("trading");
    if (!getAccessToken("data")) await clearPersistedAccessToken("data");
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

export function getAccessToken(type: "trading" | "data" = "trading"): string | null {
  const token = type === "trading" ? _tradingToken : _dataToken;
  
  if (!token) {
    // Fallback: if data token is requested but not available, use trading token
    if (type === "data" && _tradingToken) {
       // Validate trading token before returning
       return getAccessToken("trading");
    }
    return null;
  }
  
  const now = Date.now();
  const expiresAt = token.obtained_at + token.expires_in * 1000;
  
  if (now >= expiresAt - 60000) {
    logger.warn(`Upstox ${type} access token expired or about to expire`);
    if (type === "trading") _tradingToken = null;
    else _dataToken = null;
    
    if (type === "data" && _tradingToken) {
       return getAccessToken("trading");
    }
    return null;
  }
  return token.access_token;
}

export function isAuthenticated(): boolean {
  return getAccessToken("trading") !== null;
}

export function getTokenExpiryInfo(type: "trading" | "data" = "trading"): number | null {
  const token = type === "trading" ? _tradingToken : _dataToken;
  if (!token) return null;
  return token.obtained_at + token.expires_in * 1000;
}

export async function invalidateAccessToken(reason?: string, type: "trading" | "data" = "trading"): Promise<void> {
  if (type === "trading") _tradingToken = null;
  else _dataToken = null;
  await clearPersistedAccessToken(type);
  logger.warn({ reason: reason ?? "unspecified" }, `Upstox ${type} access token invalidated`);
}

export function getAuthorizationUrl(state: string, type: "trading" | "data" = "trading"): string {
  const cfg = getConfig();
  
  // Use data keys if data type requested and they exist, otherwise fallback to trading keys
  const useDataKeys = type === "data" && cfg.upstoxDataApiKey && cfg.upstoxDataApiSecret;
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
  
  const useDataKeys = type === "data" && cfg.upstoxDataApiKey && cfg.upstoxDataApiSecret;
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
