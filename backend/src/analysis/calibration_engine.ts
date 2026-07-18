/**
 * Empirical Confidence Calibration
 * ─────────────────────────────────────────────────────────────────────────────
 * The AI confidence score is uncalibrated (see paper_engine Issue #17). This
 * module replaces belief with measurement: it aggregates CLOSED suggestion
 * outcomes into per-(setupType × tradeType) win rates and MFE/MAE stats, then
 * blends them into new signals' confidence.
 *
 * Blend rule (sample-size aware):
 *   n < 10   → raw model confidence (not enough evidence)
 *   n >= 10  → weight empirical win rate by min(n, 50)/50, model by the rest
 *
 * MFE/MAE (from highestPrice/lowestPrice watermarks) also yields a suggested
 * stop multiple: if winners rarely go more than X·ATR against entry, stops
 * wider than that are dead capital.
 *
 * Cache refreshes every 6h (and on demand) — outcomes accrue slowly.
 */

import { db } from "../../db/src";
import { suggestionsTable } from "../../db/src";
import { inArray, gte, and } from "drizzle-orm";
import { logger } from "../lib/logger";

const CLOSED_STATUSES = ["TARGET_1_HIT", "TARGET_2_HIT", "STOP_HIT", "EXPIRED", "CLOSED"];
const WIN_STATUSES = new Set(["TARGET_1_HIT", "TARGET_2_HIT"]);
const LOOKBACK_DAYS = 120;
const MIN_SAMPLES = 10;
const FULL_WEIGHT_SAMPLES = 50;

export interface SetupCalibration {
  setupType: string;
  tradeType: string;
  samples: number;
  winRate: number;            // 0..1, TARGET hits / all closed
  avgPnlInr: number;
  // MAE: how far price went AGAINST entry on winning trades, as fraction of entry
  avgAdverseExcursionPct: number | null;
  // MFE on losing trades: how much favorable move losers had before stopping out
  avgFavorableOnLossPct: number | null;
  // Median realized time from generation to target hit (winners only), minutes
  medianTimeToTargetMin: number | null;
}

let calibrationCache = new Map<string, SetupCalibration>();
let cacheTime = 0;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
let refreshInFlight: Promise<void> | null = null;

function key(setupType: string, tradeType: string): string {
  return `${setupType}|${tradeType}`;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export async function refreshCalibration(): Promise<void> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    try {
      const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
      const rows = await db
        .select({
          setupType: suggestionsTable.setupType,
          tradeType: suggestionsTable.tradeType,
          status: suggestionsTable.status,
          direction: suggestionsTable.direction,
          entryPrice: suggestionsTable.entryPrice,
          pnlInr: suggestionsTable.pnlInr,
          highestPrice: suggestionsTable.highestPrice,
          lowestPrice: suggestionsTable.lowestPrice,
          generatedAt: suggestionsTable.generatedAt,
          closedAt: suggestionsTable.closedAt,
        })
        .from(suggestionsTable)
        .where(
          and(
            inArray(suggestionsTable.status, CLOSED_STATUSES),
            gte(suggestionsTable.generatedAt, since),
          ),
        );

      const buckets = new Map<
        string,
        {
          setupType: string;
          tradeType: string;
          wins: number;
          total: number;
          pnlSum: number;
          maeOnWinSum: number;
          maeOnWinCount: number;
          mfeOnLossSum: number;
          mfeOnLossCount: number;
          winDurationsMin: number[];
        }
      >();

      for (const row of rows) {
        const k = key(row.setupType, row.tradeType);
        const b =
          buckets.get(k) ??
          {
            setupType: row.setupType,
            tradeType: row.tradeType,
            wins: 0,
            total: 0,
            pnlSum: 0,
            maeOnWinSum: 0,
            maeOnWinCount: 0,
            mfeOnLossSum: 0,
            mfeOnLossCount: 0,
            winDurationsMin: [],
          };

        const isWin = WIN_STATUSES.has(row.status);
        b.total += 1;
        if (isWin) {
          b.wins += 1;
          if (row.closedAt) {
            const mins = (row.closedAt.getTime() - row.generatedAt.getTime()) / 60_000;
            if (mins > 0 && mins < 60 * 24 * 30) b.winDurationsMin.push(mins);
          }
        }
        const pnl = row.pnlInr != null ? parseFloat(row.pnlInr) : 0;
        b.pnlSum += Number.isFinite(pnl) ? pnl : 0; // guard NaN from malformed rows

        const entry = parseFloat(row.entryPrice);
        const high = row.highestPrice ? parseFloat(row.highestPrice) : null;
        const low = row.lowestPrice ? parseFloat(row.lowestPrice) : null;
        if (entry > 0 && high !== null && low !== null) {
          const isBuy = row.direction === "BUY";
          // Adverse excursion: worst move against the position
          const advPct = isBuy ? (entry - low) / entry : (high - entry) / entry;
          // Favorable excursion: best move in the position's favor
          const favPct = isBuy ? (high - entry) / entry : (entry - low) / entry;
          if (isWin && advPct >= 0) {
            b.maeOnWinSum += advPct;
            b.maeOnWinCount += 1;
          }
          if (!isWin && row.status === "STOP_HIT" && favPct >= 0) {
            b.mfeOnLossSum += favPct;
            b.mfeOnLossCount += 1;
          }
        }

        buckets.set(k, b);
      }

      const next = new Map<string, SetupCalibration>();
      for (const [k, b] of buckets) {
        next.set(k, {
          setupType: b.setupType,
          tradeType: b.tradeType,
          samples: b.total,
          winRate: b.total > 0 ? b.wins / b.total : 0,
          avgPnlInr: b.total > 0 ? b.pnlSum / b.total : 0,
          avgAdverseExcursionPct: b.maeOnWinCount > 0 ? b.maeOnWinSum / b.maeOnWinCount : null,
          avgFavorableOnLossPct: b.mfeOnLossCount > 0 ? b.mfeOnLossSum / b.mfeOnLossCount : null,
          medianTimeToTargetMin: median(b.winDurationsMin),
        });
      }

      calibrationCache = next;
      cacheTime = Date.now();
      logger.info(
        { buckets: next.size, closedTrades: rows.length, lookbackDays: LOOKBACK_DAYS },
        "Confidence calibration refreshed from outcomes",
      );
    } catch (err) {
      logger.error({ err }, "Failed to refresh confidence calibration");
    }
  })().finally(() => {
    refreshInFlight = null;
  });

  return refreshInFlight;
}

