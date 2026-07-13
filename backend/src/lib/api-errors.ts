import type { Request, Response } from "express";

import { logger } from "./logger";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function logApiError(req: Request, err: any): void {
  const error = err instanceof Error ? err : new Error(String(err));
  const reqLogger = req.log || logger;
  reqLogger.error({ err: error, url: req.originalUrl || req.path }, "API request failed");
}

export function sendFallback<T>(res: Response, data: T, reason: string): void {
  res.setHeader("X-Mimir-Fallback", reason);
  // Return 200 to prevent browser console network errors for graceful fallbacks
  res.status(200).json(data);
}
