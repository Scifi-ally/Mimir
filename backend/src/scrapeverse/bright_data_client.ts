import { logger } from "../lib/logger";

const DEFAULT_API_BASE_URL = "https://api.brightdata.com";
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_POLL_TIMEOUT_MS = 5 * 60_000;

export interface BrightDataConfig {
  apiToken: string | null;
  collectorId: string | null;
  sourceUrl: string;
  apiBaseUrl: string;
}

export interface BrightDataCollectionResult {
  collectionId: string;
  rows: unknown[];
  startedAt: Date;
  completedAt: Date;
}

export type BrightDataRunResult =
  | { status: "not_configured"; reason: string }
  | { status: "completed"; result: BrightDataCollectionResult }
  | { status: "failed"; reason: string; collectionId?: string };

export function getBrightDataConfig(env: NodeJS.ProcessEnv = process.env): BrightDataConfig {
  return {
    apiToken: env.BRIGHT_DATA_API_TOKEN?.trim() || null,
    collectorId: env.BRIGHT_DATA_FII_DII_COLLECTOR_ID?.trim() || null,
    sourceUrl: env.BRIGHT_DATA_FII_DII_SOURCE_URL?.trim() || "https://www.nseindia.com/reports/fii-dii",
    apiBaseUrl: (env.BRIGHT_DATA_API_BASE_URL?.trim() || DEFAULT_API_BASE_URL).replace(/\/$/, ""),
  };
}

function safeErrorReason(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 500);
  return String(error).slice(0, 500);
}

async function requestJson(
  url: string,
  init: RequestInit,
): Promise<unknown> {
  const response = await fetch(url, init);
  const text = await response.text();
  const body: unknown = (() => {
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return text.slice(0, 500);
    }
  })();
  if (!response.ok) {
    const detail = typeof body === "object" && body !== null ? JSON.stringify(body) : String(body);
    throw new Error(`Bright Data request failed (${response.status}): ${detail.slice(0, 500)}`);
  }
  return body;
}

async function triggerCollection(config: BrightDataConfig): Promise<{ collectionId: string; startedAt: Date }> {
  if (!config.apiToken || !config.collectorId) {
    throw new Error("Bright Data API token and FII/DII collector ID are required");
  }
  const url = new URL("/dca/trigger", config.apiBaseUrl);
  url.searchParams.set("collector", config.collectorId);
  url.searchParams.set("queue_next", "1");
  const body = await requestJson(url.toString(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify([{ url: config.sourceUrl }]),
  });
  const collectionId = typeof body === "object" && body !== null && "collection_id" in body
    ? (body as { collection_id?: unknown }).collection_id
    : null;
  if (typeof collectionId !== "string" || !collectionId.trim()) {
    throw new Error("Bright Data trigger response did not contain collection_id");
  }
  return { collectionId, startedAt: new Date() };
}

async function pollCollection(
  config: BrightDataConfig,
  collectionId: string,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  timeoutMs = DEFAULT_POLL_TIMEOUT_MS,
): Promise<unknown[]> {
  if (!config.apiToken) throw new Error("Bright Data API token is required");
  const deadline = Date.now() + timeoutMs;
  const url = new URL("/dca/dataset", config.apiBaseUrl);
  url.searchParams.set("id", collectionId);

  while (Date.now() <= deadline) {
    const body = await requestJson(url.toString(), {
      method: "GET",
      headers: { Authorization: `Bearer ${config.apiToken}` },
    });
    if (Array.isArray(body)) return body;
    if (typeof body === "object" && body !== null) {
      const status = (body as { status?: unknown }).status;
      if (status === "failed" || status === "error") {
        throw new Error(`Bright Data collection ${collectionId} failed`);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error(`Bright Data collection ${collectionId} timed out after ${timeoutMs}ms`);
}

export async function runBrightDataCollection(
  options: {
    config?: BrightDataConfig;
    pollIntervalMs?: number;
    timeoutMs?: number;
  } = {},
): Promise<BrightDataRunResult> {
  const config = options.config ?? getBrightDataConfig();
  if (!config.apiToken || !config.collectorId) {
    return {
      status: "not_configured",
      reason: "Bright Data is not configured: set BRIGHT_DATA_API_TOKEN and BRIGHT_DATA_FII_DII_COLLECTOR_ID after publishing the collector.",
    };
  }

  try {
    const triggered = await triggerCollection(config);
    const rows = await pollCollection(
      config,
      triggered.collectionId,
      options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      options.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS,
    );
    return {
      status: "completed",
      result: {
        collectionId: triggered.collectionId,
        rows,
        startedAt: triggered.startedAt,
        completedAt: new Date(),
      },
    };
  } catch (error) {
    const reason = safeErrorReason(error);
    logger.warn({ reason }, "Bright Data Scraper Studio collection failed");
    return { status: "failed", reason };
  }
}
