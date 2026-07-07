// Resolves Finding 1B & 2A: Redis-backed rate limiting & stricter auth rate limits
import crypto from "crypto";
import type { NextFunction, Request, Response } from "express";
import { logger } from "./logger";
import { redisClient } from "./redis";

const localHostnames = new Set(["localhost", "127.0.0.1", "::1"]);

function normalizeIp(value: string | undefined): string {
  return (value ?? "").replace(/^::ffff:/, "");
}

export function isLocalRequest(req: Request): boolean {
  const ip = normalizeIp(req.ip || req.socket.remoteAddress);
  return ip === "::1" || ip === "127.0.0.1" || ip.startsWith("127.");
}

export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  if (process.env.NODE_ENV === "test") return true;

  try {
    const url = new URL(origin);
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    if (localHostnames.has(hostname)) return true;
    
    const configured = process.env["FRONTEND_APP_URL"]?.trim();
    if (!configured) return false;
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

  if (process.env["DISABLE_REMOTE_API_AUTH"] === "1" || process.env["DISABLE_REMOTE_API_AUTH"] === "true") {
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
 * Redis-backed rate limiter (surcives server restarts).
 * Enforces 100 req/min on standard APIs, 10 req/min on sensitive auth/system endpoints.
 */
export async function apiRateLimit(req: Request, res: Response, next: NextFunction): Promise<void> {
  const ip = normalizeIp(req.ip || req.socket.remoteAddress) || "unknown";
  const isAuthRoute = req.path.includes("/auth") || req.path.includes("/token");
  
  const windowSec = 60;
  const maxRequests = isAuthRoute ? 10 : Number(process.env["UPSTOXBOT_RATE_LIMIT_MAX"] ?? 100);
  const bucketKey = `ratelimit:${isAuthRoute ? "auth" : "api"}:${ip}:${Math.floor(Date.now() / 60000)}`;

  try {
    if (redisClient.status !== "ready") {
      if (redisClient.status === "wait") redisClient.connect().catch(() => {});
      next();
      return;
    }
    const count = await redisClient.incr(bucketKey);
    if (count === 1) {
      await redisClient.expire(bucketKey, windowSec);
    }

    if (count > maxRequests) {
      const ttl = await redisClient.ttl(bucketKey);
      res.setHeader("Retry-After", Math.max(1, ttl).toString());
      res.status(429).json({ error: "Too many requests. Rate limit exceeded." });
      return;
    }
  } catch (err) {
    // If Redis fails, fail-open with logging so trading terminal continues to function
    logger.debug({ err }, "Redis rate limiter error, allowing request");
  }

  next();
}

export function logSecurityMode(): void {
  const token = process.env["UPSTOXBOT_ADMIN_TOKEN"]?.trim();
  const tokenLooksPlaceholder =
    token === "change_me_before_remote_use" ||
    token === "changeme" ||
    token === "change_me";

  if (token) {
    if (tokenLooksPlaceholder) {
      logger.error(
        "UPSTOXBOT_ADMIN_TOKEN is set to a placeholder value; remote API is not safe. Set a strong random token.",
      );
      return;
    }
    logger.info("Remote API access requires UPSTOXBOT_ADMIN_TOKEN");
    return;
  }

  logger.warn("Remote API access disabled because UPSTOXBOT_ADMIN_TOKEN is not set; local requests still work");
}
