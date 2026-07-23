import React, { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { calculateSRLevels, type SRLevel } from "@/lib/technicalAnalysis";
import { useSymbolDataSelector } from "@/providers/MarketDataProvider";
import { fmtNum } from "@/lib/format";
import { Activity } from "lucide-react";
import { cn } from "@/lib/format";
import { AnimatedNumber } from "@/components/atoms/AnimatedNumber";
import { Skeleton } from "@/components/atoms/Skeleton";

interface SupportResistancePanelProps {
  selectedSymbol: string;
}

export const SupportResistancePanel = React.memo(function SupportResistancePanel({
  selectedSymbol,
}: SupportResistancePanelProps) {
  // We fetch daily candles to calculate our levels
  const candlesQuery = useQuery({
    queryKey: ["candles", selectedSymbol, "day", 15],
    queryFn: () => api.candles(selectedSymbol, "day", 15),
    enabled: Boolean(selectedSymbol.trim()),
    refetchInterval: 30000,
    staleTime: 15000,
  });

  const currentPrice = useSymbolDataSelector(selectedSymbol, d => d.ltp) || 
    (candlesQuery.data?.candles?.length ? candlesQuery.data.candles[candlesQuery.data.candles.length - 1].close : 0);

  const baseLevels = useMemo(() => {
    if (!candlesQuery.data?.candles || candlesQuery.data.candles.length === 0) return null;
    const lastClose = candlesQuery.data.candles[candlesQuery.data.candles.length - 1].close;
    return calculateSRLevels(candlesQuery.data.candles, lastClose);
  }, [candlesQuery.data?.candles]);

  const extraMetrics = useMemo(() => {
    if (!candlesQuery.data?.candles || candlesQuery.data.candles.length < 10) return null;
    const candles = candlesQuery.data.candles;
    
    // Average Daily Range (ADR - 10 day)
    const recent = candles.slice(-10);
    const avgRange = recent.reduce((sum, c) => sum + (c.high - c.low), 0) / recent.length;
    const avgRangePct = currentPrice > 0 ? (avgRange / currentPrice) * 100 : 0;
    
    // Volume comparison
    const last = candles[candles.length - 1];
    const prev = recent.slice(0, 9);
    const avgVol = prev.reduce((sum, c) => sum + c.volume, 0) / (prev.length || 1);
    const volRatio = avgVol > 0 ? last.volume / avgVol : 0;
    
    // Additional session metrics
    const dayHigh = last.high;
    const dayLow = last.low;
    const prevClose = candles.length >= 2 ? candles[candles.length - 2].close : last.open;
    const gapPct = ((last.open - prevClose) / prevClose) * 100;
    
    return { avgRange, avgRangePct, volRatio, avgVol, dayHigh, dayLow, gapPct, prevClose };
  }, [candlesQuery.data?.candles, currentPrice]);

  // Map levels array to labeled pivot levels (real computed values only)
  const levels = useMemo(() => {
    if (!baseLevels || !Array.isArray(baseLevels)) return null;

    const findByLabel = (lbl: string): SRLevel | undefined => baseLevels.find(l => l.label === lbl);
    return {
      r1: findByLabel("R1"),
      r2: findByLabel("R2"),
      s1: findByLabel("S1"),
      s2: findByLabel("S2"),
    };
  }, [baseLevels]);

  if (!selectedSymbol) {
    return (
      <div className="h-full bg-transparent flex flex-col items-center justify-center text-neutral-600">
        <Activity className="h-8 w-8 mb-3 opacity-20" />
      </div>
    );
  }

  if (candlesQuery.isPending || candlesQuery.isError || !levels || !currentPrice) {
    // Ladder-shaped skeleton mirroring the loaded layout: while candles load
    // it shimmers; once resolved-but-empty it reads "awaiting data". Never a
    // spinner — the placeholder keeps the panel's silhouette stable.
    const pending = candlesQuery.isPending;
    return (
      <div className="bg-transparent h-full flex flex-col pt-1 overflow-hidden">
        <div className="text-[9px] font-medium font-sans uppercase tracking-[0.2em] text-muted-foreground/90 mb-1.5 shrink-0 flex items-center justify-between">
          <span>Key Levels</span>
          {!pending && <span className="font-mono text-neutral-600 normal-case tracking-normal">awaiting data</span>}
        </div>
        <div className={cn("flex flex-col justify-evenly flex-1 min-h-0 py-1", !pending && "opacity-50")}>
          {["w-[52%]", "w-[68%]", "w-[84%]", "w-[68%]", "w-[52%]"].map((w, i) => (
            <div key={i} className="flex items-center gap-2">
              <Skeleton className="h-[9px] w-5 shrink-0" />
              <Skeleton className={cn("h-[3px] rounded-full", w)} />
              <div className="flex-1" />
              <Skeleton className="h-[9px] w-14 shrink-0" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  const { r1, r2, s1, s2 } = levels;
  const confluenceScore = Math.min(
    100,
    Math.round(
      (([r1, r2, s1, s2].filter(Boolean).length * 20) +
        ([r1?.strength, r2?.strength, s1?.strength, s2?.strength].filter(s => typeof s === "number" ? s >= 8 : s === "Strong").length * 10))
    )
  );

  const r1Dist = r1 && currentPrice > 0 ? ((r1.price - currentPrice) / currentPrice) * 100 : 0;
  const s1Dist = s1 && currentPrice > 0 ? ((s1.price - currentPrice) / currentPrice) * 100 : 0;
  const r2Dist = r2 && currentPrice > 0 ? ((r2.price - currentPrice) / currentPrice) * 100 : 0;
  const s2Dist = s2 && currentPrice > 0 ? ((s2.price - currentPrice) / currentPrice) * 100 : 0;

  // Max absolute distance drives proximity bar scaling (closest level = longest bar)
  const maxDist = Math.max(Math.abs(r1Dist), Math.abs(r2Dist), Math.abs(s1Dist), Math.abs(s2Dist), 0.01);
  const proximity = (dist: number) => Math.round((1 - Math.abs(dist) / maxDist) * 88) + 12;

  // Where LTP sits inside the S1–R1 trading range (0 = at support, 100 = at resistance)
  const rangePos = s1 && r1 && r1.price > s1.price
    ? Math.min(100, Math.max(0, ((currentPrice - s1.price) / (r1.price - s1.price)) * 100))
    : null;

  // Plain render helper (NOT a component) — invoked as levelRow(...) so it does
  // not create a new component identity each tick, which would remount the
  // subtree and reset AnimatedNumber's flash/entry animation on every price update.
  const levelRow = ({ label, level, dist, side }: { label: string; level: SRLevel; dist: number; side: "R" | "S" }) => {
    const isRes = side === "R";
    const tone = isRes ? "text-bear" : "text-bull";
    const barTone = isRes ? "bg-bear/70" : "bg-bull/70";
    return (
      <div className="group relative flex items-center gap-2 py-[5px] font-mono text-xs">
        <span className={cn("w-5 shrink-0 font-sans font-medium tracking-[0.06em] text-[11px]", tone)}>{label}</span>
        <div className="flex-1 flex items-center gap-1.5 min-w-0">
          <div className="relative h-[3px] flex-1 max-w-[64px] bg-foreground/[0.07] rounded-full overflow-hidden">
            <div className={cn("absolute inset-y-0 left-0 rounded-full", barTone)} style={{ width: `${proximity(dist)}%` }} />
          </div>
          <span className={cn("text-[10px] tabular-nums shrink-0", isRes ? "text-bear/70" : "text-bull/70")}>
            <AnimatedNumber value={dist} decimals={Math.abs(dist) < 0.1 ? 2 : 1} showSign={true} suffix="%" duration={0.3} flashColor={true} />
          </span>
        </div>
        <span className={cn("tabular-nums tracking-tight shrink-0", isRes ? "text-bear/90" : "text-bull/90")}>₹{fmtNum(level.price, 2)}</span>
      </div>
    );
  };


  return (
    <div className="bg-transparent h-full flex flex-col text-card-foreground pt-1 pb-0 overflow-hidden border-0">
      <div className="text-[9px] font-medium font-sans uppercase tracking-[0.2em] text-muted-foreground/90 mb-1.5 shrink-0 flex items-center justify-between">
         <span className="flex items-center gap-1.5">Key Levels</span>
         <span className={cn("font-mono font-medium tracking-[-0.01em] normal-case text-[10px]", confluenceScore > 80 ? "text-bull/80" : confluenceScore > 50 ? "text-yellow-500/80" : "text-neutral-500")}>
           {fmtNum(confluenceScore, 0)}% <span className="uppercase tracking-[0.08em] text-muted-foreground/80 font-sans font-medium">conf</span>
         </span>
      </div>

      {/* Price ladder — auto-adjusting layout */}
      <div className="flex flex-col flex-1 min-h-0 justify-evenly tabular-nums tracking-tight py-1 relative overflow-hidden">
        {r2 && levelRow({ label: "R2", level: r2, dist: r2Dist, side: "R" })}
        {r1 && levelRow({ label: "R1", level: r1, dist: r1Dist, side: "R" })}

        {/* LTP band */}
        <div className="relative flex items-center gap-2 py-[5px] my-[1px] font-mono text-xs shrink-0">
          <span className="w-5 shrink-0 font-sans font-medium tracking-[0.06em] text-[11px] text-foreground">LTP</span>
          <div className="flex-1 flex items-center min-w-0">
            {rangePos != null && (
              <div className="relative h-[3px] flex-1 rounded-full overflow-hidden bg-gradient-to-r from-bull/30 via-foreground/10 to-bear/30">
                <div className="absolute top-1/2 -translate-y-1/2 h-[7px] w-[2px] rounded-full bg-foreground shadow-[0_0_4px_rgba(255,255,255,0.5)]" style={{ left: `calc(${rangePos}% - 1px)` }} />
              </div>
            )}
          </div>
          {rangePos != null && (
            <span className="text-[10px] tabular-nums shrink-0 text-muted-foreground/80" title="Position inside the S1–R1 range (0% = at support, 100% = at resistance)">
              {fmtNum(rangePos, 0)}% <span className="text-muted-foreground/80">of range</span>
            </span>
          )}
        </div>

        {s1 && levelRow({ label: "S1", level: s1, dist: s1Dist, side: "S" })}
        {s2 && levelRow({ label: "S2", level: s2, dist: s2Dist, side: "S" })}
      </div>

      {/* Extra metrics section at the bottom */}
      {extraMetrics && (
        <div className="mt-auto grid grid-cols-2 gap-y-2 gap-x-2 shrink-0 border-t border-border/40 pt-[7px] pb-1">
          {/* Row 1 */}
          <div className="flex flex-col gap-0.5">
            <span className="text-[9px] uppercase tracking-wider text-muted-foreground/70 font-sans font-medium">10D ADR</span>
            <div className="flex items-baseline gap-1.5">
              <span className="text-[11px] font-mono">₹{fmtNum(extraMetrics.avgRange, 2)}</span>
              <span className="text-[9px] font-mono text-muted-foreground/70">{fmtNum(extraMetrics.avgRangePct, 1)}%</span>
            </div>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-[9px] uppercase tracking-wider text-muted-foreground/70 font-sans font-medium">Vol vs 10D Avg</span>
            <div className="flex items-baseline gap-1.5">
              <span className={cn("text-[11px] font-mono", extraMetrics.volRatio > 1.5 ? "text-bull" : extraMetrics.volRatio < 0.5 ? "text-bear" : "text-foreground")}>
                {fmtNum(extraMetrics.volRatio, 1)}x
              </span>
              <span className="text-[9px] font-mono text-muted-foreground/70">
                {extraMetrics.avgVol > 1000000 
                  ? `${fmtNum(extraMetrics.avgVol / 1000000, 1)}M` 
                  : `${fmtNum(extraMetrics.avgVol / 1000, 0)}k`} avg
              </span>
            </div>
          </div>

          {/* Row 2 */}
          <div className="flex flex-col gap-0.5">
            <span className="text-[9px] uppercase tracking-wider text-muted-foreground/70 font-sans font-medium">Session High</span>
            <div className="flex items-baseline gap-1.5">
              <span className="text-[11px] font-mono">₹{fmtNum(extraMetrics.dayHigh, 2)}</span>
              {currentPrice > 0 && <span className="text-[9px] font-mono text-muted-foreground/70">{fmtNum(Math.abs((extraMetrics.dayHigh - currentPrice) / currentPrice * 100), 2)}% away</span>}
            </div>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-[9px] uppercase tracking-wider text-muted-foreground/70 font-sans font-medium">Session Low</span>
            <div className="flex items-baseline gap-1.5">
              <span className="text-[11px] font-mono">₹{fmtNum(extraMetrics.dayLow, 2)}</span>
              {currentPrice > 0 && <span className="text-[9px] font-mono text-muted-foreground/70">{fmtNum(Math.abs((currentPrice - extraMetrics.dayLow) / currentPrice * 100), 2)}% away</span>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
});
