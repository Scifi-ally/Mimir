import { afterEach, describe, expect, it, vi } from "vitest";
import { apiRateLimit, isLocalRequest } from "./security";
import type { Request } from "express";

const { redisEval } = vi.hoisted(() => ({ redisEval: vi.fn() }));
vi.mock("./redis", () => ({
  redisClient: {
    status: "ready",
    eval: (...args: unknown[]) => redisEval(...args),
  },
}));

describe("security.ts - IP spoofing defense", () => {
  it("treats actual local connections as local", () => {
    const req = {
      socket: { remoteAddress: "127.0.0.1" },
      ip: "127.0.0.1",
      headers: {},
    } as unknown as Request;
    
    expect(isLocalRequest(req)).toBe(true);
  });

  it("treats Docker gateway connections as local (172.x.x.x is NOT local unless configured)", () => {
    // If the socket address is a Docker gateway, it's not strictly 127.0.0.1.
    // The current implementation strictly checks for 127.x.x.x or ::1.
    const req = {
      socket: { remoteAddress: "172.18.0.1" },
      ip: "127.0.0.1", // Trust proxy might resolve X-Forwarded-For to local, but socket is 172
      headers: {},
    } as unknown as Request;
    
    expect(isLocalRequest(req)).toBe(false);
  });

  it("ignores X-Forwarded-For spoofing", () => {
    // An attacker sends X-Forwarded-For: 127.0.0.1
    // Express with 'trust proxy: 1' sets req.ip = 127.0.0.1
    // But the actual socket connection is from outside (or from nginx proxy)
    const req = {
      socket: { remoteAddress: "203.0.113.50" },
      ip: "127.0.0.1",
      headers: {},
    } as unknown as Request;
    
    // It should strictly look at socket.remoteAddress, thereby rejecting the spoof
    expect(isLocalRequest(req)).toBe(false);
  });

  it("handles IPv6 loopback", () => {
    const req = {
      socket: { remoteAddress: "::1" },
      ip: "::1",
      headers: {},
    } as unknown as Request;
    
    expect(isLocalRequest(req)).toBe(true);
  });

  it("strips ::ffff: prefix from IPv4 addresses", () => {
    const req = {
      socket: { remoteAddress: "::ffff:127.0.0.1" },
      ip: "::ffff:127.0.0.1",
      headers: {},
    } as unknown as Request;
    
    expect(isLocalRequest(req)).toBe(true);
  });
});

describe("apiRateLimit", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const makeResponse = () => {
    const response = {
      headers: {} as Record<string, string>,
      statusCode: 200,
      body: undefined as unknown,
      setHeader(name: string, value: string) { this.headers[name] = value; return this; },
      status(code: number) { this.statusCode = code; return this; },
      json(body: unknown) { this.body = body; return this; },
    };
    return response;
  };

  it("uses one atomic Redis admission operation and allows admitted requests", async () => {
    redisEval.mockResolvedValueOnce(1);
    const req = { ip: "192.0.2.10", path: "/system/status", socket: { remoteAddress: "192.0.2.10" } } as Request;
    const res = makeResponse();
    const next = vi.fn();

    await apiRateLimit(req, res as never, next);

    expect(redisEval).toHaveBeenCalledOnce();
    expect(redisEval.mock.calls[0][0]).toContain("local count = redis.call('ZCARD'");
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(200);
  });

  it("rejects requests refused by the atomic Redis admission operation", async () => {
    redisEval.mockResolvedValueOnce(0);
    const req = { ip: "192.0.2.11", path: "/system/status", socket: { remoteAddress: "192.0.2.11" } } as Request;
    const res = makeResponse();
    const next = vi.fn();

    await apiRateLimit(req, res as never, next);

    expect(res.statusCode).toBe(429);
    expect(res.headers["Retry-After"]).toBe("60");
    expect(next).not.toHaveBeenCalled();
  });

  it("uses the safe default when the configured limit is invalid", async () => {
    vi.stubEnv("UPSTOXBOT_RATE_LIMIT_MAX", "not-a-number");
    redisEval.mockResolvedValueOnce(1);
    const req = { ip: "192.0.2.12", path: "/system/status", socket: { remoteAddress: "192.0.2.12" } } as Request;
    const res = makeResponse();

    await apiRateLimit(req, res as never, vi.fn());

    expect(redisEval.mock.calls[0][5]).toBe("100");
  });
});
