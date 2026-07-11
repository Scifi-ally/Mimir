import { describe, expect, it } from "vitest";
import { isLocalRequest } from "./security";
import type { Request } from "express";

describe("security.ts - IP spoofing defense", () => {
  it("treats actual local connections as local", () => {
    const req = {
      socket: { remoteAddress: "127.0.0.1" },
      ip: "127.0.0.1",
    } as unknown as Request;
    
    expect(isLocalRequest(req)).toBe(true);
  });

  it("treats Docker gateway connections as local (172.x.x.x is NOT local unless configured)", () => {
    // If the socket address is a Docker gateway, it's not strictly 127.0.0.1.
    // The current implementation strictly checks for 127.x.x.x or ::1.
    const req = {
      socket: { remoteAddress: "172.18.0.1" },
      ip: "127.0.0.1", // Trust proxy might resolve X-Forwarded-For to local, but socket is 172
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
    } as unknown as Request;
    
    // It should strictly look at socket.remoteAddress, thereby rejecting the spoof
    expect(isLocalRequest(req)).toBe(false);
  });

  it("handles IPv6 loopback", () => {
    const req = {
      socket: { remoteAddress: "::1" },
      ip: "::1",
    } as unknown as Request;
    
    expect(isLocalRequest(req)).toBe(true);
  });

  it("strips ::ffff: prefix from IPv4 addresses", () => {
    const req = {
      socket: { remoteAddress: "::ffff:127.0.0.1" },
      ip: "::ffff:127.0.0.1",
    } as unknown as Request;
    
    expect(isLocalRequest(req)).toBe(true);
  });
});
