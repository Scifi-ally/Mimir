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

export function isPrivateOrLocalIp(ip: string): boolean {
  // Loopback and directly-attached LAN ranges only. Deliberately EXCLUDES
  // 172.16/12: that's the Docker bridge range — a dockerized reverse proxy
  // makes ALL internet traffic arrive from a 172.x gateway address, which
  // would silently grant remote clients local-admin access. Docker/remote
  // deployments must authenticate (UPSTOXBOT_ADMIN_TOKEN) or opt in via
  // ALLOW_REMOTE_ADMIN=true.
  return (
    ip === "::1" ||
    ip === "127.0.0.1" ||
    ip.startsWith("127.") ||
    /^10\./.test(ip) ||
    /^192\.168\./.test(ip)
  );
}

export function isLocalRequest(req: Request): boolean {
  if (
    process.env.ALLOW_ALL_ORIGINS === "true" ||
    process.env.ALLOW_REMOTE_ADMIN === "true" ||
    process.env.ALLOW_TUNNELS === "true"
  ) {
    return true;
  }
  
  // If request has Cloudflare headers, it's NOT local.
  if (req.headers["cf-connecting-ip"] || req.headers["cf-ray"]) {
    return false;
  }

  // If X-Forwarded-For is present and contains non-local IPs, it's not local.
  const xForwardedFor = req.headers["x-forwarded-for"];
  if (typeof xForwardedFor === "string") {
    const ips = xForwardedFor.split(",").map(ip => normalizeIp(ip.trim()));
    if (ips.some(ip => !isPrivateOrLocalIp(ip))) {
      return false;
    }
  }

  const ip = normalizeIp(req.socket.remoteAddress);
  return isPrivateOrLocalIp(ip);
}

export function isAllowedOrigin(origin: string | undefined): boolean {
  if (
    process.env.NODE_ENV === "test" ||
    process.env.ALLOW_ALL_ORIGINS === "true"
  ) {
    return true;
  }
  if (!origin) return false;

  try {
    const url = new URL(origin);
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    if (localHostnames.has(hostname) || isPrivateOrLocalIp(hostname)) return true;

    if (process.env.ALLOW_TUNNELS === "true" && tunnelSuffixes.some((suffix) => hostname.endsWith(suffix))) {
      return true;
    }

    const allowedOriginsEnv = process.env["ALLOWED_ORIGINS"]?.trim();
    if (allowedOriginsEnv) {
      const allowedList = allowedOriginsEnv.split(",").map((o) => o.trim()).filter(Boolean);
      for (const allowed of allowedList) {
        try {
          if (new URL(allowed).origin === url.origin) return true;
        } catch {
          if (hostname === allowed) return true;
        }
      }
    }

    const configured = process.env["FRONTEND_APP_URL"]?.trim();
    if (configured) {
      return new URL(configured).origin === url.origin;
    }
    return false;
  } catch (err) {
    logger.debug({ err, origin }, "isAllowedOrigin: failed to parse origin");
    return false;
  }
}

function timingSafeEquals(a: string, b: string): boolean {
  const hashA = crypto.createHash("sha256").update(a).digest();
  const hashB = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(hashA, hashB);
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
 * Uses a sliding window via Redis sorted sets. Degrades to an in-memory fallback if Redis is offline.
 */
const inMemoryRateLimits = new Map<string, number[]>();

export async function apiRateLimit(req: Request, res: Response, next: NextFunction): Promise<void> {
  const ip = normalizeIp(req.ip || req.socket.remoteAddress) || "unknown";
  const isAuthRoute = req.path.includes("/auth") || req.path.includes("/token");
  
  const windowSec = 60;
  const maxRequests = isAuthRoute ? 10 : Number(process.env["UPSTOXBOT_RATE_LIMIT_MAX"] ?? 100);
  const now = Date.now();
  const bucketKey = `ratelimit:${isAuthRoute ? "auth" : "api"}:${ip}`;

  const applyInMemoryFallback = (): boolean => {
    let requests = inMemoryRateLimits.get(bucketKey) || [];
    requests = requests.filter(time => now - time < windowSec * 1000);
    if (requests.length >= maxRequests) {
      res.setHeader("Retry-After", windowSec.toString());
      res.status(429).json({ error: "Too many requests. Rate limit exceeded." });
      return false;
    }
    requests.push(now);
    inMemoryRateLimits.set(bucketKey, requests);
    // Cleanup old keys occasionally to prevent memory leaks in the fallback map
    if (Math.random() < 0.01) {
      for (const [key, times] of inMemoryRateLimits.entries()) {
        const valid = times.filter(t => now - t < windowSec * 1000);
        if (valid.length === 0) inMemoryRateLimits.delete(key);
        else inMemoryRateLimits.set(key, valid);
      }
    }
    return true;
  };

  try {
    if (redisClient.status !== "ready") {
      if (redisClient.status === "wait") redisClient.connect().catch(() => {});
      if (!applyInMemoryFallback()) return;
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
    logger.warn({ err }, "Redis rate limiter error, degrading to in-memory fallback");
    if (!applyInMemoryFallback()) return;
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
