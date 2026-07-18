import React, { useState, useEffect, useMemo, useRef, useLayoutEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { Flame, BarChart3, Cpu, ChevronLeft, Copy, Check } from "lucide-react";
import { cn, fmtNum, fmtPct, calcPnLPct } from "@/lib/format";
import { api } from "@/lib/api";
import { Tooltip } from "@/components/mimir/tooltip";
import { Sparkline } from "@/components/Sparkline";
import { SupportResistancePanel } from "@/components/SupportResistancePanel";
import { LivePrice } from "@/components/atoms/LivePrice";
import { LiveChangePct } from "@/components/atoms/LiveChangePct";
import { AnimatedNumber } from "@/components/atoms/AnimatedNumber";
import { useSymbolDataSelector } from "@/providers/MarketDataProvider";
import type { Suggestion, SessionState } from "@/types/api";
import { FADE_STANDARD, SPRING_STANDARD } from "@/lib/motion";

interface DetailPanelProps {
  suggestions: Suggestion[];
  selectedSymbol: string;
  session: SessionState | undefined;
  isScanActive?: boolean;
}

export const DetailPanel = React.memo(function DetailPanel({ suggestions, selectedSymbol, session, isScanActive }: DetailPanelProps) {
  // Boolean selector: the panel only needs to know whether a live price exists
  // (line ~98 empty-state guard); rows that display the tick subscribe themselves.
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
    navigator.clipboard.writeText(selectedSymbol);
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
    enabled: Boolean(selectedSymbol && typeof selectedSymbol === 'string' && selectedSymbol.trim()),
    retry: false,
    refetchInterval: 300000,
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
  });
  const scoreHistory = scoreHistoryQuery.data?.history ?? [];

  if (!selectedSymbol) {
    return (
      <div className="h-full bg-transparent border-0 flex flex-col items-center justify-center text-neutral-600">
        <p className="text-[11px] tracking-wide uppercase font-normal text-muted-foreground/50">Select a symbol</p>
      </div>
    );
  }

  if (isScanActive) {
    return (
      <div className="h-full bg-transparent border-0 flex flex-col items-center justify-center text-neutral-600">
      </div>
    );
  }

  if (insightsQuery.isPending || scoreHistoryQuery.isPending) {
    return (
      <div className="h-full bg-transparent border-0 flex flex-col items-center justify-center text-neutral-600">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  if (insightsQuery.isError || (!insights && !hasLtp)) {
    return (
      <div className="h-full bg-transparent border-0 flex flex-col items-center justify-center text-center p-6 text-muted-foreground gap-2">
        <p className="text-sm tracking-tight font-normal text-foreground">{selectedSymbol}</p>
        <p className="text-[11px] text-muted-foreground/70">No data — run a scan or pick an active stock.</p>
      </div>
    );
  }

  // const deviation = monitoring?.currentPrice && monitoring?.entryPrice ? ((monitoring.currentPrice - monitoring.entryPrice) / monitoring.entryPrice) : null;

  return (
    <motion.div
      initial="hidden"
      animate="visible"
      variants={{
        hidden: {},
        visible: { transition: { staggerChildren: 0.05, delayChildren: 0.06 } }
      }}
      className="@container h-full bg-transparent overflow-hidden flex flex-col text-card-foreground pt-3 pb-2 border-0 [&::-webkit-scrollbar]:hidden"
    >
      
      {/* HEADER: Symbol & Composite Score */}
      <motion.div variants={{ hidden: { opacity: 0, y: 8 }, visible: { opacity: 1, y: 0, transition: { type: "spring", stiffness: 420, damping: 32 } } }} className="flex justify-between items-start pb-2.5 shrink-0 min-w-0">
        <div className="min-w-0 pr-2">
          <div className="flex items-center gap-2 mb-1 min-w-0">
             <div className={cn(
               "w-2.5 h-2.5 rounded-full shrink-0 shadow-sm transition-colors",
               selectedSignal?.direction === "BUY" || (!selectedSignal && forecast?.trend === "bullish")
                 ? "bg-bull shadow-[0_0_8px_rgba(34,197,94,0.6)]"
                 : selectedSignal?.direction === "SELL" || (!selectedSignal && forecast?.trend === "bearish")
                 ? "bg-bear shadow-[0_0_8px_rgba(239,68,68,0.6)]"
                 : session?.isMarketOpen
                 ? "bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]"
                 : "bg-neutral-500"
             )} />
             <div className="flex items-center gap-3 min-w-0">
               <h2 className="text-2xl @[22rem]:text-3xl @[30rem]:text-4xl font-normal tracking-tighter leading-none truncate">{selectedSymbol || "—"}</h2>
               <button onClick={handleCopySymbol} className="text-muted-foreground hover:text-foreground transition-colors p-1.5 hover:bg-secondary/50 rounded-md shrink-0" title="Copy symbol to clipboard">
                 {copied ? <Check className="w-4 h-4 text-bull" /> : <Copy className="w-4 h-4" />}
               </button>
             </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs font-mono font-normal tracking-wide text-muted-foreground mt-2">
             {[
               insights?.sector ? (
                 <span key="sector" className="uppercase break-words text-foreground/80 font-normal">{insights.sector}</span>
               ) : null,
               (() => {
                 const unifiedTrend = (forecast?.trend || indicators?.trend || selectedSignal?.direction || "").toString().toLowerCase();
                 if (!unifiedTrend) return null;
                 const isBull = unifiedTrend.includes("bull") || unifiedTrend === "up" || unifiedTrend === "buy";
                 const isBear = unifiedTrend.includes("bear") || unifiedTrend === "down" || unifiedTrend === "sell";
                 const label = isBull ? "BULLISH" : isBear ? "BEARISH" : "SIDEWAYS";
                 const color = isBull ? "text-bull font-normal" : isBear ? "text-bear font-normal" : "text-yellow-500 font-normal";
                 return <span key="trend" className={cn("uppercase whitespace-nowrap", color)}>{label} TREND</span>;
               })(),
               (session?.isMarketOpen || forecast || selectedSymbol?.includes("NIFTY") || selectedSymbol === "SENSEX") ? (
                 <LiveChangePct key="changepct" symbol={selectedSymbol} decimals={2} className="text-sm font-normal" />
               ) : null,
             ].filter(Boolean).map((item, index) => (
               <div key={index} className="flex items-center gap-2">
                 {index > 0 && <span className="text-muted-foreground/30 font-normal shrink-0">•</span>}
                 {item}
               </div>
             ))}
          </div>
        </div>
        <div className="text-right flex flex-col items-end shrink-0">
           <div className="flex items-end justify-end gap-2">
             {scoreHistory.length >= 3 && (
               <div className="mb-1">
                 <Sparkline 
                   data={scoreHistory} 
                   color={scoreHistory[scoreHistory.length - 1] > scoreHistory[0] ? "#22c55e" : scoreHistory[scoreHistory.length - 1] < scoreHistory[0] ? "#ef4444" : "#a3a3a3"} 
                   className="w-12 h-4 opacity-80"
                 />
               </div>
             )}
             <div className="flex items-end gap-1">
               <span className={cn("text-2xl @[22rem]:text-3xl @[30rem]:text-4xl font-normal font-mono leading-none tracking-tighter", (forecast?.compositeScore ?? 0) > 70 ? "text-bull" : (forecast?.compositeScore ?? 100) < 40 ? "text-bear" : "text-foreground")}>
                 {forecast?.compositeScore ? fmtNum(forecast.compositeScore, 0) : "—"}
               </span>
               <span className="text-sm @[30rem]:text-lg font-normal text-neutral-600 mb-0.5">/100</span>
             </div>
           </div>
           <Tooltip content="Mimir's proprietary score based on trend strength, momentum, volume profiles, and ML models. >70 is bullish, <40 is bearish." align="end">
              <div className="text-[10px] font-normal uppercase tracking-widest text-muted-foreground mt-1 whitespace-nowrap border-b border-dotted border-muted-foreground/40 cursor-help">Composite Score</div>
            </Tooltip>
            <div className="flex-1 overflow-y-auto pr-1 pb-4">
            {forecast?.components && Object.keys(forecast.components).length > 0 && (
              <div className="w-full flex h-1.5 rounded-full overflow-hidden mt-2 opacity-90 gap-[1px]">
                {Object.entries(forecast.components).map(([k, v]) => {
                   // Render every non-zero component. Negative contributions
                   // (e.g. micro_structure_ofi, fii_dii_divergence, macro_penalty)
                   // are subtracted from the composite too, so dropping them made
                   // the colored bar disagree with the /100 headline. Any negative
                   // value is drawn in red to signal it detracts from the score.
                   if (v === 0) return null;
                   const colors: Record<string, string> = { trend_alignment: "bg-blue-500", forecast_momentum: "bg-purple-500", confidence: "bg-emerald-500", sentiment: "bg-amber-500", macro_penalty: "bg-red-500" };
                   const barColor = v < 0 ? "bg-red-500" : (colors[k] || "bg-neutral-500");
                   const total = 100; // max possible score before penalty
                   return (
                     <Tooltip key={k} content={`${k.replace('_', ' ').toUpperCase()}: ${v}`}>
                       <div className={`${barColor} h-full`} style={{ width: `${(Math.abs(v) / total) * 100}%` }} />
                     </Tooltip>
                   );
                })}
              </div>
             )}
         </div>
       </div>
      </motion.div>

      <motion.div 
        key={selectedSymbol} 
        initial="hidden" 
        animate="visible" 
        variants={{
          hidden: { opacity: 0, y: 6 },
          visible: {
            opacity: 1,
            y: 0,
            transition: { type: "spring", stiffness: 450, damping: 34, staggerChildren: 0.04, delayChildren: 0.02 }
          }
        }}
        className="flex-1 flex flex-col min-h-0 overflow-y-auto overflow-x-hidden custom-scrollbar pt-0.5 justify-start pb-2"
      >
        
        {/* ROW 2: Primary Signal Details */}
      <motion.div variants={{ hidden: { opacity: 0, y: 6 }, visible: { opacity: 1, y: 0, transition: { type: "spring", stiffness: 500, damping: 32 } } }} className="grid grid-cols-3 gap-x-3 gap-y-2.5 py-2.5 shrink-0">
          <TerminalStat label="LTP" value={<LivePrice symbol={selectedSymbol} decimals={2} fallback={insights?.indicators?.close} />} xl />
          
          <TerminalStat 
            label={(() => {
              if (selectedSignal || monitoring?.entryPrice) return "ENTRY";
              if (scan?.provisional_trigger) return "TRIGGER";
              if (indicators?.vwap) return "VWAP (REF)";
              if (indicators?.ema20) return "EMA20 (REF)";
              return "TRIGGER";
            })()} 
            value={(() => {
              const active = selectedSignal?.entryPrice || monitoring?.entryPrice;
              if (active) return fmtNum(active);
              if (scan?.provisional_trigger) {
                return (
                  <span className="opacity-50 border-b border-dotted border-current pb-[1px]">
                    {fmtNum(scan.provisional_trigger)}
                  </span>
                );
              }
              const refLevel = indicators?.vwap || indicators?.ema20;
              if (refLevel) {
                return (
                  <span className="opacity-80 font-mono">
                    {fmtNum(refLevel)}
                  </span>
                );
              }
              return "—";
            })()} 
            xl 
          />
          
          <DeviationStat
            symbol={selectedSymbol}
            monitoring={monitoring}
            selectedSignal={selectedSignal}
            scan={scan}
            indicators={indicators}
          />

          {selectedSignal && (
            <>
              <TerminalStat label="STOP LOSS" value={fmtNum(selectedSignal.stopLoss)} xl color="text-bear" />
              <TerminalStat label="TARGET" value={fmtNum(selectedSignal.target1)} xl color="text-bull" />
              <TerminalStat label="RISK/REWARD" value={`${fmtNum(selectedSignal.riskReward, 1)}x`} xl />
              {selectedSignal.expectedHoldMinutes != null && (
                <TerminalStat
                  label="EXP. HOLD"
                  value={
                    selectedSignal.expectedHoldMinutes >= 390
                      ? `~${Math.round(selectedSignal.expectedHoldMinutes / 390)}d`
                      : selectedSignal.expectedHoldMinutes >= 60
                        ? `~${Math.floor(selectedSignal.expectedHoldMinutes / 60)}h`
                        : `~${selectedSignal.expectedHoldMinutes}m`
                  }
                  xl
                />
              )}
              {selectedSignal.setupStats && (
                <TerminalStat
                  label={`HIT RATE (n=${selectedSignal.setupStats.samples})`}
                  value={`${selectedSignal.setupStats.winRate}%`}
                  xl
                  color={selectedSignal.setupStats.winRate >= 60 ? "text-bull" : selectedSignal.setupStats.winRate >= 45 ? "text-amber-500" : "text-bear"}
                />
              )}
            </>
          )}
        </motion.div>

        {/* ROW 3: Dense Technical Matrix (Checklist + AI Factors) */}
        <motion.div layout transition={SPRING_STANDARD} variants={{ hidden: { opacity: 0, y: 10, scale: 0.99 }, visible: { opacity: 1, y: 0, scale: 1, transition: { type: "spring", stiffness: 380, damping: 28 } } }} className="py-1 shrink-0 flex flex-col">
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
              <motion.div layout transition={SPRING_STANDARD} key="grid" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }} className="flex flex-col gap-1.5 w-full">
                 <div className="grid grid-cols-[minmax(0,1.08fr)_minmax(0,0.92fr)] gap-x-2 gap-y-1 w-full">
                   {/* Column A: Technicals */}
                   <div className="flex flex-col gap-1 min-w-0">
                      <div className="text-[10px] font-normal uppercase tracking-widest text-neutral-500 mb-0.5 flex items-center gap-1.5"><BarChart3 className="h-3.5 w-3.5 shrink-0" /> Technical Matrix</div>
                       <ul className="flex flex-col gap-1 text-[10.5px] font-mono min-w-0">
                         <MatrixRow onClick={() => setSelectedMetric("primaryTrend")} label="Primary Trend" tooltip="The overarching higher timeframe trend of the asset." value={(() => {
                            const unifiedTrend = (forecast?.trend || indicators?.trend || selectedSignal?.direction || "NEUTRAL").toString().toLowerCase();
                            if (unifiedTrend.includes("bull") || unifiedTrend === "up" || unifiedTrend === "buy") return "BULLISH";
                            if (unifiedTrend.includes("bear") || unifiedTrend === "down" || unifiedTrend === "sell") return "BEARISH";
                            return "SIDEWAYS";
                          })()} color={(() => {
                            const unifiedTrend = (forecast?.trend || indicators?.trend || selectedSignal?.direction || "NEUTRAL").toString().toLowerCase();
                            if (unifiedTrend.includes("bull") || unifiedTrend === "up" || unifiedTrend === "buy") return "text-bull";
                            if (unifiedTrend.includes("bear") || unifiedTrend === "down" || unifiedTrend === "sell") return "text-bear";
                            return "text-yellow-500";
                          })()} />
                         <MatrixRow onClick={() => setSelectedMetric("liquidityStatus")} label="Liquidity Status" tooltip="Detects if a major stop-hunt or liquidity sweep has just occurred." value={selectedSignal?.setupType === "LIQUIDITY_SWEEP" ? <span className="text-purple-400 font-normal">SWEEP RECOVERY</span> : "STANDARD"} color={selectedSignal?.setupType === "LIQUIDITY_SWEEP" ? "text-purple-400" : "text-neutral-400"} />
                         <MatrixRow onClick={() => setSelectedMetric("rsiMomentum")} label="RSI Momentum" tooltip="Relative Strength Index showing overbought/oversold conditions." value={
                           <div className="flex items-center">
                             {(() => {
                               // eslint-disable-next-line @typescript-eslint/no-explicit-any
                               const r = indicators?.rsi14 ?? (selectedSignal as any)?.indicators?.rsi ?? (forecast as any)?.rsi;
                               if (r == null) return "—";
                               return (
                                 <>
                                   {`${fmtNum(r, 0)} (${r >= 70 ? "OB" : r <= 30 ? "OS" : r >= 50 ? "BULL" : "BEAR"})`}
                                   <InlineGauge pct={r} color={r >= 50 ? "bg-bull" : "bg-bear"} />
                                 </>
                               );
                             })()}
                           </div>
                         } color={(() => {
                           // eslint-disable-next-line @typescript-eslint/no-explicit-any
                           const r = indicators?.rsi14 ?? (selectedSignal as any)?.indicators?.rsi ?? (forecast as any)?.rsi;
                           if (r == null) return "text-neutral-500";
                           return r >= 50 ? "text-bull" : "text-bear";
                         })()} />
                         <MatrixRow onClick={() => setSelectedMetric("volumeSurge")} label="Volume Surge" tooltip="Current volume compared to the 20-period moving average." value={(() => {
                           // eslint-disable-next-line @typescript-eslint/no-explicit-any
                           const v = indicators?.volumeRatio ?? (selectedSignal as any)?.indicators?.volumeRatio ?? (forecast as any)?.volumeRatio;
                           if (v == null) return "—";
                           return `${fmtNum(v, 1)}x`;
                         })()} color={(() => {
                           // eslint-disable-next-line @typescript-eslint/no-explicit-any
                           const v = indicators?.volumeRatio ?? (selectedSignal as any)?.indicators?.volumeRatio ?? (forecast as any)?.volumeRatio;
                           return v == null ? "text-neutral-500" : "text-bull";
                         })()} />
                         <VwapSupportRow
                           symbol={selectedSymbol}
                           monitoring={monitoring}
                           indicators={indicators}
                           forecast={forecast}
                           onClick={() => setSelectedMetric("vwapSupport")}
                         />
                         <MatrixRow onClick={() => setSelectedMetric("emaDistance")} label="EMA 9 / 20" tooltip="Exponential Moving Averages used to determine short-term momentum." value={(() => {
                           const e9 = indicators?.ema9;
                           const e20 = indicators?.ema20;
                           if (e9 == null && e20 == null) return "—";
                           return `${e9 != null ? fmtNum(e9, 0) : "—"} / ${e20 != null ? fmtNum(e20, 0) : "—"}`;
                         })()} color="text-foreground" />
                      </ul>
                   </div>
                   
                   {/* Column B: AI Factors */}
                   <div className="flex flex-col gap-1 min-w-0">
                      <div className="text-[10px] font-normal uppercase tracking-widest text-neutral-500 mb-0.5 flex items-center gap-1.5"><Cpu className="h-3.5 w-3.5 shrink-0" /> AI Alpha Factors</div>
                      <ul className="flex flex-col gap-1 text-[10.5px] font-mono min-w-0">
                         <MatrixRow onClick={() => setSelectedMetric("techEdge")} label="Tech Edge" tooltip="Algorithmic scoring of technical momentum and indicator alignment." value={
                           <div className="flex items-center">
                             {(() => {
                               const te = techEdgeVal;
                               if (te == null) return "—";
                               return (
                                 <>
                                   {`${te}%`}
                                   <InlineGauge pct={te} color="bg-bull" />
                                 </>
                               );
                             })()}
                           </div>
                         } color="text-bull/80" />
                         <MatrixRow onClick={() => setSelectedMetric("regimeAlign")} label="Regime Align" tooltip="Checks if the signal aligns with the broader Market Regime." value={
                           <div className="flex items-center">
                             {(() => {
                               const ra = regimeAlignVal;
                               if (ra == null) return "—";
                               return (
                                 <>
                                   {`${ra}%`}
                                   <InlineGauge pct={ra} color="bg-bull" />
                                 </>
                               );
                             })()}
                           </div>
                         } color="text-bull/80" />
                         <MatrixRow onClick={() => setSelectedMetric("aiForecast")} label="AI Forecast" tooltip="Chronos directional forecast return." value={(() => {
                           const fReturn = forecast?.forecastReturnPct ?? 0;
                           return fReturn !== 0 ? fmtPct(fReturn) : "—";
                         })()} color={forecast?.forecastReturnPct && forecast.forecastReturnPct > 0 ? "text-bull" : forecast?.forecastReturnPct && forecast.forecastReturnPct < 0 ? "text-bear" : "text-neutral-500"} />
                      </ul>
                    </div>
                 </div>

                 {/* Full-Width Rows for Long Metrics (MTF Confluence & Price Pattern) */}
                  <div className="flex flex-col gap-1 pt-1 w-full text-[10.5px] font-mono">
                    <MatrixRow onClick={() => setSelectedMetric("mtfConfluence")} label="MTF Confluence" tooltip="Multi-timeframe score assessing alignment across multiple charts (15m, 1h, 1d)." value={
                     (() => {
                        // Backend may attach mtf fields to suggestions at runtime; they are not part of the Suggestion schema
                        const sigMtf = selectedSignal as (Suggestion & { mtfScore?: number; mtfTotal?: number; mtfConfluenceScore?: number }) | null;
                        const rawS = scan?.mtfScore ?? sigMtf?.mtfScore ?? mtf_score ?? 0;
                        const rawT = scan?.mtfTotal ?? sigMtf?.mtfTotal ?? mtf_total ?? 0;
                        const s = rawS;
                        const t = rawT > 0 ? rawT : (rawS > 0 ? 3 : (scan ? (scan.mtfTotal || 3) : 3));
                        const conf = scan?.mtfConfluenceScore ?? sigMtf?.mtfConfluenceScore ?? (s === 0 ? -1 : 1);
                        const isNoData = (t === 0 && s === 0) || (scan === null && !selectedSignal && !mtf_score);
                        const isZeroConf = !isNoData && s === 0;
                        const isPartial = !isNoData && s > 0 && s < t;
                        const isStrong = !isNoData && s === t && t > 0;

                        let label = "DIVERGING TIMEFRAMES";
                        let style = "text-bear";

                        if (isNoData) {
                          label = "NO MTF DATA AVAILABLE";
                          style = "text-neutral-400";
                        } else if (isZeroConf || conf < 0) {
                          label = `NO ALIGNMENT (${s}/${t})`;
                          style = "text-bear";
                        } else if (isPartial || conf === 0) {
                          label = "PARTIAL ALIGNMENT";
                          style = "text-yellow-500";
                        } else if (isStrong || conf > 0) {
                          label = "STRONG ALIGNMENT (15M, 1H, 1D)";
                          style = "text-bull";
                        }

                        return (
                          <span className={cn("flex items-center gap-1.5 min-w-0 font-normal break-words", style)}>
                            <span>{isNoData ? "—" : `${s}/${t}`} {label}</span>
                          </span>
                        );
                      })()
                   } color="text-foreground" />
                   <MatrixRow onClick={() => setSelectedMetric("pricePattern")} label="Price Pattern" tooltip="Specific candlestick or structural patterns identified on the chart." value={
                     forecast?.technicalPatterns && forecast.technicalPatterns.length > 0 ? (
                       <span className="flex items-center gap-1.5 text-orange-500 min-w-0 font-normal break-words">
                         <Flame className="h-3 w-3 shrink-0" />
                         <span>{forecast.technicalPatterns[0].replace(/_/g, " ")}</span>
                       </span>
                     ) : (selectedSignal?.setupType || scan?.setupType) && (selectedSignal?.setupType || scan?.setupType) !== "LIQUIDITY_SWEEP" ? (
                       <span className="flex items-center gap-1.5 text-orange-500 min-w-0 font-normal break-words">
                         <Flame className="h-3 w-3 shrink-0" />
                         <span>{(selectedSignal?.setupType || scan?.setupType || "").replace(/_/g, " ")}</span>
                       </span>
                     ) : scan?.condition ? (
                       <span className="text-foreground/80 font-normal break-words">{scan.condition}</span>
                     ) : "NONE"
                   } color={(forecast?.technicalPatterns && forecast.technicalPatterns.length > 0) || ((selectedSignal?.setupType || scan?.setupType) && (selectedSignal?.setupType || scan?.setupType) !== "LIQUIDITY_SWEEP") ? "text-orange-500" : "text-neutral-500"} />
                   <MatrixRow onClick={() => setSelectedMetric("modelSource")} label="Analysis Source" tooltip="Whether this is real model output or a heuristic fallback engine." value={(() => {
                     return forecast?.isFallback ? "HEURISTIC FALLBACK" : "AI MODEL";
                   })()} color={forecast?.isFallback ? "text-yellow-500" : "text-bull"} />
                 </div>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>

        {/* ROW 4 deleted as requested */}
        {/* ROW 5: Confidence Evolution */}
        {scoreHistory.length >= 2 && (
          <motion.div transition={SPRING_STANDARD} variants={{ hidden: { opacity: 0, y: 10 }, visible: { opacity: 1, y: 0 } }} className="mt-3 pt-3 shrink-0 flex flex-col min-h-0">
            <div className="text-xs font-normal uppercase tracking-widest text-neutral-500 mb-2 shrink-0 flex items-center justify-between">
               <span>Confidence Evolution</span>
               {(() => {
                 const currentScore = scoreHistory[scoreHistory.length - 1];
                 const startScore = scoreHistory[0];
                 const diff = currentScore - startScore;
                 return (
                   <span className={cn("text-[9px] font-mono font-normal tabular-nums", diff > 0 ? "text-bull" : diff < 0 ? "text-bear" : "text-neutral-500")}>
                      {diff > 0 ? "+" : ""}{fmtNum(diff, 0)} PTS
                   </span>
                 );
               })()}
            </div>
            <div className="w-full h-[40px] opacity-90 relative flex items-center justify-center">
               {(() => {
                 const displayData = scoreHistory;
                 const startScore = displayData[0];
                 const endScore = displayData[displayData.length - 1];
                 return (
                   <Sparkline 
                     data={displayData} 
                     color={endScore > startScore ? "#22c55e" : endScore < startScore ? "#ef4444" : "#a3a3a3"} 
                     className="w-full h-full opacity-70"
                   />
                 );
               })()}
            </div>
          </motion.div>
        )}

        {/* ROW 6: Support & Resistance */}
        <div className="mt-2 pt-2 border-t border-border/10 shrink-0 flex flex-col min-h-0 flex-1">
           <SupportResistancePanel selectedSymbol={selectedSymbol} />
        </div>

      </motion.div>
    </motion.div>
  );
});

