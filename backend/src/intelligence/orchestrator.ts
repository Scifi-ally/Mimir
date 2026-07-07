import { broadcast } from "../ws/websocket_server";
import { createServerEvent } from "../ws/events";
import { logger } from "../lib/logger";
import { intelligenceConfig } from "./config";
import { intelligenceBus } from "./event_bus";
import { CandleBuilderEngine } from "./candle_builder";
import { MarketBreadthEngine } from "./breadth_engine";
import { SuggestionGenerator } from "./suggestion_generator";
import { TickEngine } from "./tick_engine";
import { UniverseManager } from "./universe_manager";
import { cacheJson } from "./redis_cache";
import { upstoxConnectionManager } from "./connection_manager";
import { syncMonitoredSubscriptions } from "../market_data/monitored_symbols";
import { isMarketOpen } from "../market_data/market_state";
import { intelligenceWorkerPools } from "./worker_pool";
import { detectAlerts } from "../analysis/alerts";
import type { OHLCV } from "../analysis/technical";
import type {
  IntelligenceSnapshot,
  RankedOpportunity,
  ServiceHealth,
  TechnicalOpportunity,
  CandidateSignal,
} from "./types";

class ScannerOrchestrator {
  private readonly tickEngine = new TickEngine();
  private readonly candleBuilder = new CandleBuilderEngine(intelligenceConfig.candleBufferSize);
  private readonly breadth = new MarketBreadthEngine();
  private readonly suggestions = new SuggestionGenerator();
  private readonly universeManager = new UniverseManager();

  private readonly candidates = new Map<string, CandidateSignal>();
  private readonly opportunities = new Map<string, TechnicalOpportunity>();
  


  private status: ServiceHealth = "idle";
  private startedAt: string | null = null;
  private frontendTimer: ReturnType<typeof setInterval> | null = null;
  private breadthTimer: ReturnType<typeof setInterval> | null = null;
  private staleDataTimer: ReturnType<typeof setInterval> | null = null;
  private subscriptions: Array<() => void> = [];
  private lastCandidateEval = new Map<string, number>();
  private aiRankingTimer: NodeJS.Timeout | null = null;

