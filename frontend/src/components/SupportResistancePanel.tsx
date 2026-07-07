import React, { useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { calculateSRLevels } from "@/lib/technicalAnalysis";
import { useSymbolData } from "@/providers/MarketDataProvider";
import { fmtNum, fmtPct } from "@/lib/format";
import { Activity } from "lucide-react";
import { cn } from "@/lib/format";

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
    placeholderData: keepPreviousData,
    refetchInterval: 5 * 60 * 1000, // refresh every 5 mins for new daily highs/lows
  });

  const liveData = useSymbolData(selectedSymbol);
  const currentPrice = liveData?.ltp || 0;

  const levels = useMemo(() => {
    if (!candlesQuery.data?.candles || currentPrice === 0) return null;
    return calculateSRLevels(candlesQuery.data.candles, currentPrice);
  }, [candlesQuery.data, currentPrice]);

  if (!selectedSymbol) {
    return (
      <div className="h-full bg-transparent flex flex-col items-center justify-center text-neutral-600">
        <Activity className="h-8 w-8 mb-3 opacity-20" />
      </div>
    );
  }

  if (candlesQuery.isPending || !levels) {
    return (
      <div className="h-full bg-transparent flex flex-col items-center justify-center text-neutral-600">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent mb-3" />
      </div>
    );
  }

  const resistance = levels.filter((l) => l.type === "resistance").sort((a, b) => a.price - b.price); // Nearest first
  const support = levels.filter((l) => l.type === "support").sort((a, b) => b.price - a.price); // Nearest first

  const r1 = resistance[0];
  const r2 = resistance[1];
  const s1 = support[0];
  const s2 = support[1];

  const r1Dist = r1 && currentPrice > 0 ? ((r1.price - currentPrice) / currentPrice) * 100 : 0;
  const s1Dist = s1 && currentPrice > 0 ? ((s1.price - currentPrice) / currentPrice) * 100 : 0;
  const r2Dist = r2 && currentPrice > 0 ? ((r2.price - currentPrice) / currentPrice) * 100 : 0;
  const s2Dist = s2 && currentPrice > 0 ? ((s2.price - currentPrice) / currentPrice) * 100 : 0;

  // Calculate confluence percentage based on how many sources merged into the nearest levels
  const maxSources = 4;
  const confluenceScore = Math.min(100, Math.max(0, (((r1?.sources.length || 1) + (s1?.sources.length || 1)) / (maxSources * 2)) * 100 + 40)); 

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
              <span className="text-[10px] font-mono opacity-80">{fmtPct(r2Dist)}</span>
            </div>
            <span>₹{fmtNum(r2.price, 2)}</span>
          </div>
        )}
        {r1 && (
          <div className="flex justify-between items-center text-bear/90">
            <div className="flex items-center gap-1.5">
              <span className="font-bold">R1</span>
              <span className="text-[10px] font-mono opacity-80">{fmtPct(r1Dist)}</span>
            </div>
            <span>₹{fmtNum(r1.price, 2)}</span>
          </div>
        )}
        
        <div className="w-full h-px bg-border/20 my-0.5" />
        
        <AnimatePresence mode="popLayout">
          <motion.div 
            key={currentPrice}
            initial={{ opacity: 0.5, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            className="flex justify-between items-center text-foreground font-black py-0.5"
          >
            <span>LTP</span>
            <span>₹{fmtNum(currentPrice, 2)}</span>
          </motion.div>
        </AnimatePresence>

        <div className="w-full h-px bg-border/20 my-0.5" />

        {s1 && (
          <div className="flex justify-between items-center text-bull/90">
            <div className="flex items-center gap-1.5">
              <span className="font-bold">S1</span>
              <span className="text-[10px] font-mono opacity-80">{fmtPct(s1Dist)}</span>
            </div>
            <span>₹{fmtNum(s1.price, 2)}</span>
          </div>
        )}
        {s2 && (
          <div className="flex justify-between items-center text-bull/80">
            <div className="flex items-center gap-1.5">
              <span className="font-bold">S2</span>
              <span className="text-[10px] font-mono opacity-80">{fmtPct(s2Dist)}</span>
            </div>
            <span>₹{fmtNum(s2.price, 2)}</span>
          </div>
        )}
      </div>
    </div>
  );
});