// Subscribes to live ticks itself so per-tick renders touch only this stat row,
// not the whole panel.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function DeviationStat({ symbol, monitoring, selectedSignal, scan, indicators }: { symbol: string; monitoring: any; selectedSignal: Suggestion | null; scan: any; indicators: any }) {
  const ltp = useSymbolDataSelector(symbol, (d) => d.ltp);
  const current = ltp ?? monitoring?.currentPrice ?? indicators?.close;
  const activeEntry = selectedSignal?.entryPrice || monitoring?.entryPrice;
  const trigger = activeEntry || scan?.provisional_trigger || indicators?.vwap || indicators?.ema20;
  const dev = trigger && current ? calcPnLPct(current, trigger) : null;
  return (
    <TerminalStat
      label="DEVIATION"
      value={(() => {
        if (dev != null) {
          const isProvisional = !activeEntry && scan?.provisional_trigger != null;
          const animatedEl = <AnimatedNumber value={dev} decimals={2} showSign={true} suffix="%" duration={0.3} flashColor={true} />;
          if (isProvisional) {
            return (
              <span className="opacity-50 border-b border-dotted border-current pb-[1px]">
                {animatedEl}
              </span>
            );
          }
          return animatedEl;
        }
        return "—";
      })()}
      xl
      color={dev != null ? (dev >= 0 ? "text-bull" : "text-bear") : "text-foreground"}
    />
  );
}

