import React, { useState, useEffect, useMemo, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { Flame, ChevronLeft, Copy, Check, Crosshair, Layers } from "lucide-react";
import { cn, fmtNum, fmtPct } from "@/lib/format";
import { api } from "@/lib/api";
import { Tooltip } from "@/components/mimir/tooltip";
import { Sparkline } from "@/components/Sparkline";
import { SupportResistancePanel } from "@/components/SupportResistancePanel";
import { LivePrice } from "@/components/atoms/LivePrice";
import { LiveChangePct } from "@/components/atoms/LiveChangePct";
import { AnimatedNumber } from "@/components/atoms/AnimatedNumber";
import { Skeleton } from "@/components/atoms/Skeleton";
import { useSymbolDataSelector } from "@/providers/MarketDataProvider";
import type { Suggestion, SessionState } from "@/types/api";
import { SPRING_STANDARD } from "@/lib/motion";

interface DetailPanelProps {
  suggestions: Suggestion[];
  selectedSymbol: string;
  session: SessionState | undefined;
  isScanActive?: boolean;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Layout contract (trader-first, fixed viewport):
 *  - The panel NEVER scrolls: every section is shrink-0 except Key Levels,
 *    which absorbs remaining height. overflow-hidden at every level.
 *  - No metric ever wraps: single-line rows, truncate on labels, shrink-0 on
 *    values, short value vocabulary ("STRONG ALIGN", not a sentence).
 *  - Information priority: Price/Deviation → Trade Plan (only when a signal
 *    exists) → Momentum gauges → Matrix (technical + AI) → Key Levels.
 * ──────────────────────────────────────────────────────────────────────────── */

export const DetailPanel = React.memo(function DetailPanel({ suggestions, selectedSymbol, session, isScanActive }: DetailPanelProps) {
  const hasLtp = useSymbolDataSelector(selectedSymbol, (d) => d.ltp != null);
  const tech_edge = useSymbolDataSelector(selectedSymbol, (d) => d.tech_edge);
  const regime_align = useSymbolDataSelector(selectedSymbol, (d) => d.regime_align);
  const mtf_score = useSymbolDataSelector(selectedSymbol, (d) => d.mtf_score);
  const mtf_total = useSymbolDataSelector(selectedSymbol, (d) => d.mtf_total);
  const [selectedMetric, setSelectedMetric] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setSelectedMetric(null);
  }, [selectedSymbol]);

  const handleCopySymbol = () => {
    if (!selectedSymbol) return;
    navigator.clipboard.writeText(selectedSymbol).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const sorted = useMemo(() => {
    const activeSignals = suggestions.filter((s) => s.status === "ACTIVE" || s.status === "PENDING");
    return [...activeSignals].sort((a, b) => (b.riskReward ?? 0) - (a.riskReward ?? 0));
  }, [suggestions]);
  const selectedSignal = sorted.find((s) => s.symbol === selectedSymbol) ?? null;

  const insightsQuery = useQuery({
    queryKey: ["symbol-insights", selectedSymbol],
    queryFn: () => api.symbolInsights(selectedSymbol),
    enabled: Boolean(selectedSymbol && typeof selectedSymbol === "string" && selectedSymbol.trim()),
    retry: false,
    refetchInterval: 30000,
    staleTime: 15000,
  });

  const insights = insightsQuery.data;
  const indicators = insights?.indicators;
  const scan = insights?.scan;
  const forecast = insights?.ai;
  const monitoring = insights?.monitoring;

  const techEdgeVal = forecast?.techEdge ?? tech_edge ?? selectedSignal?.signalFactors?.techEdge ?? selectedSignal?.signalFactors?.technical?.score;
  const regimeAlignVal = forecast?.regimeAlign ?? regime_align ?? selectedSignal?.signalFactors?.regime?.align;

  const scoreHistoryQuery = useQuery({
    queryKey: ["score-history", selectedSymbol],
    queryFn: () => api.scoreHistory(selectedSymbol),
    enabled: Boolean(selectedSymbol.trim()),
    staleTime: 60000,
  });
  const scoreHistory = scoreHistoryQuery.data?.history ?? [];

  // Unified trend read: forecast > indicators > signal direction
  const trend = useMemo(() => {
    const t = (forecast?.trend || indicators?.trend || selectedSignal?.direction || "").toString().toLowerCase();
    if (!t) return null;
    if (t.includes("bull") || t === "up" || t === "buy") return "BULL" as const;
    if (t.includes("bear") || t === "down" || t === "sell") return "BEAR" as const;
    return "FLAT" as const;
  }, [forecast?.trend, indicators?.trend, selectedSignal?.direction]);

  if (!selectedSymbol) {
    return (
      <div className="h-full bg-transparent border-0 flex flex-col items-center justify-center text-neutral-600">
        <p className="text-[11px] tracking-wide uppercase font-normal text-muted-foreground/50">Select a symbol</p>
      </div>
    );
  }

  if (isScanActive) {
    // The matrix view owns the scan experience, but fully blank space reads as
    // a broken panel — say what's happening and that this pane will resume.
    return (
      <div className="h-full bg-transparent flex flex-col items-center justify-center gap-2 text-center p-6">
        <span className="h-1.5 w-1.5 rounded-full bg-foreground/50 animate-pulse" />
        <p className="text-[11px] tracking-wide uppercase font-normal text-muted-foreground/60">Scan running</p>
        <p className="text-[10px] text-muted-foreground/40">Symbol insights resume when results are in</p>
      </div>
    );
  }

  // Only the insights payload gates the panel — the score sparkline is
  // decorative and pops in when it arrives; blocking on it doubled the wait.
  if (insightsQuery.isPending) {
    // Skeleton mirrors the loaded layout so content lands without reflow:
    // header+ring → price stats → gauges → matrix card → levels ladder.
    return (
      <div className="h-full bg-transparent overflow-hidden flex flex-col pt-3 pb-2 px-3">
        <div className="flex items-start justify-between gap-3 pb-3 shrink-0">
          <div className="min-w-0 flex-1 flex flex-col gap-2">
            <div className="flex items-center gap-2.5">
              <Skeleton className="h-2.5 w-2.5 rounded-full" />
              <Skeleton className="h-7 w-36" />
            </div>
            <div className="flex items-center gap-2">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-4 w-14 rounded" />
              <Skeleton className="h-3 w-12" />
            </div>
          </div>
          <Skeleton className="h-[54px] w-[54px] rounded-full shrink-0" />
        </div>
        <div className="grid grid-cols-3 gap-x-3 py-2.5 shrink-0">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex flex-col gap-1.5">
              <Skeleton className="h-2.5 w-12" />
              <Skeleton className="h-6 w-20" />
            </div>
          ))}
        </div>
        <div className="grid grid-cols-3 gap-x-3 py-2.5 shrink-0">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex flex-col gap-1.5">
              <Skeleton className="h-2.5 w-10" />
              <Skeleton className="h-4 w-14" />
              <Skeleton className="h-[3px] w-full rounded-full" />
            </div>
          ))}
        </div>
        <div className="mt-2 shrink-0 grid grid-cols-2 gap-x-6 gap-y-3">
          {[0, 1, 2, 3, 4, 5, 6].map((i) => (
            <div key={i} className="flex items-center justify-between gap-3">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-3 w-12" />
            </div>
          ))}
        </div>
        <div className="mt-3 pt-1 flex-1 min-h-0 flex flex-col gap-2">
          <Skeleton className="h-2.5 w-20" />
          <div className="flex-1 min-h-0 py-1 flex flex-col justify-evenly">
            {["w-[52%]", "w-[68%]", "w-[84%]", "w-[68%]", "w-[52%]"].map((w, i) => (
              <div key={i} className="flex items-center gap-2">
                <Skeleton className="h-3 w-5 shrink-0" />
                <Skeleton className={cn("h-[3px] rounded-full", w)} />
                <div className="flex-1" />
                <Skeleton className="h-3 w-16 shrink-0" />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (insightsQuery.isError || (!insights && !hasLtp)) {
    return (
      <div className="h-full bg-transparent border-0 flex flex-col items-center justify-center text-center p-6 text-muted-foreground gap-2">
        <p className="text-sm tracking-tight font-normal text-foreground">{selectedSymbol}</p>
        <p className="text-[11px] text-muted-foreground/70">
          {insightsQuery.isError ? "Couldn't load insights." : "No data — run a scan or pick an active stock."}
        </p>
        {/* retry:false means one transient failure would otherwise stick for
            the full refetch interval — give the user a way out. */}
        <button
          type="button"
          onClick={() => insightsQuery.refetch()}
          disabled={insightsQuery.isFetching}
          className="mt-1 px-3 py-1 rounded-md border border-foreground/25 text-[11px] text-foreground/80 hover:bg-foreground hover:text-background transition-colors duration-200 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
        >
          {insightsQuery.isFetching ? "Retrying…" : "Retry"}
        </button>
      </div>
    );
  }

  const rsi = indicators?.rsi14 ?? null;
  const adx = indicators?.adx14 ?? null;
  const volRatio = indicators?.volumeRatio ?? null;
  const composite = forecast?.compositeScore ?? null;

  return (
    <motion.div
      initial="hidden"
      animate="visible"
      variants={{ hidden: {}, visible: { transition: { staggerChildren: 0.045, delayChildren: 0.04 } } }}
      className="@container h-full bg-transparent overflow-hidden flex flex-col text-card-foreground pt-3 pb-2 px-3 border-0"
    >
      {/* ── HEADER: identity + composite ring ─────────────────────────────── */}
      <Section className="flex items-start justify-between gap-3 pb-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="relative flex h-2.5 w-2.5 shrink-0">
              <span className={cn(
                "absolute inline-flex h-full w-full rounded-full opacity-60",
                trend === "BULL" ? "bg-bull animate-ping [animation-duration:2.4s]"
                  : trend === "BEAR" ? "bg-bear animate-ping [animation-duration:2.4s]"
                  : session?.isMarketOpen ? "bg-bull/60 animate-ping [animation-duration:3s]" : "",
              )} />
              <span className={cn(
                "relative inline-flex h-2.5 w-2.5 rounded-full",
                trend === "BULL" ? "bg-bull shadow-[0_0_10px_rgba(34,197,94,0.7)]"
                  : trend === "BEAR" ? "bg-bear shadow-[0_0_10px_rgba(239,68,68,0.7)]"
                  : session?.isMarketOpen ? "bg-bull/80" : "bg-neutral-500",
              )} />
            </span>
            <h2 className="min-w-0 flex-1">
              <FitText className="text-2xl @[24rem]:text-3xl font-medium tracking-[-0.03em] leading-none font-sans">{selectedSymbol}</FitText>
            </h2>
            <button onClick={handleCopySymbol} className="text-muted-foreground/60 hover:text-foreground transition-colors p-1 hover:bg-secondary/50 rounded-md shrink-0" title="Copy symbol">
              {copied ? <Check className="w-3.5 h-3.5 text-bull" /> : <Copy className="w-3.5 h-3.5" />}
            </button>
          </div>
          <div className="flex items-center gap-2 mt-1.5 min-w-0 whitespace-nowrap overflow-hidden">
            {insights?.sector && (
              <span className="text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground font-sans truncate">{insights.sector}</span>
            )}
            {trend && (
              <span className={cn(
                "text-[9px] font-medium uppercase tracking-[0.1em] px-1.5 py-[2px] rounded border shrink-0",
                trend === "BULL" ? "text-bull border-bull/25 bg-bull/[0.06]"
                  : trend === "BEAR" ? "text-bear border-bear/25 bg-bear/[0.06]"
                  : "text-yellow-500 border-yellow-500/25 bg-yellow-500/[0.06]",
              )}>
                {trend === "BULL" ? "Bullish" : trend === "BEAR" ? "Bearish" : "Sideways"}
              </span>
            )}
            <LiveChangePct symbol={selectedSymbol} decimals={2} className="text-xs font-mono font-medium shrink-0" />
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {scoreHistory.length >= 3 && (
            <Tooltip content="Composite score evolution across recent scans" align="end" side="bottom">
              <div className="flex flex-col items-end gap-0.5">
                <Sparkline
                  data={scoreHistory}
                  color={scoreHistory[scoreHistory.length - 1] > scoreHistory[0] ? "#22c55e" : scoreHistory[scoreHistory.length - 1] < scoreHistory[0] ? "#ef4444" : "#a3a3a3"}
                  className="w-14 h-5 opacity-70"
                />
                <span className={cn(
                  "text-[9px] font-mono tabular-nums",
                  scoreHistory[scoreHistory.length - 1] > scoreHistory[0] ? "text-bull/80" : scoreHistory[scoreHistory.length - 1] < scoreHistory[0] ? "text-bear/80" : "text-neutral-500",
                )}>
                  {scoreHistory[scoreHistory.length - 1] - scoreHistory[0] > 0 ? "+" : ""}{fmtNum(scoreHistory[scoreHistory.length - 1] - scoreHistory[0], 0)} pts
                </span>
              </div>
            </Tooltip>
          )}
          <div title="Mimir composite: trend, momentum, volume and ML blended. >70 bullish · <40 bearish.">
            <ScoreRing score={composite} />
          </div>
        </div>
      </Section>

      {/* ── PRICE ROW: LTP / reference / change ────────────────────────── */}
      <Section className="grid grid-cols-3 gap-x-3 py-2.5">
        <Stat label="LTP" xl value={<LivePrice symbol={selectedSymbol} decimals={2} fallback={indicators?.close} />} />
        <Stat
          xl
          label={selectedSignal || monitoring?.entryPrice ? "Entry" : scan?.provisional_trigger ? "Trigger" : indicators?.vwap ? "VWAP" : "EMA20"}
          value={(() => {
            const active = selectedSignal?.entryPrice || monitoring?.entryPrice;
            if (active) return fmtNum(active);
            if (scan?.provisional_trigger) {
              return <span className="opacity-50 border-b border-dotted border-current pb-[1px]">{fmtNum(scan.provisional_trigger)}</span>;
            }
            const ref = indicators?.vwap ?? indicators?.ema20;
            return ref ? <span className="opacity-75">{fmtNum(ref)}</span> : "—";
          })()}
        />
        <ChangePctStat symbol={selectedSymbol} />
      </Section>

      {/* ── TRADE PLAN: only when an actionable signal exists ─────────────── */}
      <AnimatePresence initial={false}>
        {selectedSignal && (
          <motion.div
            key="trade-plan"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={SPRING_STANDARD}
            className="shrink-0 overflow-hidden"
          >
            <div className="relative mb-2 pl-3">
              <div className={cn("absolute inset-y-1 left-0 w-[2px] rounded-full", selectedSignal.direction === "BUY" ? "bg-bull/60" : "bg-bear/60")} />
              <div className="flex items-center justify-between pt-1">
                <span className={cn(
                  "text-[9px] font-medium uppercase tracking-[0.16em] flex items-center gap-1.5",
                  selectedSignal.direction === "BUY" ? "text-bull/90" : "text-bear/90",
                )}>
                  <Crosshair className="h-3 w-3" />
                  {selectedSignal.direction === "BUY" ? "Long" : "Short"} · {(selectedSignal.setupType || "").replace(/_/g, " ").toLowerCase()}
                </span>
                {selectedSignal.setupStats && (
                  <Tooltip content={`Historical hit rate over ${selectedSignal.setupStats.samples} closed trades of this setup`} align="end" side="bottom">
                    <span className={cn(
                      "text-[9px] font-mono tabular-nums",
                      selectedSignal.setupStats.winRate >= 60 ? "text-bull" : selectedSignal.setupStats.winRate >= 45 ? "text-amber-500" : "text-bear",
                    )}>
                      {selectedSignal.setupStats.winRate}% hit · n={selectedSignal.setupStats.samples}
                    </span>
                  </Tooltip>
                )}
              </div>
              <div className="grid grid-cols-4 gap-x-2 pb-1 pt-1.5">
                <Stat label="Stop" value={fmtNum(selectedSignal.stopLoss)} color="text-bear" />
                <Stat label="Target" value={fmtNum(selectedSignal.target1)} color="text-bull" />
                <Stat label="R : R" value={`${fmtNum(selectedSignal.riskReward, 1)}x`} />
                <Stat
                  label="Hold"
                  value={selectedSignal.expectedHoldMinutes == null ? "—"
                    : selectedSignal.expectedHoldMinutes >= 390 ? `~${Math.round(selectedSignal.expectedHoldMinutes / 390)}d`
                    : selectedSignal.expectedHoldMinutes >= 60 ? `~${Math.floor(selectedSignal.expectedHoldMinutes / 60)}h`
                    : `~${selectedSignal.expectedHoldMinutes}m`}
                />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── MOMENTUM GAUGES: RSI / ADX / VOL in one fixed row ─────────────── */}
      <Section className="grid grid-cols-3 gap-x-3 py-2.5">
        <MiniGauge
          label="RSI 14"
          display={rsi != null ? fmtNum(rsi, 0) : "—"}
          sub={rsi == null ? "" : rsi >= 70 ? "overbought" : rsi <= 30 ? "oversold" : rsi >= 50 ? "bullish" : "bearish"}
          pct={rsi}
          tone={rsi == null ? "muted" : rsi >= 50 ? "bull" : "bear"}
          marks={[30, 70]}
          onClick={() => setSelectedMetric("rsiMomentum")}
        />
        <MiniGauge
          label="ADX 14"
          display={adx != null ? fmtNum(adx, 0) : "—"}
          sub={adx == null ? "" : adx >= 25 ? "trending" : adx >= 20 ? "building" : "ranging"}
          pct={adx != null ? Math.min(100, (adx / 50) * 100) : null}
          tone={adx == null ? "muted" : adx >= 25 ? "accent" : "muted"}
          marks={[40, 50]}
          onClick={() => setSelectedMetric("primaryTrend")}
        />
        <MiniGauge
          label="Vol"
          display={volRatio != null ? `${fmtNum(volRatio, 1)}x` : "—"}
          sub={volRatio == null ? "" : volRatio >= 1.5 ? "surging" : volRatio >= 1 ? "normal" : "thin"}
          pct={volRatio != null ? Math.min(100, (volRatio / 3) * 100) : null}
          tone={volRatio == null ? "muted" : volRatio >= 1.5 ? "bull" : "muted"}
          marks={[33.3, 50]}
          onClick={() => setSelectedMetric("volumeSurge")}
        />
      </Section>

      {/* ── MATRIX: technicals + AI, or drill-down detail ─────────────────── */}
      <Section className="py-1">
        <AnimatePresence mode="popLayout" initial={false}>
          {selectedMetric ? (
            <motion.div layout transition={SPRING_STANDARD} key="detail" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} className="flex flex-col w-full">
              <MetricDetailView
                metricId={selectedMetric}
                onBack={() => setSelectedMetric(null)}
                insights={insights}
                forecast={forecast}
                selectedSignal={selectedSignal}
                scan={scan}
              />
            </motion.div>
          ) : (
            <motion.div layout transition={SPRING_STANDARD} key="grid" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }} className="flex flex-col w-full">
              <Card>
                <div className="grid grid-cols-2 gap-x-6">
                  {/* Structure column. No Trend row (header chip owns it) and
                      no ADX row (the gauge above owns it). */}
                  <ul className="flex flex-col min-w-0">
                    <ColumnHead icon={<Layers className="h-3 w-3" />}>Structure</ColumnHead>
                    <MatrixRow
                      onClick={() => setSelectedMetric("emaDistance")}
                      label="EMA20 Dist"
                      value={indicators?.distFromEma20Pct == null ? "—" : fmtPct(indicators.distFromEma20Pct)}
                      color={indicators?.distFromEma20Pct == null ? "text-neutral-500" : Math.abs(indicators.distFromEma20Pct) > 3 ? "text-amber-500" : "text-foreground/90"}
                    />
                    <VwapRow symbol={selectedSymbol} monitoring={monitoring} indicators={indicators} forecast={forecast} onClick={() => setSelectedMetric("vwapSupport")} />
                    <MtfRow scan={scan} selectedSignal={selectedSignal} mtf_score={mtf_score} mtf_total={mtf_total} onClick={() => setSelectedMetric("mtfConfluence")} />
                  </ul>
                  {/* AI column */}
                  <ul className="flex flex-col min-w-0">
                    <ColumnHead icon={<Flame className="h-3 w-3" />}>Alpha</ColumnHead>
                    <MatrixRow
                      onClick={() => setSelectedMetric("techEdge")}
                      label="Tech Edge"
                      value={techEdgeVal == null ? "—" : <span className="flex items-center">{`${techEdgeVal}%`}<InlineGauge pct={Number(techEdgeVal)} color="bg-bull" /></span>}
                      color="text-bull/90"
                    />
                    <MatrixRow
                      onClick={() => setSelectedMetric("regimeAlign")}
                      label="Regime"
                      value={regimeAlignVal == null ? "—" : <span className="flex items-center">{`${regimeAlignVal}%`}<InlineGauge pct={Number(regimeAlignVal)} color="bg-bull" /></span>}
                      color="text-bull/90"
                    />
                    <MatrixRow
                      onClick={() => setSelectedMetric("aiForecast")}
                      label="Forecast"
                      value={forecast?.forecastReturnPct ? fmtPct(forecast.forecastReturnPct) : "—"}
                      color={forecast?.forecastReturnPct && forecast.forecastReturnPct > 0 ? "text-bull" : forecast?.forecastReturnPct && forecast.forecastReturnPct < 0 ? "text-bear" : "text-neutral-500"}
                    />
                    <PatternRow forecast={forecast} selectedSignal={selectedSignal} scan={scan} onClick={() => setSelectedMetric("pricePattern")} />
                  </ul>
                </div>
              </Card>
            </motion.div>
          )}
        </AnimatePresence>
      </Section>

      {/* ── KEY LEVELS: absorbs remaining height, never scrolls ───────────── */}
      <div className="mt-2 pt-1 flex-1 min-h-0 overflow-hidden flex flex-col justify-start">
        <SupportResistancePanel selectedSymbol={selectedSymbol} />
      </div>
    </motion.div>
  );
});

