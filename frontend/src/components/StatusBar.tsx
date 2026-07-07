import { memo } from "react";
import { cn, fmtNum } from "@/lib/format";
import type { SystemStatus, MarketRegime } from "@/types/api";
import { ArrowUpRight, ArrowDownRight } from "lucide-react";
import { Tooltip } from "@/components/mimir/tooltip";
import { motion } from "framer-motion";

function StatusLed({ status }: { status: "ok" | "warn" | "error" | "unknown" }) {
  const color = status === "ok" ? "bg-green-500" : status === "warn" ? "bg-yellow-500" : status === "error" ? "bg-red-500" : "bg-neutral-500";
  const shadow = status === "ok" ? "rgba(34,197,94,0.6)" : status === "warn" ? "rgba(234,179,8,0.6)" : status === "error" ? "rgba(239,68,68,0.6)" : "rgba(115,115,115,0.6)";
  
  return (
    <motion.div 
      animate={{ opacity: [0.4, 1, 0.4] }} 
      transition={{ duration: 2.5, repeat: Infinity, ease: "easeInOut" }} 
      className={cn("w-1.5 h-1.5 rounded-full shrink-0", color)} 
      style={{ boxShadow: `0 0 8px ${shadow}` }} 
    />
  );
}

interface StatusBarProps {
  status: SystemStatus | undefined;
  regime: MarketRegime | undefined;
  wsConnected: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  macro: any | undefined;
}

