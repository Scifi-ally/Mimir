import { sql } from "drizzle-orm";
import { db } from "../../db/src";

export type ScanJob = "OFFHOURS_SCAN" | "POSTMARKET_SCAN" | "INTRADAY_GENERATION";
export type ScanStatus = "RUNNING" | "SUCCESS" | "FAILED" | "SKIPPED";

export async function ensureScanRunTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS scan_runs (
      id bigserial PRIMARY KEY,
      job text NOT NULL,
      run_date date NOT NULL,
      status text NOT NULL,
      source text,
      message text,
      started_at timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz,
      metadata jsonb,
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (job, run_date)
    )
  `);
}

export async function getSuccessfulScanForDate(
  job: ScanJob,
  runDate: string,
): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT 1
    FROM scan_runs
    WHERE job = ${job}
      AND run_date = ${runDate}::date
      AND status = 'SUCCESS'
    LIMIT 1
  `);
  return (result.rows?.length ?? 0) > 0;
}

export async function markScanStarted(
  job: ScanJob,
  runDate: string,
  source: string,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO scan_runs (job, run_date, status, source, started_at, finished_at, updated_at)
    VALUES (${job}, ${runDate}::date, 'RUNNING', ${source}, now(), null, now())
    ON CONFLICT (job, run_date) DO UPDATE
    SET status = 'RUNNING',
        source = EXCLUDED.source,
        message = null,
        started_at = now(),
        finished_at = null,
        updated_at = now()
  `);
}

export async function markScanFinished(
  job: ScanJob,
  runDate: string,
  status: Exclude<ScanStatus, "RUNNING">,
  message?: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO scan_runs (
      job, run_date, status, message, metadata, started_at, finished_at, updated_at
    )
    VALUES (
      ${job},
      ${runDate}::date,
      ${status},
      ${message ?? null},
      ${metadata ? JSON.stringify(metadata) : null}::jsonb,
      now(),
      now(),
      now()
    )
    ON CONFLICT (job, run_date) DO UPDATE
    SET status = EXCLUDED.status,
        message = EXCLUDED.message,
        metadata = EXCLUDED.metadata,
        finished_at = now(),
        updated_at = now()
  `);
}
