import crypto from "crypto";
import type { NextFunction, Request, Response } from "express";
import { logger } from "./logger";

const localHostnames = new Set(["localhost", "127.0.0.1", "::1"]);

function normalizeIp(value: string | undefined): string {
  return (value ?? "").replace(/^::ffff:/, "");
}

export function isLocalRequest(req: Request): boolean {
  const ip = normalizeIp(req.ip || req.socket.remoteAddress);
  // Allow localhost and Tailscale VPN IPs (100.x.y.z)
  return ip === "::1" || ip === "127.0.0.1" || ip.startsWith("127.") || ip.startsWith("100.");
}

export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;

  try {
    const url = new URL(origin);
    if (localHostnames.has(url.hostname)) return true;
    
    // Allow Tailscale MagicDNS hostnames
    if (url.hostname.endsWith(".ts.net")) return true;

    const configured = process.env["FRONTEND_APP_URL"]?.trim();
    if (!configured) return false;
    return new URL(configured).origin === url.origin;
  } catch {
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

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const rateLimitBuckets = new Map<string, RateLimitEntry>();

export function apiRateLimit(req: Request, res: Response, next: NextFunction): void {
  if (isLocalRequest(req)) {
    next();
    return;
  }

  const windowMs = Number(process.env["UPSTOXBOT_RATE_LIMIT_WINDOW_MS"] ?? 60_000);
  const maxRequests = Number(process.env["UPSTOXBOT_RATE_LIMIT_MAX"] ?? 120);
  const now = Date.now();
  const key = normalizeIp(req.ip || req.socket.remoteAddress) || "unknown";
  const current = rateLimitBuckets.get(key);

  if (!current || current.resetAt <= now) {
    rateLimitBuckets.set(key, { count: 1, resetAt: now + windowMs });
    next();
    return;
  }

  current.count += 1;
  if (current.count > maxRequests) {
    const retryAfterSeconds = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
    res.setHeader("Retry-After", retryAfterSeconds.toString());
    res.status(429).json({ error: "Too many requests" });
    return;
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
