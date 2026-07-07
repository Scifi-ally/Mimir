import type { Request, Response } from "express";

import { logger } from "./logger";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function logApiError(req: Request, err: any): void {
  const error = err instanceof Error ? err : new Error(String(err));
  const reqLogger = req.log || logger;
  reqLogger.error({ err: error, url: req.originalUrl || req.path }, "API request failed");
}

export function sendFallback<T>(res: Response, data: T, reason: string, status = 503): void {
  res.setHeader("X-UpstoxBot-Fallback", reason);
  res.status(status).json({
    error: "Service temporarily unavailable",
    reason,
    fallback: data,
  });
}
