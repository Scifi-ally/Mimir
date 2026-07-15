// Resolves Finding 1B & 2A: Redis-backed rate limiting & stricter auth rate limits
import crypto from "crypto";
import type { NextFunction, Request, Response } from "express";
import { logger } from "./logger";
import { redisClient } from "./redis";

const localHostnames = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

const tunnelSuffixes = [
  ".ngrok.app",
  ".ngrok-free.app",
  ".ngrok.io",
  ".trycloudflare.com",
  ".loca.lt",
  ".serveo.net",
  ".devtunnels.ms",
  ".vscode-port-forwarding.com",
  ".github.dev",
  ".gitpod.io",
  ".bore.pub",
  ".local.to"
];

function normalizeIp(value: string | undefined): string {
  return (value ?? "").replace(/^::ffff:/, "");
}

function isPrivateOrLocalIp(ip: string): boolean {
  return (
    ip === "::1" ||
    ip === "127.0.0.1" ||
    ip.startsWith("127.") ||
    /^10\./.test(ip) ||
    /^192\.168\./.test(ip) ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip)
  );
}

export function isLocalRequest(req: Request): boolean {
  if (
    process.env.ALLOW_TUNNELS === "true" ||
    process.env.ALLOW_ALL_ORIGINS === "true" ||
    process.env.ALLOW_REMOTE_ADMIN === "true"
  ) {
    return true;
  }
  const ip = normalizeIp(req.socket.remoteAddress);
  if (isPrivateOrLocalIp(ip)) {
    return true;
  }
  // If request arrived over a tunnel or reverse proxy with an allowed Origin/Host, allow it
  const origin = req.headers.origin || (req.headers.host ? `http://${req.headers.host}` : undefined);
  if (origin && isAllowedOrigin(origin)) {
    return true;
  }
  return false;
}

export function isAllowedOrigin(origin: string | undefined): boolean {
  if (
    process.env.NODE_ENV === "test" ||
    process.env.ALLOW_ALL_ORIGINS === "true" ||
    process.env.ALLOW_TUNNELS === "true"
  ) {
    return true;
  }
  if (!origin) return false;

  try {
    const url = new URL(origin);
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    if (localHostnames.has(hostname) || isPrivateOrLocalIp(hostname)) return true;

    if (tunnelSuffixes.some((suffix) => hostname.endsWith(suffix))) {
      return true;
    }

    const allowedOriginsEnv = process.env["ALLOWED_ORIGINS"]?.trim();
    if (allowedOriginsEnv) {
      const allowedList = allowedOriginsEnv.split(",").map((o) => o.trim()).filter(Boolean);
      for (const allowed of allowedList) {
        try {
          if (new URL(allowed).origin === url.origin) return true;
          if (hostname.endsWith(allowed)) return true;
        } catch {
          if (hostname === allowed || hostname.endsWith(allowed)) return true;
        }
      }
    }

    const configured = process.env["FRONTEND_APP_URL"]?.trim();
    if (!configured) return true; // Default allow in development/tunnel mode when FRONTEND_APP_URL is unset
    return new URL(configured).origin === url.origin;
  } catch (err) {
    logger.debug({ err, origin }, "isAllowedOrigin: failed to parse origin");
    return false;
  }
}

function timingSafeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function getPresentedToken(req: Request): string | null {
  const auth = req.header("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice("Bearer ".length).trim();
  return req.header("x-admin-token")?.trim() || null;
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.path === "/healthz" || req.path === "/system/auth-callback" || isLocalRequest(req)) {
    next();
    return;
  }

  const expected = process.env["UPSTOXBOT_ADMIN_TOKEN"]?.trim();
  if (!expected) {
    res.status(403).json({
      error: "Remote API access is disabled. Set UPSTOXBOT_ADMIN_TOKEN to allow authenticated remote access.",
    });
    return;
  }

  const presented = getPresentedToken(req);
  if (!presented || !timingSafeEquals(presented, expected)) {
    res.status(401).json({ error: "Admin token required" });
    return;
  }

  next();
}

