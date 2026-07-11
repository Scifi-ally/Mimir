import { db } from "../../db/src";
import { customScreenerTable, customScreenerMatchesTable, customScreenerTargetsTable, customScreenerRunsTable } from "../../db/src/schema/custom_screener";
import { eq, and, desc, isNull, inArray } from "drizzle-orm";
import { logger } from "../lib/logger";
import { createUpstoxClient } from "../lib/upstox-client";
import { broadcast } from "../ws/websocket_server";
import { createServerEvent } from "../ws/events";
import { computeEMA, computeSMA, computeStandardDeviation } from "./technical";
import { getISTDateStr } from "../lib/ist-time";
import { suggestionsTable, overnightWatchlistTable } from "../../db/src"; 
import { getAccessToken } from "../upstox/auth";
import { loadBalancer, AsyncAnalysisQueue } from "../intelligence/load_balancer";
const upstoxClient = createUpstoxClient({ cacheTimeMs: 10 * 60 * 1000 });

async function resolveTargetSymbols(targetType: string, specificSymbol?: string): Promise<string[]> {
  if (targetType === "ALL") {
    const targetsRows = await db.select().from(customScreenerTargetsTable).where(isNull(customScreenerTargetsTable.screenerId));
    return targetsRows.map(u => u.symbol);
  }
  
  if (targetType === "CUSTOM") {
    // If it's a custom watchlist, it needs to scan the entire global base universe
    // to populate itself. So we fetch symbols where screenerId is null.
    const targetsRows = await db.select().from(customScreenerTargetsTable).where(isNull(customScreenerTargetsTable.screenerId));
    return targetsRows.map(u => u.symbol);
  }
  
  if (targetType === "SUGGESTIONS") {
    const rows = await db.select().from(suggestionsTable).where(eq(suggestionsTable.status, "ACTIVE"));
    return rows.map(r => r.symbol);
  }
  
  if (targetType === "OVERNIGHT") {
    const today = getISTDateStr();
    const rows = await db.select().from(overnightWatchlistTable).where(eq(overnightWatchlistTable.forDate, today));
    return rows.map(r => r.symbol);
  }

  // Fallback: it might be a specific symbol if targetType is essentially the symbol (legacy)
  if (specificSymbol && specificSymbol !== "ALL") {
    return [specificSymbol];
  }

  // Default to all known targets if nothing matched
  const targetsRows = await db.select().from(customScreenerTargetsTable).where(isNull(customScreenerTargetsTable.screenerId));
  return targetsRows.map(u => u.symbol);
}