export async function ensureFresh(): Promise<void> {
  if (Date.now() - cacheTime > CACHE_TTL_MS) await refreshCalibration();
}

export function getCalibration(setupType: string, tradeType: string): SetupCalibration | null {
  return calibrationCache.get(key(setupType, tradeType)) ?? null;
}

export function getAllCalibrations(): SetupCalibration[] {
  return Array.from(calibrationCache.values());
}

/**
 * Blend model confidence (0-100) with the empirical win rate for the setup.
 * Empirical weight scales with sample count; below MIN_SAMPLES the model
 * confidence passes through untouched.
 */
export async function calibrateConfidence(
  modelConfidence: number,
  setupType: string,
  tradeType: string,
): Promise<{ confidence: number; empirical: SetupCalibration | null }> {
  await ensureFresh();
  const cal = getCalibration(setupType, tradeType);
  if (!cal || cal.samples < MIN_SAMPLES) {
    return { confidence: modelConfidence, empirical: cal };
  }

  const w = Math.min(cal.samples, FULL_WEIGHT_SAMPLES) / FULL_WEIGHT_SAMPLES;
  const empiricalScore = cal.winRate * 100;
  const blended = Math.round(empiricalScore * w + modelConfidence * (1 - w));
  return { confidence: Math.max(0, Math.min(100, blended)), empirical: cal };
}

// ── Walk-forward auto-demotion ────────────────────────────────────────────────
// Setups whose rolling 90d realized expectancy turns negative are demoted:
// still detected/displayed, never turned into suggestions — same treatment the
// backtest applied statically to BREAKDOWN/BEAR_MOMENTUM/etc. This keeps the
// static kill-list honest as market character drifts.

const DEMOTION_LOOKBACK_DAYS = 90;
const DEMOTION_MIN_TRADES = 15;

let demotedSetups = new Set<string>();
let demotionRefreshedAt = 0;

export async function refreshSetupDemotions(): Promise<Set<string>> {
  try {
    const since = new Date(Date.now() - DEMOTION_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    const rows = await db
      .select({
        setupType: suggestionsTable.setupType,
        status: suggestionsTable.status,
        pnlInr: suggestionsTable.pnlInr,
      })
      .from(suggestionsTable)
      .where(
        and(
          inArray(suggestionsTable.status, CLOSED_STATUSES),
          gte(suggestionsTable.generatedAt, since),
        ),
      );

    const agg = new Map<string, { pnl: number; trades: number }>();
    for (const row of rows) {
      // Only decided trades count toward expectancy; EXPIRED carries no pnl
      if (row.pnlInr == null) continue;
      const pnl = parseFloat(row.pnlInr);
      if (!Number.isFinite(pnl)) continue;
      const a = agg.get(row.setupType) ?? { pnl: 0, trades: 0 };
      a.pnl += pnl;
      a.trades += 1;
      agg.set(row.setupType, a);
    }

    const next = new Set<string>();
    for (const [setupType, a] of agg) {
      if (a.trades >= DEMOTION_MIN_TRADES && a.pnl / a.trades < 0) {
        next.add(setupType);
      }
    }

    // Log transitions so demotions are auditable
    for (const s of next) {
      if (!demotedSetups.has(s)) {
        const a = agg.get(s)!;
        logger.warn(
          { setupType: s, trades: a.trades, expectancyInr: a.pnl / a.trades },
          "Setup DEMOTED: rolling 90d expectancy negative — will not generate suggestions",
        );
      }
    }
    for (const s of demotedSetups) {
      if (!next.has(s)) {
        logger.info({ setupType: s }, "Setup RESTORED: rolling 90d expectancy back positive");
      }
    }

    demotedSetups = next;
    demotionRefreshedAt = Date.now();
    return next;
  } catch (err) {
    logger.error({ err }, "Failed to refresh setup demotions");
    return demotedSetups;
  }
}

export function isSetupDemoted(setupType: string): boolean {
  return demotedSetups.has(setupType);
}

export function getDemotedSetups(): { setups: string[]; refreshedAt: number } {
  return { setups: Array.from(demotedSetups), refreshedAt: demotionRefreshedAt };
}
