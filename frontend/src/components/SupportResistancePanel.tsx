import React, { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { calculateSRLevels, type SRLevel } from "@/lib/technicalAnalysis";
import { useSymbolDataSelector } from "@/providers/MarketDataProvider";
import { fmtNum } from "@/lib/format";
import { Activity } from "lucide-react";
import { cn } from "@/lib/format";
import { LivePrice } from "@/components/atoms/LivePrice";
import { AnimatedNumber } from "@/components/atoms/AnimatedNumber";

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
    refetchInterval: 5 * 60 * 1000, // refresh every 5 mins for new daily highs/lows
  });

  const currentPrice = useSymbolDataSelector(selectedSymbol, d => d.ltp) || 
    (candlesQuery.data?.candles?.length ? candlesQuery.data.candles[candlesQuery.data.candles.length - 1].close : 0);

  const baseLevels = useMemo(() => {
    if (!candlesQuery.data?.candles || candlesQuery.data.candles.length === 0) return null;
    const lastClose = candlesQuery.data.candles[candlesQuery.data.candles.length - 1].close;
    return calculateSRLevels(candlesQuery.data.candles, lastClose);
  }, [candlesQuery.data?.candles]);

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

  if (candlesQuery.isPending && !levels) {
    return (
      <div className="h-full bg-transparent flex flex-col items-center justify-center text-neutral-600">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent mb-3" />
      </div>
    );
  }

  if (candlesQuery.isError || !levels || !currentPrice) {
    return (
      <div className="h-full bg-transparent flex flex-col items-center justify-center text-muted-foreground/60 p-4 text-center">
        <span className="text-[11px] font-mono">No support/resistance computed (awaiting market data)</span>
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

  return (
    <div className="bg-transparent flex flex-col text-card-foreground pt-1 pb-0 overflow-hidden border-0 shrink-0">
      <div className="text-[10px] font-bold font-sans uppercase tracking-widest text-neutral-500 mb-1.5 shrink-0 flex items-center justify-between">
         <span>Support & Resistance</span>
         <span className={cn("font-mono", confluenceScore > 80 ? "text-bull" : confluenceScore > 50 ? "text-yellow-500" : "text-neutral-500")}>
           {fmtNum(confluenceScore, 0)}% CONF
         </span>
      </div>

      {/* Diagram Section */}
      <div className="flex flex-col gap-1 font-mono text-xs w-full shrink-0 mb-2 tabular-nums">
        {r2 && (
          <div className="flex justify-between items-center text-bear/80">
            <div className="flex items-center gap-1.5">
              <span className="font-bold">R2</span>
              <span className="text-[10px] font-mono opacity-80">
                <AnimatedNumber value={r2Dist} decimals={Math.abs(r2Dist) < 0.1 ? 2 : 1} showSign={true} suffix="%" duration={0.3} flashColor={true} />
              </span>
            </div>
            <span>₹{fmtNum(r2.price, 2)}</span>
          </div>
        )}
        {r1 && (
          <div className="flex justify-between items-center text-bear/90">
            <div className="flex items-center gap-1.5">
              <span className="font-bold">R1</span>
              <span className="text-[10px] font-mono opacity-80">
                <AnimatedNumber value={r1Dist} decimals={Math.abs(r1Dist) < 0.1 ? 2 : 1} showSign={true} suffix="%" duration={0.3} flashColor={true} />
              </span>
            </div>
            <span>₹{fmtNum(r1.price, 2)}</span>
          </div>
        )}
        
        <div className="w-full h-px bg-border/20 my-0.5" />
        
        <div className="flex justify-between items-center text-foreground font-black py-0.5">
          <span>LTP</span>
          <LivePrice symbol={selectedSymbol} decimals={2} fallback={currentPrice} className="font-mono text-xs" />
        </div>

        <div className="w-full h-px bg-border/20 my-0.5" />

        {s1 && (
          <div className="flex justify-between items-center text-bull/90">
            <div className="flex items-center gap-1.5">
              <span className="font-bold">S1</span>
              <span className="text-[10px] font-mono opacity-80">
                <AnimatedNumber value={s1Dist} decimals={Math.abs(s1Dist) < 0.1 ? 2 : 1} showSign={true} suffix="%" duration={0.3} flashColor={true} />
              </span>
            </div>
            <span>₹{fmtNum(s1.price, 2)}</span>
          </div>
        )}
        {s2 && (
          <div className="flex justify-between items-center text-bull/80">
            <div className="flex items-center gap-1.5">
              <span className="font-bold">S2</span>
              <span className="text-[10px] font-mono opacity-80">
                <AnimatedNumber value={s2Dist} decimals={Math.abs(s2Dist) < 0.1 ? 2 : 1} showSign={true} suffix="%" duration={0.3} flashColor={true} />
              </span>
            </div>
            <span>₹{fmtNum(s2.price, 2)}</span>
          </div>
        )}
      </div>
    </div>
  );
});