export async function runCustomScreener(options: { screenerIds?: number[], runId?: number } = {}) {
  try {
    const token = getAccessToken();
    if (!token) {
      logger.debug("Skipping custom screener run because Upstox is not authenticated");
      if (options.runId) {
        await db.update(customScreenerRunsTable).set({ status: "FAILED" }).where(eq(customScreenerRunsTable.id, options.runId));
      }
      return;
    }
    const activeWhere = options.screenerIds?.length
      ? and(eq(customScreenerTable.status, "ACTIVE"), inArray(customScreenerTable.id, options.screenerIds))
      : eq(customScreenerTable.status, "ACTIVE");

    const activeScreeners = await db.select()
      .from(customScreenerTable)
      .where(activeWhere);

    if (activeScreeners.length === 0) {
      return;
    }

    // Group screeners by timeframe and symbol to minimize API calls
    const timeframeSymbols = new Map<string, Set<string>>();

    for (const screener of activeScreeners) {
      if (!timeframeSymbols.has(screener.timeframe)) {
        timeframeSymbols.set(screener.timeframe, new Set());
      }
      const symbolSet = timeframeSymbols.get(screener.timeframe)!;
      
      const targets = await resolveTargetSymbols(screener.targetType, screener.symbol);
      targets.forEach(s => symbolSet.add(s));
      
      // Store targets on screener for later evaluation
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (screener as any).resolvedTargets = targets;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const candleCache = new Map<string, any[]>(); // 'symbol:timeframe' -> candles

    loadBalancer.beginScan();
    
    // Fetch candles with controlled concurrency to respect rate limits
    const CONCURRENCY = loadBalancer.getScannerConcurrency();
    let completed = 0;
    let total = 0;
    for (const symbolSet of timeframeSymbols.values()) {
      total += symbolSet.size;
    }
    
    if (total > 0) {
      broadcast({ event: 'custom_screener', data: { type: 'screener_progress', progress: completed, total } } as unknown as Parameters<typeof broadcast>[0]);
    }

    const fetchQueue = new AsyncAnalysisQueue<{ symbol: string; timeframe: string }>(async (task) => {
      const { symbol, timeframe } = task;
      try {
        const tfMap = { "1m": "1minute", "5m": "5minute", "15m": "15minute", "1h": "60minute", "1d": "day" } as const;
        const toDate = getISTDateStr();
        const from = new Date();
        from.setDate(from.getDate() - (timeframe === "1d" ? 730 : 30));
        
        const rows = await upstoxClient.fetchHistoricalCandles(
          symbol,
          tfMap[timeframe as keyof typeof tfMap] || "15minute",
          toDate,
          getISTDateStr(from),
          token,
        );
        const candles = rows.map((row) => ({
          timestamp: String(row[0]),
          open: Number(row[1]),
          high: Number(row[2]),
          low: Number(row[3]),
          close: Number(row[4]),
          volume: Number(row[5]) || 0,
        })).filter((candle) => Number.isFinite(candle.close));
        
        candles.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
        if (candles.length > 0) {
          candleCache.set(`${symbol}:${timeframe}`, candles);
        }
      } catch (err) {
        logger.warn({ err, symbol, timeframe }, "Failed to fetch candles for screener");
      } finally {
        completed++;
        if (total > 0 && completed % Math.max(1, Math.floor(total / 20)) === 0) {
          broadcast({ event: 'custom_screener', data: { type: 'screener_progress', progress: completed, total } } as unknown as Parameters<typeof broadcast>[0]);
        }
      }
    }, CONCURRENCY);

    for (const [timeframe, symbolSet] of timeframeSymbols.entries()) {
      for (const symbol of Array.from(symbolSet)) {
        fetchQueue.push({ symbol, timeframe });
      }
    }

    await fetchQueue.waitUntilEmpty();
    
    if (total > 0) {
      broadcast({ event: 'custom_screener', data: { type: 'screener_progress', progress: completed, total } } as unknown as Parameters<typeof broadcast>[0]);
    }

    // Now evaluate rules
    for (const screener of activeScreeners) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const targets = (screener as any).resolvedTargets as string[];
      
      for (const symbol of targets) {
        const candles = candleCache.get(`${symbol}:${screener.timeframe}`);
        if (!candles || candles.length < 50) continue;

        // Yield to event loop to prevent blocking during heavy analysis
        await new Promise(r => setImmediate(r));

        const { matched, messages } = evaluateRuleTree(screener, candles);

        if (matched) {
          // Check if we already alerted this recently
          const existing = await db.select()
            .from(customScreenerMatchesTable)
            .where(
              and(
                eq(customScreenerMatchesTable.screenerId, screener.id),
                eq(customScreenerMatchesTable.symbol, symbol)
              )
            )
            .orderBy(desc(customScreenerMatchesTable.matchedAt))
            .limit(1);

          // Alert if no existing match in the last hour
          const oneHourAgo = Date.now() - 60 * 60 * 1000;
          if (existing.length === 0 || existing[0].matchedAt.getTime() < oneHourAgo) {
            
            // Generate a readable condition string
            const baseStr = screener.outputName || `${symbol} (Advanced Rule on ${screener.timeframe})`;
            const conditionStr = messages.length > 0 ? messages.join(', ') : baseStr;
            const fullAlertStr = messages.length > 0 ? `${baseStr} — ${messages.join(', ')}` : baseStr;
            
            await db.insert(customScreenerMatchesTable).values({
              screenerId: screener.id,
              symbol,
              timeframe: screener.timeframe,
              condition: fullAlertStr,
            });

            if (screener.targetType === "CUSTOM") {
              const existingTarget = await db.select()
                .from(customScreenerTargetsTable)
                .where(
                  and(
                    eq(customScreenerTargetsTable.screenerId, screener.id),
                    eq(customScreenerTargetsTable.symbol, symbol)
                  )
                )
                .limit(1);

              if (existingTarget.length === 0) {
                await db.insert(customScreenerTargetsTable).values({
                  screenerId: screener.id,
                  symbol,
                  notes: conditionStr,
                });
              } else {
                await db.update(customScreenerTargetsTable)
                  .set({ notes: conditionStr })
                  .where(eq(customScreenerTargetsTable.id, existingTarget[0].id));
              }
            }

            await db.update(customScreenerTable)
              .set({ lastTriggeredAt: new Date() })
              .where(eq(customScreenerTable.id, screener.id));

            broadcast(
              createServerEvent.systemAlert({
                message: `Screener Alert: ${fullAlertStr}`,
                severity: "info",
              })
            );
            
          }
        }
      }
    }

    if (options.runId) {
      // Calculate total unique symbols scanned
      const allScannedSymbols = new Set<string>();
      timeframeSymbols.forEach(set => set.forEach(s => allScannedSymbols.add(s)));
      
      await db.update(customScreenerRunsTable)
        .set({ 
          status: "COMPLETED", 
          completedAt: new Date(),
          universeScanned: allScannedSymbols.size,
          generatedCandidates: 0,
          configHash: "engine-v2",
          metadata: { screenersEvaluated: activeScreeners.length }
        })
        .where(eq(customScreenerRunsTable.id, options.runId));
    }
  } catch (err) {
    logger.error({ err }, "Fatal error running custom screener");
    if (options.runId) {
      await db.update(customScreenerRunsTable)
        .set({ status: "FAILED", completedAt: new Date() })
        .where(eq(customScreenerRunsTable.id, options.runId))
        .catch(dbErr => logger.error({ dbErr }, "Failed to update run status on crash"));
    }
  } finally {
    loadBalancer.endScan();
  }
}