/**
 * Redis-backed rate limiter (survives server restarts).
 * Enforces 100 req/min on standard APIs, 10 req/min on sensitive auth/system endpoints.
 * Uses a sliding window via Redis sorted sets.
 */
export async function apiRateLimit(req: Request, res: Response, next: NextFunction): Promise<void> {
  const ip = normalizeIp(req.ip || req.socket.remoteAddress) || "unknown";
  const isAuthRoute = req.path.includes("/auth") || req.path.includes("/token");
  
  const windowSec = 60;
  const maxRequests = isAuthRoute ? 10 : Number(process.env["UPSTOXBOT_RATE_LIMIT_MAX"] ?? 100);
  const now = Date.now();
  const bucketKey = `ratelimit:${isAuthRoute ? "auth" : "api"}:${ip}`;

  try {
    if (redisClient.status !== "ready") {
      if (redisClient.status === "wait") redisClient.connect().catch(() => {});
      const failClosed = process.env["RATE_LIMIT_FAIL_CLOSED"] === "true";
      if (failClosed) {
        res.status(503).json({ error: "Service unavailable (rate limit engine offline)" });
        return;
      }
      next();
      return;
    }
    
    // Sliding window using sorted sets
    const multi = redisClient.multi();
    // Remove old requests outside the 60s window
    multi.zremrangebyscore(bucketKey, 0, now - windowSec * 1000);
    // Count remaining requests
    multi.zcard(bucketKey);
    // Add current request
    multi.zadd(bucketKey, now.toString(), `${now}-${Math.random()}`);
    // Set expiry on the whole set so it cleans up inactive IPs
    multi.expire(bucketKey, windowSec);

    const results = await multi.exec();
    
    if (results && results.length >= 2) {
      const count = (results[1]?.[1] as number) || 0; // Result of zcard
      if (count >= maxRequests) {
        res.setHeader("Retry-After", windowSec.toString());
        res.status(429).json({ error: "Too many requests. Rate limit exceeded." });
        return;
      }
    }
  } catch (err) {
    // If Redis fails, rate limiting behavior is controlled by RATE_LIMIT_FAIL_CLOSED.
    // By default it fails-open with logging so the trading terminal continues to function offline.
    const failClosed = process.env["RATE_LIMIT_FAIL_CLOSED"] === "true";
    if (failClosed) {
      logger.error({ err }, "Redis rate limiter error, rejecting request (RATE_LIMIT_FAIL_CLOSED=true)");
      res.status(503).json({ error: "Service unavailable (rate limit engine offline)" });
      return;
    } else {
      logger.debug({ err }, "Redis rate limiter error, allowing request (fail-open)");
    }
  }

  next();
}

export function logSecurityMode(): void {
  const secretKey = process.env["UPSTOXBOT_SECRET_KEY"]?.trim();
  if (!secretKey || secretKey === "replace_with_a_long_random_secret") {
    logger.error("CRITICAL: UPSTOXBOT_SECRET_KEY is missing or insecure. Refusing to start.");
    process.exit(1);
  }

  const token = process.env["UPSTOXBOT_ADMIN_TOKEN"]?.trim();
  const tokenLooksPlaceholder =
    token === "change_me_before_remote_use" ||
    token === "changeme" ||
    token === "change_me" ||
    token === "mimir_admin_token_placeholder" ||
    token?.toLowerCase().includes("placeholder");

  if (token) {
    if (tokenLooksPlaceholder) {
      logger.error(
        "UPSTOXBOT_ADMIN_TOKEN is set to a placeholder value; remote API is not safe. Set a strong random token.",
      );
      return;
    }
    logger.info("Remote API access requires UPSTOXBOT_ADMIN_TOKEN");

    const failClosed = process.env["RATE_LIMIT_FAIL_CLOSED"] === "true";
    if (!failClosed) {
      logger.warn(
        "RATE_LIMIT_FAIL_CLOSED is not set. The rate limiter will fail open if Redis is down, which may expose the remote API to abuse."
      );
    }
    return;
  }

  logger.warn("Remote API access disabled because UPSTOXBOT_ADMIN_TOKEN is not set; local requests still work");
}