// Subscribes to live ticks itself (see DeviationStat). Shows "—" when neither
// VWAP nor EMA9 comparison is possible — never asserts structure from signal direction.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function VwapSupportRow({ symbol, monitoring, indicators, forecast, onClick }: { symbol: string; monitoring: any; indicators: any; forecast: any; onClick: () => void }) {
  const ltp = useSymbolDataSelector(symbol, (d) => d.ltp);
  const current = ltp ?? monitoring?.currentPrice ?? indicators?.close ?? 0;
  const vwapPrice = indicators?.vwap ?? forecast?.vwap;
  let value = "—";
  let color = "text-neutral-500";
  if (vwapPrice && current > 0) {
    value = current >= vwapPrice ? "> VWAP (HOLDING)" : "< VWAP (BROKEN)";
    color = current >= vwapPrice ? "text-bull/80" : "text-bear/80";
  } else if (current > 0 && indicators?.ema9) {
    value = current >= indicators.ema9 ? "> EMA9" : "< EMA9";
    color = current >= indicators.ema9 ? "text-bull/80" : "text-bear/80";
  }
  return <MatrixRow onClick={onClick} label="VWAP Support" tooltip="Checks if the price is holding above the Volume Weighted Average Price." value={value} color={color} />;
}

function DecryptText({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const prevTextRef = useRef<string>("");
  
  useEffect(() => {
    if (!text || !ref.current) return;
    // If text only changed numerically during live ticking (and same length/prefix), update smoothly without full cipher scramble
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
        if(index < iteration) return text[index];
        return chars[Math.floor(Math.random() * chars.length)];
      }).join("");
      if(iteration >= text.length) {
        clearInterval(interval);
        if (ref.current) ref.current.innerText = text;
      }
      iteration += 1 / 2;
    }, 20);
    return () => clearInterval(interval);
  }, [text]);
  
  return <span ref={ref}>{text}</span>;
}