// Evaluates either legacy rules or the new JSON condition tree
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function evaluateRuleTree(screener: any, candles: any[]): { matched: boolean, messages: string[] } {
  if (screener.conditions) {
    return evaluateConditionNode(screener.conditions, candles);
  }
  
  // Legacy logic fallback
  if (screener.indicatorA && screener.operator && screener.indicatorB) {
    const matched = evaluateSingleRule(screener.indicatorA, screener.operator, screener.indicatorB, candles);
    return { matched, messages: [] };
  }
  
  return { matched: false, messages: [] };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function evaluateConditionNode(node: any, candles: any[]): { matched: boolean, messages: string[] } {
  if (!node) return { matched: false, messages: [] };
  
  if (node.type === "AND") {
    if (!node.rules || node.rules.length === 0) return { matched: true, messages: [] };
    const allMessages: string[] = [];
    for (const rule of node.rules) {
      const res = evaluateConditionNode(rule, candles);
      if (!res.matched) return { matched: false, messages: [] };
      allMessages.push(...res.messages);
    }
    return { matched: true, messages: allMessages };
  }
  
  if (node.type === "OR") {
    if (!node.rules || node.rules.length === 0) return { matched: false, messages: [] };
    const allMessages: string[] = [];
    for (const rule of node.rules) {
      const res = evaluateConditionNode(rule, candles);
      if (res.matched) {
        allMessages.push(...res.messages);
        return { matched: true, messages: allMessages };
      }
    }
    return { matched: false, messages: [] };
  }
  
  if (node.type === "CONDITION") {
    const matched = evaluateSingleRule(node.indicatorA, node.operator, node.indicatorB, candles);
    return { matched, messages: matched && node.alertMessage ? [node.alertMessage] : [] };
  }
  
  return { matched: false, messages: [] };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function evaluateSingleRule(indicatorA: string, operator: string, indicatorB: string, candles: any[]): boolean {
  try {
    const valA = extractIndicator(indicatorA, candles);
    const valB = extractIndicator(indicatorB, candles);

    if (valA === null || valB === null) return false;

    // Current values
    const currentA = valA[valA.length - 1];
    const currentB = valB[valB.length - 1];

    // Previous values (for crosses)
    const prevA = valA[valA.length - 2];
    const prevB = valB[valB.length - 2];

    if (![currentA, currentB].every(Number.isFinite)) return false;

    switch (operator) {
      case ">": return currentA > currentB;
      case "<": return currentA < currentB;
      case ">=": return currentA >= currentB;
      case "<=": return currentA <= currentB;
      case "CROSSES_ABOVE": return Number.isFinite(prevA) && Number.isFinite(prevB) && prevA <= prevB && currentA > currentB;
      case "CROSSES_BELOW": return Number.isFinite(prevA) && Number.isFinite(prevB) && prevA >= prevB && currentA < currentB;
      case "==": return Math.abs(currentA - currentB) <= Math.max(1e-8, Math.abs(currentB) * 1e-8);
      case "!=": return Math.abs(currentA - currentB) > Math.max(1e-8, Math.abs(currentB) * 1e-8);
      default: return false;
    }
  } catch (err) {
    logger.error({ err, rule: { indicatorA, operator, indicatorB } }, "Failed to evaluate single rule");
    return false;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractIndicator(indicatorRaw: string, candles: any[]): number[] | null {
  const ind = indicatorRaw.toUpperCase();
  const closes = candles.map(c => c.close);
  
  if (ind === "PRICE" || ind === "CLOSE") return closes;
  if (ind === "OPEN") return candles.map(c => c.open || c.close);
  if (ind === "HIGH") return candles.map(c => c.high || c.close);
  if (ind === "LOW") return candles.map(c => c.low || c.close);
  if (ind === "VOLUME") return candles.map(c => c.volume || 0);
  if (ind === "PREV_CLOSE") return closes.map((value, index) => index === 0 ? value : closes[index - 1]);

  if (ind === "VWAP") {
    let cumulativeValue = 0;
    let cumulativeVolume = 0;
    let currentDay = "";
    return candles.map((c) => {
      // Reset VWAP at start of new trading session
      const d = new Date(c.timestamp);
      const dayStr = d.toLocaleDateString("en-US", { timeZone: "Asia/Kolkata" });
      if (dayStr !== currentDay) {
        currentDay = dayStr;
        cumulativeValue = 0;
        cumulativeVolume = 0;
      }
      const volume = Number(c.volume) || 0;
      const typicalPrice = ((Number(c.high) || c.close) + (Number(c.low) || c.close) + Number(c.close)) / 3;
      cumulativeValue += typicalPrice * volume;
      cumulativeVolume += volume;
      return cumulativeVolume > 0 ? cumulativeValue / cumulativeVolume : Number(c.close);
    });
  }

  if (ind === "MACD" || ind === "MACD_SIGNAL") {
    const fast = computeEMA(closes, 12);
    const slow = computeEMA(closes, 26);
    const macd = closes.map((_, index) => fast[index] - slow[index]);
    return ind === "MACD" ? macd : computeEMA(macd, 9);
  }
  
  const emaMatch = ind.match(/^EMA(\d+)$/);
  if (emaMatch) {
    const period = parseInt(emaMatch[1], 10);
    return computeEMA(closes, period);
  }

  const smaMatch = ind.match(/^SMA(\d+)$/);
  if (smaMatch) {
    const period = parseInt(smaMatch[1], 10);
    return computeSMA(closes, period);
  }
  const rsiMatch = ind.match(/^RSI(\d+)$/);
  if (rsiMatch) {
    const period = parseInt(rsiMatch[1], 10);
    const result = new Array(closes.length).fill(50);
    let avgGain = 0, avgLoss = 0;
    for (let i = 1; i < closes.length; i++) {
      const ch = closes[i] - closes[i - 1];
      const gain = ch > 0 ? ch : 0;
      const loss = ch < 0 ? -ch : 0;
      if (i <= period) {
        avgGain += gain / period;
        avgLoss += loss / period;
      } else {
        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;
      }
      if (i >= period) {
        result[i] = avgLoss === 0 ? 100 : Math.round((100 - 100 / (1 + avgGain / avgLoss)) * 100) / 100;
      }
    }
    return result;
  }

  const atrMatch = ind.match(/^ATR(\d+)$/);
  if (atrMatch) {
    const period = parseInt(atrMatch[1], 10);
    const trueRanges = candles.map((c, index) => {
      if (index === 0) return Math.abs((Number(c.high) || c.close) - (Number(c.low) || c.close));
      const previousClose = Number(candles[index - 1].close);
      const high = Number(c.high) || Number(c.close);
      const low = Number(c.low) || Number(c.close);
      return Math.max(high - low, Math.abs(high - previousClose), Math.abs(low - previousClose));
    });
    return computeEMA(trueRanges, period);
  }

  const rocMatch = ind.match(/^ROC(\d+)$/);
  if (rocMatch) {
    const period = parseInt(rocMatch[1], 10);
    return closes.map((close, index) => index < period || closes[index - period] === 0
      ? 0
      : ((close - closes[index - period]) / closes[index - period]) * 100);
  }

  const bollingerMatch = ind.match(/^BB_(UPPER|MIDDLE|LOWER)(\d+)$/);
  if (bollingerMatch) {
    const band = bollingerMatch[1];
    const period = parseInt(bollingerMatch[2], 10);
    const middle = computeSMA(closes, period);
    if (band === "MIDDLE") return middle;
    const deviation = computeStandardDeviation(closes, middle, period);
    return middle.map((value, index) => band === "UPPER" ? value + 2 * deviation[index] : value - 2 * deviation[index]);
  }

  // ADX (needs full candle data, not just closes)
  const adxMatch = ind.match(/^ADX(\d+)$/);
  if (adxMatch) {
    const period = parseInt(adxMatch[1], 10);
    const trs: number[] = [];
    const plusDMs: number[] = [];
    const minusDMs: number[] = [];
    for (let i = 0; i < candles.length; i++) {
      if (i === 0) { trs.push(0); plusDMs.push(0); minusDMs.push(0); continue; }
      const c = candles[i], pc = candles[i-1];
      const h = Number(c.high) || c.close, l = Number(c.low) || c.close;
      const pch = Number(pc.high) || pc.close, pcl = Number(pc.low) || pc.close, pcc = Number(pc.close);
      trs.push(Math.max(h - l, Math.abs(h - pcc), Math.abs(l - pcc)));
      const upMove = h - pch, downMove = pcl - l;
      plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
      minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);
    }
    let sTR = 0, sPDM = 0, sMDM = 0;
    const dxValues: number[] = [];
    const result = new Array(candles.length).fill(20);
    let adx = 20;
    for (let i = 1; i < candles.length; i++) {
      if (i <= period) {
        sTR += trs[i]; sPDM += plusDMs[i]; sMDM += minusDMs[i];
      } else {
        sTR = sTR - sTR / period + trs[i];
        sPDM = sPDM - sPDM / period + plusDMs[i];
        sMDM = sMDM - sMDM / period + minusDMs[i];
      }
      if (i >= period) {
        const pDI = sTR > 0 ? (sPDM / sTR) * 100 : 0;
        const mDI = sTR > 0 ? (sMDM / sTR) * 100 : 0;
        const sum = pDI + mDI;
        const dx = sum > 0 ? (Math.abs(pDI - mDI) / sum) * 100 : 0;
        dxValues.push(dx);
        if (dxValues.length === period) {
          adx = dxValues.reduce((a, b) => a + b, 0) / period;
        } else if (dxValues.length > period) {
          adx = (adx * (period - 1) + dx) / period;
        }
        if (dxValues.length >= period) result[i] = adx;
      }
    }
    return result;
  }

  if (ind === "SUPERTREND") {
    // SuperTrend (10, 3) computed inline
    const period = 10;
    const multiplier = 3;
    const atrs: number[] = [];
    for (let i = 0; i < candles.length; i++) {
      const h = Number(candles[i].high) || candles[i].close;
      const l = Number(candles[i].low) || candles[i].close;
      if (i === 0) { atrs.push(h - l); continue; }
      const pc = Number(candles[i - 1].close);
      const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
      atrs.push(i < period ? (atrs[i - 1] * i + tr) / (i + 1) : (atrs[i - 1] * (period - 1) + tr) / period);
    }
    const result: number[] = [];
    let isUpTrend = true, finalUpper = 0, finalLower = 0;
    for (let i = 0; i < candles.length; i++) {
      const h = Number(candles[i].high) || candles[i].close;
      const l = Number(candles[i].low) || candles[i].close;
      const hl2 = (h + l) / 2;
      const basicUpper = hl2 + multiplier * atrs[i];
      const basicLower = hl2 - multiplier * atrs[i];
      if (i === 0) { finalUpper = basicUpper; finalLower = basicLower; result.push(finalLower); continue; }
      const prevClose = Number(candles[i - 1].close);
      finalUpper = basicUpper < finalUpper || prevClose > finalUpper ? basicUpper : finalUpper;
      finalLower = basicLower > finalLower || prevClose < finalLower ? basicLower : finalLower;
      if (candles[i].close > finalUpper) isUpTrend = true;
      else if (candles[i].close < finalLower) isUpTrend = false;
      result.push(isUpTrend ? finalLower : finalUpper);
    }
    return result;
  }

  if (ind === "MACD_HISTOGRAM") {
    const fast = computeEMA(closes, 12);
    const slow = computeEMA(closes, 26);
    const macd = closes.map((_, i) => fast[i] - slow[i]);
    const signal = computeEMA(macd, 9);
    return macd.map((v, i) => v - signal[i]);
  }

  const bbWidthMatch = ind.match(/^BB_WIDTH(\d+)$/);
  if (bbWidthMatch) {
    const period = parseInt(bbWidthMatch[1], 10);
    const middle = computeSMA(closes, period);
    const deviation = computeStandardDeviation(closes, middle, period);
    return middle.map((m, i) => m > 0 ? (4 * deviation[i] / m) * 100 : 0);
  }

  if (ind === "VOLUME_RATIO") {
    const volumes = candles.map(c => c.volume || 0);
    const period = 20;
    return volumes.map((v, i) => {
      if (i < period) return 1;
      const avg = volumes.slice(i - period, i).reduce((a, b) => a + b, 0) / period;
      return avg > 0 ? v / avg : 1;
    });
  }

  if (ind === "CHANGE_PCT") {
    return closes.map((close, i) => {
      if (i === 0 || closes[i - 1] === 0) return 0;
      return ((close - closes[i - 1]) / closes[i - 1]) * 100;
    });
  }

  // Check if it's a static number
  const num = parseFloat(indicatorRaw);
  if (!isNaN(num)) {
    return new Array(candles.length).fill(num);
  }

  return null;
}