  async start(): Promise<void> {
    if (this.status === "running" || this.status === "starting") return;
    this.status = "starting";
    this.startedAt = new Date().toISOString();

    this.subscriptions = [
      intelligenceBus.onError((err) => logger.warn({ err }, "Intelligence bus handler failed")),
      
      // Consume ticks
      intelligenceBus.subscribe("processedTick", async (tick) => {
        const state = this.tickEngine.applyTick(tick);

        // Feed tick to candle builder if this instrument has its buffer initialized (active candidate)
        if (this.candleBuilder.hasBuffer(tick.instrumentKey, "1m")) {
          for (const candle of this.candleBuilder.applyTick(tick)) {
            intelligenceBus.publish("candleClosed", {
              instrumentKey: candle.instrumentKey,
              symbol: candle.symbol,
              timeframe: candle.timeframe,
              candle,
            });
          }
        }

        // Evaluate candidate detection stateless in worker Pool A
        // THROTTLE: Only evaluate once every 2 seconds per symbol
        const lastEval = this.lastCandidateEval.get(tick.instrumentKey) || 0;
        if (Date.now() - lastEval < 2000) return;
        this.lastCandidateEval.set(tick.instrumentKey, Date.now());

        void intelligenceWorkerPools.candidateDetection.enqueue<CandidateSignal | null>(
          "CANDIDATE_DETECTION",
          { state }
        ).then(async (candidate) => {
          if (candidate) {
            // Corporate Action Blacklisting Guard
            const { fetchCorporateActionBlacklist } = await import("../market_data/corporate_actions");
            const blacklist = await fetchCorporateActionBlacklist();
            if (blacklist.has(candidate.symbol)) {
               logger.debug({ symbol: candidate.symbol }, "Candidate dropped due to corporate action blacklist");
               return;
            }

            // Update candidate map
            this.candidates.set(candidate.instrumentKey, candidate);
            this.trimCandidates();
            intelligenceBus.publish("candidateCreated", { candidate });

            // Ensure candle buffer is initialized
            const hasBuffer = this.candleBuilder.hasBuffer(candidate.instrumentKey, "1m");
            if (!hasBuffer) {
              // Opt-out of historical loading to save API limits
              // Initialize an empty buffer. The technical engine will use 
              // real-time tick buffering to gradually build state.
              this.candleBuilder.initializeBuffer(candidate.instrumentKey, "1m", []);
            }

            // Run technical analysis if buffer is available
            if (this.candleBuilder.hasBuffer(candidate.instrumentKey, "1m")) {
              const candles = this.candleBuilder.getCandles(candidate.instrumentKey, "1m").slice(-80);
              const ohlcvCandles = candles.map((c): OHLCV => ({
                timestamp: c.timestamp,
                open: c.open,
                high: c.high,
                low: c.low,
                close: c.close,
                volume: c.volume,
              }));

              const opportunity = await intelligenceWorkerPools.technicalAnalysis.enqueue<TechnicalOpportunity | null>(
                "TECHNICAL_ANALYSIS",
                { candidate, candles: ohlcvCandles }
              );

              if (opportunity) {
                this.opportunities.set(opportunity.instrumentKey, opportunity);
                intelligenceBus.publish("opportunityQualified", { opportunity });
              }
            }
          } else {
            // Remove candidate if it doesn't meet criteria anymore
            if (this.candidates.has(state.instrumentKey)) {
              this.candidates.delete(state.instrumentKey);
              this.candleBuilder.clearBuffer(state.instrumentKey);
              intelligenceBus.publish("candidateRemoved", {
                instrumentKey: state.instrumentKey,
                symbol: state.symbol,
                reason: "no longer meets criteria",
                removedAt: Date.now(),
              });
            }
          }
        }).catch((err) => {
          logger.error({ err, symbol: tick.symbol }, "Candidate detection or downstream processing failed. Ticks are not dropped, but candidate check for this tick failed.");
        });
      }),

      // Perform AI ranking when opportunities qualify
      intelligenceBus.subscribe("opportunityQualified", async () => {
        // DEBOUNCE: Group multiple qualifications into a single AI pass
        if (this.aiRankingTimer) {
          clearTimeout(this.aiRankingTimer);
        }

        this.aiRankingTimer = setTimeout(async () => {
          try {
            const ranked = await intelligenceWorkerPools.aiRanking.enqueue<RankedOpportunity[]>(
              "AI_RANKING",
              {
                opportunities: Array.from(this.opportunities.values()).map(opp => ({
                  opportunity: opp,
                  candles: this.candleBuilder.hasBuffer(opp.instrumentKey, "1m") 
                    ? this.candleBuilder.getCandles(opp.instrumentKey, "1m").slice(-100).map(c => ({
                        timestamp: c.timestamp,
                        open: c.open,
                        high: c.high,
                        low: c.low,
                        close: c.close,
                        volume: c.volume
                      }))
                    : []
                })),
                maxOpportunities: intelligenceConfig.maxAiOpportunities,
                regime: this.breadth.getSnapshot()?.regime ?? "UNKNOWN",
              }
            );

            // Generate suggestions for top 5 ranked opportunities
            for (const opportunity of ranked.slice(0, 5)) {
              const suggestion = this.suggestions.generate(opportunity);
              if (suggestion.isNew) {
                intelligenceBus.publish("suggestionGenerated", { suggestion });
              }
            }
          } catch (err) {
            logger.warn({ err }, "AI Ranking task failed");
          }
        }, 2000);
      }),

      // Cache suggestions to Redis, persist to DB, and subscribe to live ticks
      intelligenceBus.subscribe("suggestionGenerated", async ({ suggestion }) => {
        void cacheJson(`intelligence:suggestion:${suggestion.instrumentKey}`, suggestion, 30 * 60);
        void syncMonitoredSubscriptions();
        
        // Persist to database and broadcast to frontend
        try {
          const { db, suggestionsTable } = await import("../../db/src");
          const [inserted] = await db
            .insert(suggestionsTable)
            .values({
              symbol: suggestion.symbol,
              name: suggestion.symbol,
              exchange: "NSE",
              direction: suggestion.direction,
              tradeType: "INTRADAY",
              setupType: suggestion.setup,
              entryPrice: suggestion.entry.toString(),
              stopLoss: suggestion.stopLoss.toString(),
              target1: suggestion.target.toString(),
              target2: null,
              riskReward: suggestion.riskReward.toString(),
              quantity: 1,
              maxRiskInr: Math.abs(suggestion.entry - suggestion.stopLoss).toString(),
              stopDistancePct: (Math.abs(suggestion.entry - suggestion.stopLoss) / suggestion.entry * 100).toString(),
              marketRegime: this.breadth.getSnapshot()?.regime ?? "UNKNOWN",
              reasoning: suggestion.reasoning ? suggestion.reasoning.join("; ") : "",
              validityTill: new Date(suggestion.expiresAt).toISOString(),
              status: "ACTIVE",
              atr: (Math.abs(suggestion.entry - suggestion.stopLoss) / 1.5).toString(),
              highestPrice: suggestion.entry.toString(),
              lowestPrice: suggestion.entry.toString(),
              signalFactors: null,
            })
            .returning();

          if (inserted) {
            broadcast(
              createServerEvent.newSuggestion({
                id: inserted.id,
                symbol: inserted.symbol,
                direction: suggestion.direction as "BUY" | "SELL",
                entryPrice: suggestion.entry,
                stopLoss: suggestion.stopLoss,
                target1: suggestion.target,
                setupType: suggestion.setup,
                riskReward: suggestion.riskReward,
                scanSessionId: undefined,
              }),
              "suggestions"
            );
            logger.info({ symbol: suggestion.symbol, id: inserted.id }, "Real-time suggestion persisted and broadcasted");
          }
        } catch (err) {
          logger.warn({ err, symbol: suggestion.symbol }, "Failed to persist real-time suggestion to database");
        }

        // Detect compositeScore alerts
        detectAlerts(suggestion.symbol, {
          compositeScore: suggestion.confidence / 10 // Confidence is Math.round(compositeScore * 10)
        }).catch(err => logger.error({ err }, "Alert detection failed"));
      }),
    ];

    // Refresh universe
    await this.refreshUniverse();

    // Recover active suggestions from database
    await this.suggestions.recoverState();

    // Connect WebSocket — subscribe to monitored watchlist only (not full universe)
    await syncMonitoredSubscriptions();
    await upstoxConnectionManager.connect();
    
    // Tick distribution engine self-starts its intervals on instantiation

    this.startTimers();
    this.status = "running";
    logger.info("Market intelligence orchestrator started successfully");
  }

