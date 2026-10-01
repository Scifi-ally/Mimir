import { sql } from "drizzle-orm";
import { db } from "../../db/src";
import { logger } from "../lib/logger";

/**
 * Agent cognition log.
 *
 * The scan -> signal -> suggestion loop has always run on its own via the
 * scheduler, and there has been no way to ask it what it thought. Everything the
 * platform decided was only visible after the fact, scattered across
 * rejected_candidates and per-symbol rows.
 *
 * This records each autonomous cycle in one place - how many symbols were
 * considered, how many survived, and WHY the rest did not - so the agent's
 * reasoning is inspectable rather than inferred. That matters most when the
 * answer is "nothing happened": a blank UI is indistinguishable from a broken
 * pipeline, which is the failure this whole cleanup has been undoing.
 *
 * Deliberately not persisted to a table. The summary is derived from live data
 * plus a small in-memory ring, so it cannot become another table with no writer.
 */

export interface AgentCycle {
  startedAt: string;
  source: string;
  /** Symbols the scanner evaluated. */
  evaluated: number;
  /** Candidates that passed every gate and were written as suggestions. */
  suggested: number;
  /** Candidate count by rejection reason, highest first. */
  rejectionCounts: Record<string, number>;
  /** Which trained models actually contributed to this cycle's decisions. */
  contributingModels: Record<string, boolean>;
  durationMs: number;
  ok: boolean;
  error?: string;
}

const MAX_CYCLES = 50;
const cycles: AgentCycle[] = [];
let current: Omit<AgentCycle, "durationMs" | "ok"> | null = null;
let startedMs = 0;

export const agentCognition = {
  /** Open a cycle. Safe to call again while one is open; the earlier one closes. */
  begin(source: string): void {
    if (current) {
      this.finish(true);
    }
    current = {
      startedAt: new Date().toISOString(),
      source,
      evaluated: 0,
      suggested: 0,
      rejectionCounts: {},
      contributingModels: {},
    };
    startedMs = Date.now();
  },

  /** Record a rejection reason. Called once per blocked candidate. */
  reject(reason: string): void {
    if (!current) return;
    current.rejectionCounts[reason] = (current.rejectionCounts[reason] ?? 0) + 1;
  },

  /** Record that N symbols were considered. */
  evaluated(n: number): void {
    if (current) current.evaluated += n;
  },

  /** Record a suggestion that survived every gate. */
  suggested(): void {
    if (current) current.suggested += 1;
  },

  finish(ok: boolean, error?: string): AgentCycle | null {
    if (!current) return null;
    const cycle: AgentCycle = {
      ...current,
      durationMs: Date.now() - startedMs,
      ok,
      ...(error ? { error } : {}),
    };
    cycles.unshift(cycle);
    if (cycles.length > MAX_CYCLES) cycles.length = MAX_CYCLES;
    current = null;
    return cycle;
  },

  recent(limit = 10): AgentCycle[] {
    return cycles.slice(0, Math.max(1, Math.min(limit, MAX_CYCLES)));
  },

  running(): boolean {
    return current !== null;
  },
};

/**
 * Top reasons across a set of cycles, flattened.
 *
 * This is the single most useful view when nothing was suggested: it separates
 * "the scanner found nothing" from "every candidate was blocked at the risk
 * engine", which look identical on a blank screen.
 */
export function summariseRejectionReasons(
  recentCycles: AgentCycle[],
): Array<{ reason: string; count: number }> {
  const totals: Record<string, number> = {};
  for (const c of recentCycles) {
    for (const [reason, count] of Object.entries(c.rejectionCounts)) {
      totals[reason] = (totals[reason] ?? 0) + count;
    }
  }
  return Object.entries(totals)
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Live counts from the database, so the status endpoint reflects reality even
 * before the first cycle has run in this process.
 */
export async function liveOutcomeCounts(): Promise<{
  pendingSuggestions: number;
  activeSuggestions: number;
  closedOutcomes: number;
  rejectedCandidates: number;
}> {
  try {
    const count = async (fragment: string): Promise<number> => {
      const res = await db.execute(sql.raw(fragment));
      const row = (res as unknown as { rows?: Array<{ n: number }> }).rows?.[0];
      return typeof row?.n === "number" ? row.n : 0;
    };

    return {
      pendingSuggestions: await count(
        `select count(*)::int as n from suggestions where status = 'PENDING'`,
      ),
      activeSuggestions: await count(
        `select count(*)::int as n from suggestions where status = 'ACTIVE'`,
      ),
      closedOutcomes: await count(`select count(*)::int as n from signal_outcomes`),
      rejectedCandidates: await count(
        `select count(*)::int as n from rejected_candidates`,
      ),
    };
  } catch (err) {
    logger.warn({ err }, "agent status: could not read live counts");
    return {
      pendingSuggestions: 0,
      activeSuggestions: 0,
      closedOutcomes: 0,
      rejectedCandidates: 0,
    };
  }
}