/* ── Layout atoms ──────────────────────────────────────────────────────────── */

/**
 * Scale-to-fit single line: when content is wider than the container it is
 * scaled down (origin-left) instead of clipping digits — "₹24,334.30" must
 * never render as "₹24,334.3". Uses transform only (compositor-friendly).
 */
function FitText({ children, className }: { children: React.ReactNode; className?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    const text = textRef.current;
    if (!container || !text) return;
    const resize = () => {
      const cw = container.clientWidth;
      const tw = text.scrollWidth;
      if (tw > cw && cw > 0) {
        text.style.transform = `scale(${Math.max(0.5, cw / tw)})`;
      } else {
        text.style.transform = "none";
      }
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    observer.observe(text);
    return () => observer.disconnect();
  }, [children]);

  return (
    <div ref={containerRef} className="w-full min-w-0 overflow-hidden">
      <div ref={textRef} className={cn("origin-left whitespace-nowrap inline-block", className)}>
        {children}
      </div>
    </div>
  );
}

function Section({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <motion.div
      variants={{ hidden: { opacity: 0, y: 8 }, visible: { opacity: 1, y: 0, transition: { type: "spring", stiffness: 420, damping: 32 } } }}
      className={cn("shrink-0 min-w-0", className)}
    >
      {children}
    </motion.div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  // Flat by design: no border, no fill — hierarchy comes from whitespace and
  // the section labels, not from drawing boxes around content.
  return <div className="relative pb-1 pt-0.5">{children}</div>;
}

function ColumnHead({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <li className="flex items-center gap-1.5 text-[9px] font-medium font-sans uppercase tracking-[0.2em] text-muted-foreground/90 pt-2 pb-1.5 border-0">
      <span className="opacity-60">{icon}</span>
      {children}
    </li>
  );
}

/** Composite score as an animated SVG ring with the number centered. */
function ScoreRing({ score }: { score: number | null }) {
  const r = 21;
  const c = 2 * Math.PI * r;
  const pct = score != null ? Math.min(100, Math.max(0, score)) : 0;
  const tone = score == null ? "text-neutral-600" : score > 70 ? "text-bull" : score < 40 ? "text-bear" : "text-foreground";
  const stroke = score == null ? "rgba(115,115,115,0.35)" : score > 70 ? "#22c55e" : score < 40 ? "#ef4444" : "#e5e5e5";
  return (
    <div className="relative h-[54px] w-[54px] shrink-0">
      <svg viewBox="0 0 54 54" className="h-full w-full -rotate-90">
        <circle cx="27" cy="27" r={r} fill="none" stroke="currentColor" strokeWidth="3" className="text-foreground/[0.08]" />
        <motion.circle
          cx="27" cy="27" r={r} fill="none"
          stroke={stroke} strokeWidth="3" strokeLinecap="round"
          strokeDasharray={c}
          initial={{ strokeDashoffset: c }}
          animate={{ strokeDashoffset: c - (pct / 100) * c }}
          transition={{ duration: 1.1, ease: [0.22, 1, 0.36, 1] }}
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center leading-none">
        <span className={cn("font-mono font-medium text-base tabular-nums tracking-tight", tone)}>
          {score != null ? <AnimatedNumber value={score} decimals={0} duration={0.6} /> : "—"}
        </span>
      </div>
    </div>
  );
}

/**
 * Single-line stat. Values are clamped with truncate — a stat that does not
 * fit gets ellipsized, it NEVER wraps to a second line.
 */
function Stat({ label, value, xl, color }: { label: string; value: React.ReactNode; xl?: boolean; color?: string }) {
  return (
    <div className="flex flex-col min-w-0 gap-1">
      <span className="text-[9px] font-medium font-sans uppercase tracking-[0.18em] text-muted-foreground truncate whitespace-nowrap">{label}</span>
      <FitText className={cn(
        "font-mono tabular-nums leading-none whitespace-nowrap",
        // Type scale: hero numerals get tighter tracking + medium weight; the
        // secondary tier stays lighter so the hierarchy reads from weight+size
        xl ? "text-xl @[24rem]:text-2xl @[30rem]:text-[1.7rem] font-medium tracking-[-0.03em]"
           : "text-sm @[24rem]:text-base font-normal tracking-[-0.01em]",
        color || "text-foreground",
      )}>
        {typeof value === "string" || typeof value === "number" ? <DecryptText text={String(value)} /> : value}
      </FitText>
    </div>
  );
}

/**
 * Compact momentum gauge: value + qualifier + a track with zone tick marks
 * and an animated fill. One fixed row, no wrapping.
 */
function MiniGauge({ label, display, sub, pct, tone, marks, onClick }: {
  label: string;
  display: string;
  sub: string;
  pct: number | null;
  tone: "bull" | "bear" | "accent" | "muted";
  marks: number[];
  onClick?: () => void;
}) {
  const fill = tone === "bull" ? "bg-bull" : tone === "bear" ? "bg-bear" : tone === "accent" ? "bg-amber-400" : "bg-neutral-500";
  const text = tone === "bull" ? "text-bull" : tone === "bear" ? "text-bear" : tone === "accent" ? "text-amber-400" : "text-neutral-400";
  return (
    <button onClick={onClick} className="group flex flex-col min-w-0 text-left cursor-pointer gap-[3px]">
      <span className="text-[9px] font-medium font-sans uppercase tracking-[0.18em] text-muted-foreground truncate group-hover:text-foreground/80 transition-colors">{label}</span>
      <div className="flex items-baseline gap-1.5 min-w-0">
        <span className={cn("font-mono font-medium tabular-nums text-base @[24rem]:text-lg leading-none tracking-[-0.02em] whitespace-nowrap", pct == null ? "text-neutral-500" : text)}>
          {display}
        </span>
        <span className="text-[9px] font-medium font-sans text-muted-foreground/80 lowercase tracking-wide truncate">{sub}</span>
      </div>
      <div className="relative h-[3px] mt-[3px] rounded-full bg-foreground/[0.08] overflow-hidden">
        {marks.map((m) => (
          <span key={m} className="absolute top-0 h-full w-px bg-foreground/20" style={{ left: `${m}%` }} />
        ))}
        {pct != null && (
          <motion.div
            className={cn("absolute inset-y-0 left-0 rounded-full", fill)}
            initial={{ width: 0 }}
            animate={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
            transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
          />
        )}
      </div>
    </button>
  );
}

/* ── Live sub-rows (self-subscribing so ticks re-render only these) ────────── */

function ChangePctStat({ symbol, fallback }: { symbol: string; fallback?: number }) {
  return (
    <Stat
      label="% Change"
      xl
      value={<LiveChangePct symbol={symbol} fallback={fallback} decimals={2} />}
    />
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function VwapRow({ symbol, monitoring, indicators, forecast, onClick }: { symbol: string; monitoring: any; indicators: any; forecast: any; onClick: () => void }) {
  const ltp = useSymbolDataSelector(symbol, (d) => d.ltp);
  const current = ltp ?? monitoring?.currentPrice ?? indicators?.close ?? 0;
  const vwapPrice = indicators?.vwap ?? forecast?.vwap;
  let value = "—";
  let color = "text-neutral-500";
  if (vwapPrice && current > 0) {
    value = current >= vwapPrice ? "ABOVE ▲" : "BELOW ▼";
    color = current >= vwapPrice ? "text-bull/90" : "text-bear/90";
  } else if (current > 0 && indicators?.ema9) {
    value = current >= indicators.ema9 ? "> EMA9" : "< EMA9";
    color = current >= indicators.ema9 ? "text-bull/90" : "text-bear/90";
  }
  return <MatrixRow onClick={onClick} label="VWAP" value={value} color={color} />;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function MtfRow({ scan, selectedSignal, mtf_score, mtf_total, onClick }: { scan: any; selectedSignal: Suggestion | null; mtf_score: number | null; mtf_total: number | null; onClick: () => void }) {
  const sigMtf = selectedSignal as (Suggestion & { mtfScore?: number; mtfTotal?: number; mtfConfluenceScore?: number }) | null;
  const rawS = scan?.mtfScore ?? sigMtf?.mtfScore ?? mtf_score ?? 0;
  const rawT = scan?.mtfTotal ?? sigMtf?.mtfTotal ?? mtf_total ?? 0;
  const s = rawS;
  const t = rawT > 0 ? rawT : rawS > 0 ? 3 : scan ? scan.mtfTotal || 3 : 3;
  const conf = scan?.mtfConfluenceScore ?? sigMtf?.mtfConfluenceScore ?? (s === 0 ? -1 : 1);
  const isNoData = (t === 0 && s === 0) || (scan === null && !selectedSignal && !mtf_score);

  // Short vocabulary — these values live on one line, always.
  let label = "DIVERGING";
  let style = "text-bear";
  if (isNoData) { label = "NO DATA"; style = "text-neutral-500"; }
  else if (s === 0 || conf < 0) { label = "NO ALIGN"; style = "text-bear"; }
  else if ((s > 0 && s < t) || conf === 0) { label = "PARTIAL"; style = "text-yellow-500"; }
  else if (s === t || conf > 0) { label = "ALIGNED"; style = "text-bull"; }

  return (
    <MatrixRow
      onClick={onClick}
      label="MTF 15m·1h·1d"
      value={
        <span className={cn("flex items-center gap-1.5 whitespace-nowrap", style)}>
          {!isNoData && (
            <span className="flex items-center gap-[3px]" aria-label={`${s} of ${t} timeframes aligned`}>
              {Array.from({ length: Math.max(1, Math.min(4, t)) }, (_, i) => (
                <span key={i} className={cn("h-[9px] w-[3px] rounded-full", i < s ? "bg-current" : "bg-foreground/15")} />
              ))}
            </span>
          )}
          <span>{label}</span>
        </span>
      }
      color={style}
    />
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function PatternRow({ forecast, selectedSignal, scan, onClick }: { forecast: any; selectedSignal: Suggestion | null; scan: any; onClick: () => void }) {
  const pattern =
    forecast?.technicalPatterns && forecast.technicalPatterns.length > 0
      ? forecast.technicalPatterns[0]
      : (selectedSignal?.setupType || scan?.setupType) && (selectedSignal?.setupType || scan?.setupType) !== "LIQUIDITY_SWEEP"
        ? selectedSignal?.setupType || scan?.setupType
        : null;
  return (
    <MatrixRow
      onClick={onClick}
      label="Pattern"
      value={
        pattern ? (
          <span className="flex items-center gap-1 text-orange-500 whitespace-nowrap min-w-0">
            <Flame className="h-3 w-3 shrink-0" />
            <span className="truncate uppercase">{String(pattern).replace(/_/g, " ")}</span>
          </span>
        ) : "—"
      }
      color={pattern ? "text-orange-500" : "text-neutral-500"}
    />
  );
}

/* ── Text effects ──────────────────────────────────────────────────────────── */

function DecryptText({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const prevTextRef = useRef<string>("");

  useEffect(() => {
    if (!text || !ref.current) return;
    // Honor reduced-motion: the scramble is pure decoration, and on every
    // refetch it churns a data-dense panel for users who asked for calm.
    if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      ref.current.innerText = text;
      prevTextRef.current = text;
      return;
    }
    if (prevTextRef.current && text.length === prevTextRef.current.length && prevTextRef.current !== text) {
      ref.current.innerText = text;
      prevTextRef.current = text;
      return;
    }
    prevTextRef.current = text;
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*";
    let iteration = 0;
    const interval = setInterval(() => {
      if (!ref.current) return;
      ref.current.innerText = text.split("").map((_, index) => {
        if (index < iteration) return text[index];
        return chars[Math.floor(Math.random() * chars.length)];
      }).join("");
      if (iteration >= text.length) {
        clearInterval(interval);
        if (ref.current) ref.current.innerText = text;
      }
      iteration += 1 / 2;
    }, 20);
    return () => clearInterval(interval);
  }, [text]);

  return <span ref={ref}>{text}</span>;
}

/* ── Matrix row ────────────────────────────────────────────────────────────── */

function MatrixRow({ label, value, color, onClick }: { label: string; value: React.ReactNode; color: string; onClick?: () => void }) {
  return (
    <li
      onClick={onClick}
      onKeyDown={onClick ? (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      } : undefined}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      className={cn(
        "flex justify-between items-center group gap-2 py-[7px] min-w-0 overflow-hidden transition-colors whitespace-nowrap",
        onClick ? "cursor-pointer hover:bg-foreground/[0.03] rounded-md -mx-1.5 px-1.5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60" : "cursor-default",
      )}
    >
      <span className="text-muted-foreground font-medium font-sans text-[10.5px] tracking-[0.02em] shrink truncate whitespace-nowrap group-hover:text-foreground transition-colors">{label}</span>
      <span className={cn("font-medium font-mono text-[11.5px] flex items-center justify-end text-right shrink-0 tabular-nums whitespace-nowrap tracking-[-0.01em]", color)}>
        {typeof value === "string" || typeof value === "number" ? <DecryptText text={String(value)} /> : value}
      </span>
    </li>
  );
}

function InlineGauge({ pct, color }: { pct: number; color: string }) {
  return (
    <div className="relative w-8 h-[3px] bg-foreground/10 rounded-full overflow-hidden ml-1.5 flex-shrink-0">
      <motion.div
        initial={{ width: 0 }}
        animate={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
        transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
        className={cn("h-full rounded-full", color)}
      />
    </div>
  );
}

/* ── Drill-down detail views (unchanged content, tighter chrome) ───────────── */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function MetricDetailView({ metricId, onBack, insights, forecast, selectedSignal, scan }: any) {
  let title = "";
  let content = null;

  switch (metricId) {
    case "primaryTrend":
      title = "Primary Trend";
      content = (
        <div className="flex flex-col gap-3 text-xs text-foreground/90">
          <p className="leading-relaxed text-muted-foreground text-[11px]">The primary trend dictates the overarching market direction derived from higher timeframe Exponential Moving Averages (EMAs) and the Average Directional Index (ADX). Trading in the direction of the primary trend significantly increases the probability of a successful setup by aligning with institutional momentum.</p>
          <div className="flex flex-col">
            <div className="flex justify-between items-center border-b border-border/10 py-1.5">
              <span className="text-muted-foreground">Direction</span>
              <span className="font-normal">{insights?.indicators?.trend?.toUpperCase() || "UNKNOWN"}</span>
            </div>
            <div className="flex justify-between items-center border-b border-border/10 py-1.5">
              <span className="text-muted-foreground">ADX (Trend Strength)</span>
              <span className="font-normal tabular-nums">{insights?.indicators?.adx14 ? fmtNum(insights.indicators.adx14) : "—"}</span>
            </div>
          </div>
          <p className="text-[10px] text-muted-foreground leading-relaxed">ADX &gt; 25 indicates a strong trend. ADX &lt; 20 indicates ranging.</p>
        </div>
      );
      break;
    case "pricePattern":
      title = "Price Pattern";
      content = (
        <div className="flex flex-col gap-3 text-xs text-foreground/90">
          <p className="leading-relaxed text-muted-foreground text-[11px]">Technical Pattern Engine recognition scanning across 1D and 1H timeframes. It detects classical chart formations (like Head &amp; Shoulders, Flags, Triangles) and complex candlestick structures to predict imminent volatility expansions.</p>
          {forecast?.technicalPatterns && forecast.technicalPatterns.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              {forecast.technicalPatterns.map((p: string) => (
                <div key={p} className="text-orange-500 py-1 border-b border-border/10 font-normal uppercase tracking-wide text-sm">{p.replace(/_/g, " ")}</div>
              ))}
            </div>
          ) : (
            <div className="text-muted-foreground py-1 italic border-b border-border/10 text-xs">No major patterns detected.</div>
          )}
        </div>
      );
      break;
    case "rsiMomentum":
      title = "RSI Momentum";
      content = (
        <div className="flex flex-col gap-3 text-xs text-foreground/90">
          <p className="leading-relaxed text-muted-foreground text-[11px]">The Relative Strength Index (RSI, 14-period) is an oscillator measuring the speed and magnitude of recent price changes. An RSI &gt; 70 generally indicates overbought conditions (ripe for a pullback), while an RSI &lt; 30 indicates oversold conditions. However, in strong trends, RSI can remain in these extreme zones for extended periods.</p>
          <div className="flex flex-col">
            <div className="flex justify-between items-center border-b border-border/10 py-1.5">
              <span className="text-muted-foreground">Current RSI</span>
              <span className="font-normal tabular-nums">{insights?.indicators?.rsi14 ? fmtNum(insights.indicators.rsi14, 1) : "—"}</span>
            </div>
            <div className="flex justify-between items-center border-b border-border/10 py-1.5">
              <span className="text-muted-foreground">Zone</span>
              <span className="font-normal">{insights?.indicators?.rsi14 >= 70 ? "Overbought" : insights?.indicators?.rsi14 <= 30 ? "Oversold" : "Neutral"}</span>
            </div>
          </div>
        </div>
      );
      break;
    case "volumeSurge":
      title = "Volume Surge";
      content = (
        <div className="flex flex-col gap-3 text-xs text-foreground/90">
          <p className="leading-relaxed text-muted-foreground text-[11px]">Measures anomalous volume spikes by comparing current bar volume against its 20-period moving average. A breakout accompanied by a high volume surge (ratio &gt; 1.5x) suggests strong institutional participation and confirms the validity of the price move.</p>
          <div className="flex flex-col">
            <div className="flex justify-between items-center border-b border-border/10 py-1.5">
              <span className="text-muted-foreground">Volume Ratio</span>
              <span className="font-normal tabular-nums">{insights?.indicators?.volumeRatio ? `${fmtNum(insights.indicators.volumeRatio, 2)}x` : "—"}</span>
            </div>
          </div>
          <p className="text-[10px] text-muted-foreground leading-relaxed">Values &gt; 1.5x indicate strong institutional participation.</p>
        </div>
      );
      break;
    case "emaDistance":
      title = "EMA Analysis";
      content = (
        <div className="flex flex-col gap-3 text-xs text-foreground/90">
          <p className="leading-relaxed text-muted-foreground text-[11px]">Measures the distance between current price and key short-term Exponential Moving Averages (9 &amp; 20 EMA). While EMAs act as dynamic support/resistance, excessive deviation from the 20 EMA (mean reversion stretch) warns that the asset is overextended and vulnerable to a sharp pullback.</p>
          <div className="flex flex-col">
            <div className="flex justify-between items-center border-b border-border/10 py-1.5">
              <span className="text-muted-foreground">9 EMA</span>
              <span className="font-normal tabular-nums">{insights?.indicators?.ema9 ? fmtNum(insights.indicators.ema9) : "—"}</span>
            </div>
            <div className="flex justify-between items-center border-b border-border/10 py-1.5">
              <span className="text-muted-foreground">20 EMA</span>
              <span className="font-normal tabular-nums">{insights?.indicators?.ema20 ? fmtNum(insights.indicators.ema20) : "—"}</span>
            </div>
            <div className="flex justify-between items-center border-b border-border/10 py-1.5">
              <span className="text-muted-foreground">Distance from 20 EMA</span>
              <span className="font-normal tabular-nums">{insights?.indicators?.distFromEma20Pct != null ? fmtPct(insights.indicators.distFromEma20Pct) : "—"}</span>
            </div>
          </div>
        </div>
      );
      break;
    case "techEdge":
      title = "Tech Edge";
      content = (
        <div className="flex flex-col gap-3 text-xs text-foreground/90">
          <p className="leading-relaxed text-muted-foreground text-[11px]">A proprietary algorithmic score aggregating RSI, Volume ratios, MACD, and ADX momentum alignment. A high positive contribution indicates that multiple independent technical factors are simultaneously confirming the setup's breakout strength.</p>
          <div className="flex flex-col">
            <div className="flex justify-between items-center border-b border-border/10 py-1.5">
              <span className="text-muted-foreground">Total Contribution</span>
              <span className="font-normal text-bull tabular-nums">+{selectedSignal?.signalFactors?.technical?.contribution ?? 0}%</span>
            </div>
          </div>
        </div>
      );
      break;
    case "mtfConfluence":
      title = "MTF Confluence";
      content = (
        <div className="flex flex-col gap-3 text-xs text-foreground/90">
          <p className="leading-relaxed text-muted-foreground text-[11px]">Multi-Timeframe (MTF) analysis evaluates the alignment of trends across micro (15m), intermediate (1h), and macro (1d) charts. High confluence guarantees that you aren't trading against a hidden higher-timeframe resistance level, reducing false breakouts.</p>
          <div className="flex flex-col">
            <div className="flex justify-between items-center border-b border-border/10 py-1.5">
              <span className="text-muted-foreground">Confluence Score</span>
              <span className="font-normal tabular-nums">{scan?.mtfConfluenceScore ? `${scan.mtfConfluenceScore}/100` : "PENDING"}</span>
            </div>
          </div>
          <p className="text-[10px] text-muted-foreground leading-relaxed">Scores &ge; 70 indicate strong alignment across all timeframes.</p>
        </div>
      );
      break;
    case "vwapSupport":
      title = "VWAP Support";
      content = (
        <div className="flex flex-col gap-3 text-xs text-foreground/90">
          <p className="leading-relaxed text-muted-foreground text-[11px]">The Volume Weighted Average Price (VWAP) represents the true average price a stock has traded at throughout the day, based on both volume and price. Institutions use VWAP as a benchmark for execution; price holding above VWAP signifies intraday buyer dominance.</p>
          <div className="flex flex-col">
            <div className="flex justify-between items-center border-b border-border/10 py-1.5">
              <span className="text-muted-foreground">Status</span>
              {(() => {
                const vwap = insights?.indicators?.vwap;
                const close = insights?.indicators?.close;
                if (vwap && close) {
                  const holding = close >= vwap;
                  return <span className={cn("font-normal", holding ? "text-bull" : "text-bear")}>{holding ? "> VWAP (HOLDING)" : "< VWAP (BROKEN)"}</span>;
                }
                return <span className="font-normal text-neutral-500">—</span>;
              })()}
            </div>
          </div>
        </div>
      );
      break;
    case "regimeAlign":
      title = "Regime Alignment";
      content = (
        <div className="flex flex-col gap-3 text-xs text-foreground/90">
          <p className="leading-relaxed text-muted-foreground text-[11px]">Evaluates if the specific stock setup is swimming with or against the tide of the broader market (NIFTY/BankNIFTY) and prevailing volatility (VIX). High regime alignment drastically lowers the probability of an unexpected systemic drawdown invalidating your trade.</p>
          <div className="flex flex-col">
            <div className="flex justify-between items-center border-b border-border/10 py-1.5">
              <span className="text-muted-foreground">Contribution</span>
              <span className="font-normal text-bull tabular-nums">+{selectedSignal?.signalFactors?.regime?.contribution ?? 0}%</span>
            </div>
          </div>
        </div>
      );
      break;
    case "aiForecast":
      title = "AI Forecast";
      content = (
        <div className="flex flex-col gap-3 text-xs text-foreground/90">
          <p className="leading-relaxed text-muted-foreground text-[11px]">The projected short-term price trajectory computed by the deep learning models. This aggregates multiple neural network layers parsing the feature vector to predict the directional percentage move over the holding period.</p>
          <div className="flex flex-col">
            <div className="flex justify-between items-center border-b border-border/10 py-1.5">
              <span className="text-muted-foreground">Projected Move</span>
              <span className="font-normal tabular-nums">{forecast?.medianForecast ? fmtPct(forecast.medianForecast[forecast.medianForecast.length - 1] * 100) : "—"}</span>
            </div>
          </div>
        </div>
      );
      break;
  }

  return (
    <div className="flex flex-col animate-in fade-in duration-200">
      <div className="flex items-center gap-2 mb-2 shrink-0 mt-0.5">
        <button onClick={onBack} aria-label="Go back" className="p-1 -ml-1 hover:bg-foreground/5 rounded-full transition-colors apple-hover text-muted-foreground hover:text-foreground">
          <ChevronLeft className="h-4 w-4" />
        </button>
        <h3 className="text-xs font-normal tracking-tight uppercase">{title}</h3>
      </div>
      {content}
    </div>
  );
}