  stop(): void {
    for (const unsubscribe of this.subscriptions) unsubscribe();
    this.subscriptions = [];
    if (this.frontendTimer) clearInterval(this.frontendTimer);
    if (this.breadthTimer) clearInterval(this.breadthTimer);
    if (this.staleDataTimer) clearInterval(this.staleDataTimer);
    if (this.aiRankingTimer) clearTimeout(this.aiRankingTimer);
    this.frontendTimer = null;
    this.breadthTimer = null;
    this.staleDataTimer = null;
    this.aiRankingTimer = null;
    this.lastCandidateEval.clear();
    upstoxConnectionManager.disconnect();
    this.status = "stopped";
    logger.info("Market intelligence orchestrator stopped");
  }

  async refreshUniverse(): Promise<void> {
    const universe = await this.universeManager.refresh();
    for (const stock of universe) {
      this.tickEngine.setSector(stock.key, stock.sector);
    }
    
    // Keep universe metadata for scanners; tick subscriptions stay monitored-only
    await syncMonitoredSubscriptions();

    intelligenceBus.publish("universeUpdated", universe);
    await cacheJson("intelligence:universe", universe, 6 * 60 * 60);
  }

  getSnapshot(): IntelligenceSnapshot {
    return {
      status: this.status,
      universeSize: this.universeManager.getUniverse().length,
      marketStates: this.tickEngine.size(),
      activeCandidates: this.candidates.size,
      qualifiedOpportunities: this.opportunities.size,
      activeSuggestions: this.suggestions.size(),
      breadth: this.breadth.getSnapshot(),
      startedAt: this.startedAt,
      updatedAt: new Date().toISOString(),
    };
  }