function AutoFitText({ children, className }: { children: React.ReactNode, className?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const text = textRef.current;
    if (!container || !text) return;

    const resize = () => {
      const cw = container.clientWidth;
      const tw = text.scrollWidth;
      
      if (tw > cw && cw > 0) {
        // scale down slightly more than exact ratio to be safe
        const scale = Math.max(0.4, (cw / tw) * 0.95);
        text.style.transform = `scale(${scale})`;
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
    <div ref={containerRef} className={cn("w-full overflow-hidden flex items-center", className)}>
      <div ref={textRef} className="origin-left whitespace-nowrap inline-block">
        {children}
      </div>
    </div>
  );
}

function TerminalStat({ label, value, xl, color }: { label: string; value: React.ReactNode; xl?: boolean; color?: string }) {
  return (
    <div className="flex flex-col min-w-0">
      <span className="text-[10px] @[26rem]:text-[11px] font-normal font-sans uppercase tracking-widest text-muted-foreground mb-0.5 truncate whitespace-nowrap">{label}</span>
      {/* Fluid sizing: scale with the panel container so numbers stay readable on
          wide screens (no wasted space) and never overflow on narrow ones. AutoFitText
          is the final safety net that shrinks anything still too wide to fit. */}
      <AutoFitText className={cn(
        "font-normal font-mono tabular-nums tracking-tighter leading-none",
        xl
          ? "text-xl @[20rem]:text-2xl @[27rem]:text-3xl @[33rem]:text-4xl"
          : "text-lg @[20rem]:text-xl @[27rem]:text-2xl @[33rem]:text-3xl",
        color || "text-foreground"
      )}>
        {typeof value === "string" || typeof value === "number" ? <DecryptText text={String(value)} /> : value}
      </AutoFitText>
    </div>
  );
}

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
    case "liquidityStatus":
      title = "Liquidity Status";
      content = (
        <div className="flex flex-col gap-3 text-xs text-foreground/90">
          <p className="leading-relaxed text-muted-foreground text-[11px]">Analyzes recent price action to detect institutional stop hunts or liquidity sweeps. Smart money often engineers temporary breakouts to trigger retail stop-losses, absorbing their liquidity before reversing the price aggressively in the intended direction.</p>
          <div className="flex flex-col">
            <div className="flex justify-between items-center border-b border-border/10 py-1.5">
              <span className="text-muted-foreground">Setup Type</span>
              <span className="font-normal text-purple-400">{selectedSignal?.setupType || "STANDARD"}</span>
            </div>
          </div>
          <p className="text-[10px] text-muted-foreground leading-relaxed">A liquidity sweep often precedes a strong reversal in the opposite direction.</p>
        </div>
      );
      break;
    case "pricePattern":
      title = "Price Pattern";
      content = (
        <div className="flex flex-col gap-3 text-xs text-foreground/90">
          <p className="leading-relaxed text-muted-foreground text-[11px]">Technical Pattern Engine recognition scanning across 1D and 1H timeframes. It detects classical chart formations (like Head & Shoulders, Flags, Triangles) and complex candlestick structures to predict imminent volatility expansions.</p>
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
    case "modelSource":
      title = "Model Source";
      content = (
        <div className="flex flex-col gap-3 text-xs text-foreground/90">
          <p className="leading-relaxed text-muted-foreground text-[11px]">Indicates which intelligence engine handled the inference for this asset. The primary neural network cluster processes the request normally, while a heuristic-driven approximation is used as a fallback during missing inference data or timeout.</p>
          <div className="flex flex-col">
            <div className="flex justify-between items-center border-b border-border/10 py-1.5">
              <span className="text-muted-foreground">Engine Used</span>
              <span className="font-normal text-orange-500">{forecast?.isFallback ? "FALLBACK" : (forecast?.source ? forecast.source.toUpperCase().replace("NIFTY50GPT", "GPT-50") : "—")}</span>
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
      <div className="pr-1 pb-1">
        {content}
      </div>
    </div>
  );
}

function MatrixRow({ label, value, color, tooltip, onClick, className }: { label: string; value: React.ReactNode; color: string; tooltip?: string; onClick?: () => void; className?: string }) {
  // Label and value share one size (text-[11px]); hierarchy comes from weight
  // and color, never size — so a bold amber status can't read larger than a
  // neutral value in the same row.
  const content = (
    <motion.li onClick={onClick} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={FADE_STANDARD} className={cn("flex justify-between items-center group gap-1.5 py-1 min-w-0 text-[11px] overflow-hidden", onClick ? "cursor-pointer" : "cursor-default", className)}>
      <span className={cn("text-muted-foreground font-normal transition-colors shrink rounded py-0.5 px-1 -ml-1 truncate whitespace-nowrap", onClick ? "group-hover:bg-white/5 group-hover:text-foreground apple-hover" : "group-hover:text-foreground")}>{label}</span>
      <span className={cn("font-normal flex items-center justify-end text-right shrink-0 tabular-nums whitespace-nowrap", color)}>
        {typeof value === 'string' || typeof value === 'number' ? <DecryptText text={String(value)} /> : value}
      </span>
    </motion.li>
  );
  
  if (tooltip && !onClick) {
    return (
      <Tooltip content={tooltip} side="left" className="w-full">
        {content}
      </Tooltip>
    );
  }
  return content;
}

function InlineGauge({ pct, color }: { pct: number; color: string }) {
  return (
    <div className="w-8 h-1.5 bg-secondary rounded-full overflow-hidden ml-1.5 flex-shrink-0 border-0/50">
      <motion.div 
        initial={{ width: 0 }}
        animate={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
        transition={{ duration: 1, ease: "easeOut" }}
        className={cn("h-full rounded-full shadow-[0_0_10px_rgba(255,255,255,0.2)]", color)} 
      />
    </div>
  );
}