export const StatusBar = memo(function StatusBar({ status, regime, wsConnected, macro }: StatusBarProps) {
  return (
    <div className="shrink-0 h-10 pb-1.5 w-full bg-background flex items-center px-4 sm:px-6 text-[9px] font-mono text-muted-foreground tracking-widest uppercase z-50 overflow-x-auto whitespace-nowrap [&::-webkit-scrollbar]:hidden">
      <div className="flex shrink-0 items-center gap-4 sm:gap-6 text-foreground/70">
        <span className="flex items-center gap-1.5 cursor-help" title="AI Status: Health of Native Math Models">
          AI
          <div className="flex items-center gap-1.5 bg-foreground/5 px-2 py-0.5 rounded-full border border-border/20">
            <StatusLed status={status?.aiStatus?.toLowerCase().includes("healthy") ? "ok" : "error"} />
            <span className={cn("font-bold text-[10px]", status?.aiStatus?.toLowerCase().includes("healthy") ? "text-emerald-500" : "text-destructive")}>
              {status?.aiStatus ? status.aiStatus : "UNKNOWN"}
            </span>
          </div>
        </span>
        <Tooltip
          className="cursor-help flex items-center gap-1.5"
          content={
            <div className="flex flex-col gap-1 w-48 text-[11px]">
              <div className="font-bold border-b border-border/20 pb-1 mb-1">REGIME ANALYSIS</div>
              <div className="flex justify-between text-muted-foreground">
                <span>VIX:</span>
                <span className={cn("font-mono font-bold", regime?.indiaVix ? (regime.indiaVix > 18 ? "text-red-500" : regime.indiaVix < 13 ? "text-yellow-500" : "text-green-500") : "text-foreground")}>
                  {regime?.indiaVix ? regime.indiaVix.toFixed(2) : "N/A"}
                </span>
              </div>
              <div className="flex justify-between text-muted-foreground">
                <span>Nifty Change:</span>
                <span className={cn("font-mono font-bold", regime?.niftyChange ? (regime.niftyChange > 0 ? "text-bull" : "text-bear") : "text-foreground")}>
                  {regime?.niftyChange ? `${regime.niftyChange > 0 ? "+" : ""}${regime.niftyChange.toFixed(2)}%` : "N/A"}
                </span>
              </div>
              <div className="flex justify-between text-muted-foreground">
                <span>Sector Breadth:</span>
                <span className="font-mono font-bold text-foreground">
                  {regime?.sectorBreadth != null ? `${(regime.sectorBreadth * 100).toFixed(0)}%` : "N/A"}
                </span>
              </div>
              <div className="flex justify-between text-muted-foreground">
                <span>Momentum:</span>
                <span className="font-mono font-bold text-foreground">
                  {regime?.momentum != null ? regime.momentum.toFixed(2) : "N/A"}
                </span>
              </div>
            </div>
          }
        >
          REGIME
          <span className={cn(
            "font-bold", 
            regime?.regime?.includes("UP") ? "text-bull" : 
            regime?.regime?.includes("DOWN") ? "text-bear" : 
            "text-foreground"
          )}>
            {regime?.regime ? regime.regime.replaceAll("_", " ") : "?"}
          </span>
        </Tooltip>
        <span className="flex items-center gap-1.5 cursor-help" title="Scheduler: Background job status for scans and ticks">
          SCHEDULER
          <div className="flex items-center gap-1.5 bg-foreground/5 px-2 py-0.5 rounded-full border border-border/20">
            <StatusLed status={status?.schedulerRunning ? "ok" : "error"} />
            <span className={cn("font-bold text-[10px]", status?.schedulerRunning ? "text-green-500" : "text-red-500")}>
              {status?.schedulerRunning ? "ON" : "OFF"}
            </span>
          </div>
        </span>
        <span className="flex items-center gap-1.5 cursor-help" title="Network: WebSocket real-time connection status">
          NETWORK
          <div className="flex items-center gap-1.5 bg-foreground/5 px-2 py-0.5 rounded-full border border-border/20">
            <StatusLed status={wsConnected ? "ok" : "error"} />
            <span className={cn("font-bold text-[10px]", wsConnected ? "text-green-500" : "text-red-500")}>
              {wsConnected ? "OK" : "ERR"}
            </span>
          </div>
        </span>
      </div>
      
      {macro && (
        <div className="flex items-center gap-3 sm:gap-4 ml-auto text-muted-foreground pl-4 border-l border-border/40 shrink-0">
          <span className="font-bold text-foreground hidden sm:inline">INDIAN CONTEXT</span>
          <span className="font-bold text-foreground sm:hidden">MACRO</span>
          
          {macro.fiiDii ? (
            <div className="flex items-center gap-1.5">
              <span>FII:</span>
              <span className={cn("font-medium flex items-center gap-0.5", macro.fiiDii.fiiNetInr < 0 ? "text-red-500" : "text-green-500")}>
                {macro.fiiDii.fiiNetInr > 0 ? <ArrowUpRight className="h-3 w-3" /> : macro.fiiDii.fiiNetInr < 0 ? <ArrowDownRight className="h-3 w-3" /> : null}
                {fmtNum(Math.abs(macro.fiiDii.fiiNetInr))}Cr
              </span>
              <span className="mx-1 text-border/40">|</span>
              <span>DII:</span>
              <span className={cn("font-medium flex items-center gap-0.5", macro.fiiDii.diiNetInr < 0 ? "text-red-500" : "text-green-500")}>
                {macro.fiiDii.diiNetInr > 0 ? <ArrowUpRight className="h-3 w-3" /> : macro.fiiDii.diiNetInr < 0 ? <ArrowDownRight className="h-3 w-3" /> : null}
                {fmtNum(Math.abs(macro.fiiDii.diiNetInr))}Cr
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 text-muted-foreground/50">
              <span>FII/DII:</span>
              <span className="font-medium">N/A</span>
            </div>
          )}

          {macro.niftyOptionChain && (
            <>
              <span className="mx-1 text-border/40">|</span>
              <div className="flex items-center gap-1.5">
                <span>PCR:</span>
                <span className={cn("font-medium", macro.niftyOptionChain.pcr > 1.2 ? "text-green-500" : macro.niftyOptionChain.pcr < 0.7 ? "text-red-500" : "text-foreground")}>
                  {macro.niftyOptionChain.pcr.toFixed(2)}
                </span>
                <span className="mx-1 text-border/40">|</span>
                <span>MAX PAIN:</span>
                <span className="font-medium text-foreground">
                  {fmtNum(macro.niftyOptionChain.maxPain)}
                </span>
              </div>
            </>
          )}

          <span className="mx-1 text-border/40">|</span>
          <div className="flex items-center gap-1.5">
            <span>USD/INR:</span>
            <span className={cn("font-medium", macro.usdInr > 83.5 ? "text-red-500" : "text-foreground")}>
              {macro.usdInr ? macro.usdInr.toFixed(2) : "—"}
            </span>
            <span className="mx-1 text-border/40">|</span>
            <span>IN10Y:</span>
            <span className={cn("font-medium", macro.india10y > 7.2 ? "text-red-500" : "text-foreground")}>
              {macro.india10y ? macro.india10y.toFixed(2) : "—"}%
            </span>
          </div>

          <span className="mx-1 text-border/40">|</span>
          <div className="flex items-center gap-1.5">
            <span>RISK:</span>
            {macro.eventRiskActive ? (
              <span className="bg-red-500/20 text-red-500 px-1.5 py-0.5 rounded font-bold animate-pulse">ELEVATED</span>
            ) : (
              <span className="text-green-500 font-bold">NORMAL</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
});