  getActiveSuggestions() {
    return this.suggestions.getActive();
  }

  getTradableUniverse() {
    return this.universeManager.getUniverse();
  }

  private trimCandidates() {
    if (this.candidates.size <= intelligenceConfig.maxCandidates) return;
    const sorted = Array.from(this.candidates.values()).sort((a, b) => b.score - a.score);
    const toRemove = sorted.slice(intelligenceConfig.maxCandidates);

    for (const item of toRemove) {
      this.candidates.delete(item.instrumentKey);
      this.candleBuilder.clearBuffer(item.instrumentKey);
    }
  }

  private startTimers(): void {
    if (!this.frontendTimer) {
      this.frontendTimer = setInterval(() => {
        const topMovers = this.tickEngine
          .getAllStates()
          .sort((a, b) => Math.abs(b.percentageChange) - Math.abs(a.percentageChange))
          .slice(0, 20)
          .map((state) => ({
            symbol: state.symbol,
            ltp: state.ltp,
            changePct: Number(state.percentageChange.toFixed(2)),
            volume: state.volume,
          }));
        
        const suggestions = this.suggestions.getActive();
        const snapshot = this.getSnapshot();

        broadcast(createServerEvent.marketIntelligenceUpdate({
          snapshot: {
            status: snapshot.status,
            universeSize: snapshot.universeSize,
            marketStates: snapshot.marketStates,
            activeCandidates: snapshot.activeCandidates,
            qualifiedOpportunities: snapshot.qualifiedOpportunities,
            activeSuggestions: snapshot.activeSuggestions,
            startedAt: snapshot.startedAt,
            updatedAt: snapshot.updatedAt,
          },
          topMovers,
          suggestions: suggestions.map((suggestion) => ({
            id: suggestion.id,
            symbol: suggestion.symbol,
            direction: suggestion.direction,
            setup: suggestion.setup,
            confidence: suggestion.confidence,
            entry: suggestion.entry,
            stopLoss: suggestion.stopLoss,
            target: suggestion.target,
            riskReward: suggestion.riskReward,
            expiresAt: suggestion.expiresAt,
          })),
          breadth: snapshot.breadth
            ? {
                advancers: snapshot.breadth.advancers,
                decliners: snapshot.breadth.decliners,
                newHighs: snapshot.breadth.newHighs,
                newLows: snapshot.breadth.newLows,
                regime: snapshot.breadth.regime,
                updatedAt: snapshot.breadth.updatedAt,
              }
            : null,
        }));

        void cacheJson("intelligence:frontend", {
          topMovers,
          suggestions,
          snapshot,
        }, 10);
      }, intelligenceConfig.frontendFlushMs);
    }

    if (!this.breadthTimer) {
      this.breadthTimer = setInterval(() => {
        const snapshot = this.breadth.update(this.tickEngine.getAllStates());
        intelligenceBus.publish("breadthUpdated", snapshot);
        void cacheJson("intelligence:breadth", snapshot, 30);
      }, 1_000);
    }

    if (!this.staleDataTimer) {
      this.staleDataTimer = setInterval(() => {
        if (!isMarketOpen()) return;

        const status = upstoxConnectionManager.getStatus();
        if (!status.connected) return;

        const now = Date.now();
        const elapsed = now - status.lastTickReceivedAt;
        if (status.lastTickReceivedAt > 0 && elapsed > 5000) {
          logger.warn(
            { lastTickReceivedAt: status.lastTickReceivedAt, elapsedSeconds: (elapsed / 1000).toFixed(1) },
            "STALE_DATA_ALERT: No market ticks received from Upstox for over 5 seconds during active market hours!"
          );
        }
      }, 5000);
    }
  }
}

export const marketIntelligence = new ScannerOrchestrator();

export async function startMarketIntelligence(): Promise<void> {
  await marketIntelligence.start();
}

export function getMarketIntelligenceSnapshot(): IntelligenceSnapshot {
  return marketIntelligence.getSnapshot();
}

export function getMarketIntelligenceSuggestions(): RankedOpportunity[] | ReturnType<ScannerOrchestrator["getActiveSuggestions"]> {
  return marketIntelligence.getActiveSuggestions();
}
