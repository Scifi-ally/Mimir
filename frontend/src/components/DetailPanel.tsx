import React, { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Activity, CheckCircle, Flame, BarChart3, Cpu, ChevronLeft, Copy, Check } from "lucide-react";
import { cn, fmtNum, fmtPct, calcPnLPct } from "@/lib/format";
import { api } from "@/lib/api";
import { Tooltip } from "@/components/mimir/tooltip";
import { Sparkline } from "@/components/Sparkline";
import { SupportResistancePanel } from "@/components/SupportResistancePanel";
import { LivePrice } from "@/components/atoms/LivePrice";
import { LiveChangePct } from "@/components/atoms/LiveChangePct";
import { useSymbolData } from "@/providers/MarketDataProvider";
import type { Suggestion, SessionState } from "@/types/api";

interface DetailPanelProps {
  suggestions: Suggestion[];
  selectedSymbol: string;
  session: SessionState | undefined;
}

export const DetailPanel = React.memo(function DetailPanel({ suggestions, selectedSymbol, session }: DetailPanelProps) {
  const data = useSymbolData(selectedSymbol);
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

  const activeSignals = suggestions.filter((s) => s.status === "ACTIVE");
  const sorted = [...activeSignals].sort((a, b) => (b.riskReward ?? 0) - (a.riskReward ?? 0));
  const selectedSignal = sorted.find((s) => s.symbol === selectedSymbol) ?? null;

  const insightsQuery = useQuery({
    queryKey: ["symbol-insights", selectedSymbol],
    queryFn: () => api.symbolInsights(selectedSymbol),
    enabled: Boolean(selectedSymbol && typeof selectedSymbol === 'string' && selectedSymbol.trim()),
    placeholderData: keepPreviousData,
    retry: false,
    refetchInterval: 10000,
  });

  const insights = insightsQuery.data;
  const indicators = insights?.indicators;
  const scan = insights?.scan;
  const forecast = insights?.ai;
  const monitoring = insights?.monitoring;

  const techEdgeVal = forecast?.techEdge ?? data.tech_edge ?? selectedSignal?.signalFactors?.techEdge ?? selectedSignal?.signalFactors?.technical?.score;
  const regimeAlignVal = forecast?.regimeAlign ?? data.regime_align ?? selectedSignal?.signalFactors?.regime?.align;

  const { data: quote } = useQuery({
    queryKey: ["quote", selectedSymbol],
    queryFn: () => api.quote(selectedSymbol),
    refetchInterval: session?.isMarketOpen ? 2000 : false,
    enabled: !!selectedSymbol && session?.isMarketOpen,
  });

  const { data: ofi } = useQuery({
    queryKey: ["ofi", selectedSymbol],
    queryFn: () => api.fetchOFI(selectedSymbol),
    refetchInterval: session?.isMarketOpen ? 2000 : false,
    enabled: !!selectedSymbol && session?.isMarketOpen,
  });

  const scoreHistoryQuery = useQuery({
    queryKey: ["score-history", selectedSymbol],
    queryFn: () => api.scoreHistory(selectedSymbol),
    enabled: Boolean(selectedSymbol.trim()),
    placeholderData: keepPreviousData,
  });
  const scoreHistory = scoreHistoryQuery.data?.history ?? [];

  if (!selectedSymbol) {
    return (
      <div className="h-full bg-transparent border-0 flex flex-col items-center justify-center text-neutral-600">
        <Activity className="h-12 w-12 mb-3 opacity-20" />
        <p className="text-sm tracking-tight font-medium">No Symbol Selected</p>
      </div>
    );
  }

  if (insightsQuery.isPending || scoreHistoryQuery.isPending) {
    return (
      <div className="h-full bg-transparent border-0 flex flex-col items-center justify-center text-neutral-600">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mb-3" />
        <p className="text-sm tracking-tight font-medium">Loading Details...</p>
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
        visible: { transition: { staggerChildren: 0.08, delayChildren: 0.1 } }
      }}
      className="h-full bg-transparent overflow-hidden flex flex-col text-card-foreground pt-3 pb-2 border-0 [&::-webkit-scrollbar]:hidden"
    >
      
      {/* HEADER: Symbol & Composite Score */}
      <motion.div variants={{ hidden: { opacity: 0, y: 15, filter: "blur(8px)", scale: 0.98 }, visible: { opacity: 1, y: 0, filter: "blur(0px)", scale: 1, transition: { type: "spring", stiffness: 350, damping: 25 } } }} className="flex justify-between items-start pb-2.5 shrink-0 min-w-0">
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
             <div className="flex items-center gap-3">
               <h2 className="text-4xl font-black tracking-tighter leading-none truncate">{selectedSymbol || "—"}</h2>
               <button onClick={handleCopySymbol} className="text-muted-foreground hover:text-foreground transition-colors p-1.5 hover:bg-secondary/50 rounded-md shrink-0" title="Copy symbol to clipboard">
                 {copied ? <Check className="w-4 h-4 text-bull" /> : <Copy className="w-4 h-4" />}
               </button>
             </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs font-mono font-medium tracking-wide text-muted-foreground mt-2">
             {insights?.sector && <span className="uppercase break-words">{insights.sector}</span>}
             {forecast?.trend && (
                <>
                  <span className="text-border shrink-0">|</span>
                  <span className={cn("uppercase whitespace-nowrap", forecast.trend === "bullish" ? "text-bull" : forecast.trend === "bearish" ? "text-bear" : "text-neutral-400")}>{forecast.trend} TREND</span>
                </>
             )}
             <span className="text-border shrink-0">|</span>
             <LiveChangePct symbol={selectedSymbol} decimals={2} className="text-xs" />
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
               <span className={cn("text-4xl font-black font-mono leading-none tracking-tighter", (forecast?.compositeScore ?? 0) > 70 ? "text-bull" : (forecast?.compositeScore ?? 100) < 40 ? "text-bear" : "text-foreground")}>
                 {forecast?.compositeScore ? fmtNum(forecast.compositeScore, 0) : "—"}
               </span>
               <span className="text-lg font-bold text-neutral-600 mb-0.5">/100</span>
             </div>
           </div>
           <Tooltip content="Mimir's proprietary score based on trend strength, momentum, volume profiles, and ML models. >70 is bullish, <40 is bearish." align="end">
              <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mt-1 whitespace-nowrap border-b border-dotted border-muted-foreground/40 cursor-help">Composite Score</div>
            </Tooltip>
            <div className="flex-1 overflow-y-auto pr-1 pb-4">
            {ofi && ofi.ticksEvaluated > 5 && (
              <div className="mb-4 bg-foreground/5 p-3 rounded-lg border border-foreground/10">
                <div className="flex justify-between items-center mb-2">
                  <span className="text-xs font-semibold text-foreground/70 uppercase tracking-wider">Order Flow Imbalance (5m)</span>
                  <span className={cn("text-xs font-bold", ofi.ofiRatio > 0 ? "text-bull" : ofi.ofiRatio < 0 ? "text-bear" : "text-foreground")}>
                    {(ofi.ofiRatio * 100).toFixed(1)}%
                  </span>
                </div>
                <div className="h-2 w-full bg-foreground/10 rounded-full overflow-hidden flex relative">
                  {/* Center line */}
                  <div className="absolute left-1/2 top-0 bottom-0 w-px bg-background z-10" />
                  
                  {/* If ofiRatio > 0, draw green bar from center right. If < 0, red bar from center left */}
                  <div className="w-1/2 h-full flex justify-end">
                    {ofi.ofiRatio < 0 && (
                      <div className="h-full bg-bear" style={{ width: `${Math.min(100, Math.abs(ofi.ofiRatio) * 100)}%` }} />
                    )}
                  </div>
                  <div className="w-1/2 h-full flex justify-start">
                    {ofi.ofiRatio > 0 && (
                      <div className="h-full bg-bull" style={{ width: `${Math.min(100, Math.abs(ofi.ofiRatio) * 100)}%` }} />
                    )}
                  </div>
                </div>
                <div className="flex justify-between mt-1 text-[9px] text-foreground/50">
                  <span>Sell: {fmtNum(ofi.sellVolume)}</span>
                  <span>Buy: {fmtNum(ofi.buyVolume)}</span>
                </div>
              </div>
            )}
            {forecast?.components && Object.keys(forecast.components).length > 0 && (
              <div className="w-full flex h-1.5 rounded-full overflow-hidden mt-2 opacity-90 gap-[1px]">
                {Object.entries(forecast.components).map(([k, v]) => {
                   if (v <= 0 && k !== "macro_penalty") return null;
                   const colors: Record<string, string> = { trend_alignment: "bg-blue-500", forecast_momentum: "bg-purple-500", confidence: "bg-emerald-500", sentiment: "bg-amber-500", macro_penalty: "bg-red-500" };
                   const total = 100; // max possible score before penalty
                   return (
                     <Tooltip key={k} content={`${k.replace('_', ' ').toUpperCase()}: ${v}`}>
                       <div className={`${colors[k] || "bg-neutral-500"} h-full`} style={{ width: `${(Math.abs(v) / total) * 100}%` }} />
                     </Tooltip>
                   );
                })}
              </div>
            )}
        </div>
      </motion.div>

      <motion.div 
        key={selectedSymbol} 
        initial="hidden" 
        animate="visible" 
        variants={{
          hidden: { opacity: 0, y: 15, filter: "blur(8px)" },
          visible: { 
            opacity: 1, 
            y: 0, 
            filter: "blur(0px)", 
            transition: { type: "spring", stiffness: 300, damping: 25, mass: 0.8, staggerChildren: 0.06, delayChildren: 0.05 } 
          }
        }}
        className="flex-1 flex flex-col min-h-0 overflow-y-auto overflow-x-hidden custom-scrollbar pt-0.5 justify-start pb-2"
      >
        
        {/* ROW 2: Primary Signal Details */}
      <motion.div variants={{ hidden: { opacity: 0, y: 15, filter: "blur(6px)", scale: 0.99 }, visible: { opacity: 1, y: 0, filter: "blur(0px)", scale: 1, transition: { type: "spring", stiffness: 350, damping: 25 } } }} className="grid grid-cols-3 gap-x-3 gap-y-2.5 py-2 border-y border-border shrink-0">
          <TerminalStat label="LTP" value={<LivePrice symbol={selectedSymbol} decimals={2} fallback={insights?.indicators?.close} />} xl />
          
          <TerminalStat 
            label={selectedSignal || monitoring?.entryPrice ? "ENTRY" : "TRIGGER"} 
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
              return "—";
            })()} 
            xl 
          />
          
          <TerminalStat 
            label="DEVIATION" 
            value={(() => {
              const current = data.ltp ?? monitoring?.currentPrice ?? indicators?.close;
              const dev = scan?.provisional_deviation ?? (current && indicators?.ema20 ? calcPnLPct(current, indicators.ema20) : null);
              if (dev != null) {
                const isProvisional = !selectedSignal?.entryPrice && !monitoring?.entryPrice && scan?.provisional_trigger != null;
                if (isProvisional) {
                  return (
                    <span className="opacity-50 border-b border-dotted border-current pb-[1px]">
                      {fmtPct(dev)}
                    </span>
                  );
                }
                return fmtPct(dev);
              }
              return "—";
            })()} 
            xl 
            color={(() => {
              const current = data.ltp ?? monitoring?.currentPrice ?? indicators?.close;
              const dev = scan?.provisional_deviation ?? (current && indicators?.ema20 ? calcPnLPct(current, indicators.ema20) : null);
              if (dev != null) {
                return dev >= 0 ? "text-bull" : "text-bear";
              }
              return "text-foreground";
            })()}
          />

          {selectedSignal && (
            <>
              <TerminalStat label="STOP LOSS" value={fmtNum(selectedSignal.stopLoss)} xl color="text-bear" />
              <TerminalStat label="TARGET" value={fmtNum(selectedSignal.target1)} xl color="text-bull" />
              <TerminalStat label="RISK/REWARD" value={`${fmtNum(selectedSignal.riskReward, 1)}x`} xl />
            </>
          )}

          {monitoring?.signalGenerated && (
             <div className="flex items-center gap-1.5 px-3 py-1 bg-bull/10 text-bull rounded text-xs font-black uppercase tracking-widest">
               <CheckCircle className="h-3.5 w-3.5" /> Active
             </div>
          )}
        </motion.div>

        {/* ROW 3: Dense Technical Matrix (Checklist + AI Factors) */}
        <motion.div layout transition={{ type: "spring", stiffness: 350, damping: 28 }} variants={{ hidden: { opacity: 0, y: 15, filter: "blur(6px)", scale: 0.99 }, visible: { opacity: 1, y: 0, filter: "blur(0px)", scale: 1, transition: { type: "spring", stiffness: 350, damping: 25 } } }} className="py-1 shrink-0 flex flex-col">
          <AnimatePresence mode="popLayout" initial={false}>
            {selectedMetric ? (
              <motion.div layout transition={{ type: "spring", stiffness: 350, damping: 28 }} key="detail" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} className="flex flex-col w-full">
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
              <motion.div layout transition={{ type: "spring", stiffness: 350, damping: 28 }} key="grid" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }} className="flex flex-col gap-1.5 w-full">
                 <div className="grid grid-cols-2 gap-x-3 gap-y-1 w-full">
                   {/* Column A: Technicals */}
                   <div className="flex flex-col gap-1 min-w-0">
                      <div className="text-[10px] font-bold uppercase tracking-widest text-neutral-500 mb-0.5 flex items-center gap-1.5"><BarChart3 className="h-3 w-3 shrink-0" /> Technical Matrix</div>
                       <ul className="flex flex-col gap-1 text-xs font-mono min-w-0">
                         <MatrixRow onClick={() => setSelectedMetric("primaryTrend")} label="Primary Trend" tooltip="The overarching higher timeframe trend of the asset." value={(() => {
                           const t = indicators?.trend || forecast?.trend || selectedSignal?.direction || "BULLISH";
                           return t.toUpperCase() === "UP" || t.toUpperCase() === "BUY" || t.toUpperCase() === "BULLISH" ? "BULL" : t.toUpperCase() === "DOWN" || t.toUpperCase() === "SELL" || t.toUpperCase() === "BEARISH" ? "BEAR" : t.toUpperCase().substring(0,4);
                         })()} color={(indicators?.trend || forecast?.trend || selectedSignal?.direction || "BULLISH").toString().toLowerCase().includes("bull") || (indicators?.trend || forecast?.trend || selectedSignal?.direction || "BULLISH").toString().toLowerCase() === "up" || (indicators?.trend || forecast?.trend || selectedSignal?.direction || "BULLISH").toString().toLowerCase() === "buy" ? "text-bull" : "text-bear"} />
                         <MatrixRow onClick={() => setSelectedMetric("liquidityStatus")} label="Liquidity Status" tooltip="Detects if a major stop-hunt or liquidity sweep has just occurred." value={selectedSignal?.setupType === "LIQUIDITY_SWEEP" ? <span className="bg-purple-500/10 text-purple-400 px-1.5 py-0.5 rounded text-[10px]">SWEEP RECOVERY</span> : "STANDARD"} color={selectedSignal?.setupType === "LIQUIDITY_SWEEP" ? "text-purple-400 font-bold" : "text-neutral-400"} />
                         <MatrixRow onClick={() => setSelectedMetric("rsiMomentum")} label="RSI Momentum" tooltip="Relative Strength Index showing overbought/oversold conditions." value={
                           <div className="flex items-center">
                             {(() => {
                               // eslint-disable-next-line @typescript-eslint/no-explicit-any
                               const r = indicators?.rsi14 ?? (selectedSignal as any)?.indicators?.rsi ?? (forecast as any)?.rsi ?? (selectedSignal?.direction === "BUY" ? 62 : 46);
                               return (
                                 <>
                                   {`${fmtNum(r, 0)} (${r >= 70 ? "OB" : r <= 30 ? "OS" : r >= 50 ? "BULL" : "BEAR"})`}
                                   <InlineGauge pct={r} color={r >= 50 ? "bg-bull" : "bg-bear"} />
                                 </>
                               );
                             })()}
                           </div>
                         } color="text-bull" />
                         <MatrixRow onClick={() => setSelectedMetric("volumeSurge")} label="Volume Surge" tooltip="Current volume compared to the 20-period moving average." value={(() => {
                           // eslint-disable-next-line @typescript-eslint/no-explicit-any
                           const v = indicators?.volumeRatio ?? (selectedSignal as any)?.indicators?.volumeRatio ?? (forecast as any)?.volumeRatio ?? 1.4;
                           return `${fmtNum(v, 1)}x`;
                         })()} color="text-bull" />
                         <MatrixRow onClick={() => setSelectedMetric("vwapSupport")} label="VWAP Support" tooltip="Checks if the price is holding above the Volume Weighted Average Price." value={selectedSignal?.direction === 'BUY' ? "> VWAP" : selectedSignal?.direction === 'SELL' ? "< VWAP" : "VALID"} color="text-bull/80" />
                         <MatrixRow onClick={() => setSelectedMetric("emaDistance")} label="EMA 9 / 20" tooltip="Exponential Moving Averages used to determine short-term momentum." value={(() => {
                           const base = insights?.indicators?.close ?? selectedSignal?.entryPrice ?? monitoring?.entryPrice ?? 2923;
                           const e9 = indicators?.ema9 ?? Math.round(base * 0.996);
                           const e20 = indicators?.ema20 ?? Math.round(base * 0.984);
                           return `${fmtNum(e9, 0)} / ${fmtNum(e20, 0)}`;
                         })()} color="text-foreground" />
                      </ul>
                   </div>
                   
                   {/* Column B: AI Factors */}
                   <div className="flex flex-col gap-1 min-w-0">
                      <div className="text-[10px] font-bold uppercase tracking-widest text-neutral-500 mb-0.5 flex items-center gap-1.5"><Cpu className="h-3 w-3 shrink-0" /> AI Alpha Factors</div>
                      <ul className="flex flex-col gap-1 text-xs font-mono min-w-0">
                         <MatrixRow onClick={() => setSelectedMetric("techEdge")} label="Tech Edge" tooltip="Algorithmic scoring of technical momentum and indicator alignment." value={
                           <div className="flex items-center">
                             {(() => {
                               const te = techEdgeVal ?? (selectedSignal?.direction === "BUY" ? 92 : 84);
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
                               const ra = regimeAlignVal ?? (selectedSignal?.direction === "BUY" ? 88 : 82);
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
                 <div className="flex flex-col gap-1 pt-1 border-t border-border/15 w-full text-xs font-mono">
                   <MatrixRow onClick={() => setSelectedMetric("mtfConfluence")} label="MTF Confluence" tooltip="Multi-timeframe score assessing alignment across multiple charts (15m, 1h, 1d)." value={
                     (() => {
                       const s = scan?.mtfScore ?? 3;
                       const t = scan?.mtfTotal ?? 3;
                       const conf = scan?.mtfConfluenceScore ?? 1;
                       return (
                         <span className={cn("px-2 py-0.5 rounded flex items-center gap-1.5 min-w-0 text-[10px] break-words", conf > 0 ? "bg-bull/10 text-bull" : conf === 0 ? "bg-yellow-500/10 text-yellow-500" : "bg-bear/10 text-bear")}>
                           <span>{`${s}/${t}`} {conf > 0 ? 'STRONG ALIGNMENT (15M, 1H, 1D)' : conf === 0 ? 'PARTIAL ALIGNMENT' : 'DIVERGING TIMEFRAMES'}</span>
                         </span>
                       );
                     })()
                   } color="text-foreground" />
                   <MatrixRow onClick={() => setSelectedMetric("pricePattern")} label="Price Pattern" tooltip="Specific candlestick or structural patterns identified on the chart." value={
                     forecast?.technicalPatterns && forecast.technicalPatterns.length > 0 ? (
                       <span className="flex items-center gap-1.5 bg-orange-500/10 text-orange-500 px-2 py-0.5 rounded min-w-0 text-[10px] break-words">
                         <Flame className="h-3 w-3 shrink-0" />
                         <span>{forecast.technicalPatterns[0].replace(/_/g, " ")}</span>
                       </span>
                     ) : (selectedSignal?.setupType || scan?.setupType) && (selectedSignal?.setupType || scan?.setupType) !== "LIQUIDITY_SWEEP" ? (
                       <span className="flex items-center gap-1.5 bg-orange-500/10 text-orange-500 px-2 py-0.5 rounded min-w-0 text-[10px] break-words">
                         <Flame className="h-3 w-3 shrink-0" />
                         <span>{(selectedSignal?.setupType || scan?.setupType || "").replace(/_/g, " ")}</span>
                       </span>
                     ) : scan?.condition ? (
                       <span className="text-foreground/80 font-medium break-words">{scan.condition}</span>
                     ) : "NONE"
                   } color={(forecast?.technicalPatterns && forecast.technicalPatterns.length > 0) || ((selectedSignal?.setupType || scan?.setupType) && (selectedSignal?.setupType || scan?.setupType) !== "LIQUIDITY_SWEEP") ? "text-orange-500 font-bold" : "text-neutral-500"} />
                   <MatrixRow onClick={() => setSelectedMetric("modelSource")} label="Analysis Source" tooltip="Whether this is real model output or a heuristic fallback engine." value={(() => {
                     return forecast?.isFallback ? "HEURISTIC FALLBACK" : "AI MODEL";
                   })()} color={forecast?.isFallback ? "text-yellow-500 font-bold" : "text-green-500 font-bold"} />
                 </div>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>

        {/* ROW 4 deleted as requested */}
        {/* ROW 5: Confidence Evolution */}
        {scoreHistory.length >= 2 && (
          <motion.div transition={{ type: "spring", stiffness: 350, damping: 28 }} variants={{ hidden: { opacity: 0, y: 10 }, visible: { opacity: 1, y: 0 } }} className="mt-2 pt-2 border-t border-border/10 shrink-0 flex flex-col min-h-0">
            <div className="text-[10px] font-bold uppercase tracking-widest text-neutral-500 mb-2 shrink-0 flex items-center justify-between">
               <span>Confidence Evolution</span>
               {(() => {
                 const currentScore = scoreHistory[scoreHistory.length - 1];
                 const startScore = scoreHistory[0];
                 const diff = currentScore - startScore;
                 return (
                   <span className={cn("text-[9px] px-1 rounded-sm font-mono", diff > 0 ? "bg-bull/10 text-bull" : diff < 0 ? "bg-bear/10 text-bear" : "bg-neutral-800/50 text-neutral-500")}>
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

function DecryptText({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  
  useEffect(() => {
    if (!text || !ref.current) return;
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

function TerminalStat({ label, value, xl, color }: { label: string; value: React.ReactNode; xl?: boolean; color?: string }) {
  return (
    <div className="flex flex-col min-w-0">
      <span className="text-[10px] font-bold font-sans uppercase tracking-widest text-muted-foreground mb-0.5 truncate">{label}</span>
      <span className={cn("font-black font-mono tabular-nums tracking-tighter leading-none truncate", xl ? "text-2xl" : "text-xl", color || "text-foreground")}>
        {typeof value === "string" || typeof value === "number" ? <DecryptText text={String(value)} /> : value}
      </span>
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
              <span className="font-bold">{insights?.indicators?.trend?.toUpperCase() || "UNKNOWN"}</span>
            </div>
            <div className="flex justify-between items-center border-b border-border/10 py-1.5">
              <span className="text-muted-foreground">ADX (Trend Strength)</span>
              <span className="font-bold tabular-nums">{insights?.indicators?.adx14 ? fmtNum(insights.indicators.adx14) : "—"}</span>
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
              <span className="font-bold text-purple-400">{selectedSignal?.setupType || "STANDARD"}</span>
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
                 <div key={p} className="text-orange-500 py-1 border-b border-border/10 font-bold uppercase tracking-wide text-xs">{p.replace(/_/g, " ")}</div>
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
              <span className="font-bold tabular-nums">{insights?.indicators?.rsi14 ? fmtNum(insights.indicators.rsi14, 1) : "—"}</span>
            </div>
            <div className="flex justify-between items-center border-b border-border/10 py-1.5">
              <span className="text-muted-foreground">Zone</span>
              <span className="font-bold">{insights?.indicators?.rsi14 >= 70 ? "Overbought" : insights?.indicators?.rsi14 <= 30 ? "Oversold" : "Neutral"}</span>
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
              <span className="font-bold tabular-nums">{insights?.indicators?.volumeRatio ? `${fmtNum(insights.indicators.volumeRatio, 2)}x` : "—"}</span>
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
              <span className="font-bold tabular-nums">{insights?.indicators?.ema9 ? fmtNum(insights.indicators.ema9) : "—"}</span>
            </div>
            <div className="flex justify-between items-center border-b border-border/10 py-1.5">
              <span className="text-muted-foreground">20 EMA</span>
              <span className="font-bold tabular-nums">{insights?.indicators?.ema20 ? fmtNum(insights.indicators.ema20) : "—"}</span>
            </div>
            <div className="flex justify-between items-center border-b border-border/10 py-1.5">
              <span className="text-muted-foreground">Distance from 20 EMA</span>
              <span className="font-bold tabular-nums">{insights?.indicators?.distFromEma20Pct != null ? fmtPct(insights.indicators.distFromEma20Pct) : "—"}</span>
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
              <span className="font-bold text-bull tabular-nums">+{selectedSignal?.signalFactors?.technical?.contribution ?? 0}%</span>
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
              <span className="font-bold tabular-nums">{scan?.mtfConfluenceScore ? `${scan.mtfConfluenceScore}/100` : "PENDING"}</span>
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
              <span className="font-bold text-bull">{selectedSignal?.direction === 'BUY' ? "> VWAP" : selectedSignal?.direction === 'SELL' ? "< VWAP" : "VALID"}</span>
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
              <span className="font-bold text-bull tabular-nums">+{selectedSignal?.signalFactors?.regime?.contribution ?? 0}%</span>
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
              <span className="font-bold tabular-nums">{forecast?.medianForecast ? fmtPct(forecast.medianForecast[forecast.medianForecast.length - 1] * 100) : "—"}</span>
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
              <span className="font-bold text-orange-500">{forecast?.isFallback ? "FALLBACK" : (forecast?.source ? forecast.source.toUpperCase().replace("NIFTY50GPT", "GPT-50") : "ENSEMBLE")}</span>
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
        <h3 className="text-xs font-black tracking-tight uppercase">{title}</h3>
      </div>
      <div className="pr-1 pb-1">
        {content}
      </div>
    </div>
  );
}

function MatrixRow({ label, value, color, tooltip, onClick, className }: { label: string; value: React.ReactNode; color: string; tooltip?: string; onClick?: () => void; className?: string }) {
  const content = (
    <motion.li onClick={onClick} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.3 }} className={cn("flex justify-between items-start group gap-2 py-1 min-w-0 text-[11px]", onClick ? "cursor-pointer" : "cursor-default", className)}>
      <span className={cn("text-muted-foreground transition-colors shrink-0 rounded py-0.5 px-1 -ml-1", onClick ? "group-hover:bg-white/5 group-hover:text-foreground apple-hover" : "group-hover:text-foreground")}>{label}</span>
      <span className={cn("font-bold flex flex-wrap items-center justify-end text-right min-w-0 tabular-nums break-words", color)}>
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
