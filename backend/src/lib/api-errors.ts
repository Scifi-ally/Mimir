import type { Request, Response } from "express";

import { logger } from "./logger";

export function logApiError(req: Request, err: any): void {
  const error = err instanceof Error ? err : new Error(String(err));
  const reqLogger = req.log || logger;
  const sanitizedUrl = (req.originalUrl || req.path || "").split("?")[0];
  reqLogger.error({ err: error, url: sanitizedUrl }, "API request failed");
}

export function sendFallback<T>(res: Response, data: T, reason: string): void {
  res.setHeader("X-Mimir-Fallback", reason);
  // Return 200 to prevent browser console network errors for graceful fallbacks
  res.status(200).json(data);
}
