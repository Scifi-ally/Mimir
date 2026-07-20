import { memo } from "react";
import { cn, fmtNum, toFixed, fmtPct } from "@/lib/format";
import type { SystemStatus, MarketRegime } from "@/types/api";
import { ArrowUpRight, ArrowDownRight } from "lucide-react";
import { Tooltip } from "@/components/mimir/tooltip";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

function StatusLed({ status }: { status: "ok" | "warn" | "error" | "unknown" }) {
  const color = status === "ok" ? "bg-green-500" : status === "warn" ? "bg-yellow-500" : status === "error" ? "bg-red-500" : "bg-neutral-500";
  const shadow = status === "ok" ? "rgba(34,197,94,0.5)" : status === "warn" ? "rgba(234,179,8,0.5)" : status === "error" ? "rgba(239,68,68,0.5)" : "rgba(115,115,115,0.3)";

  // CSS keyframe (led-breathe) instead of a framer-motion animate loop: each
  // motion-driven LED is a persistent JS animation frame consumer; the status
  // bar renders 4+ of them. Compositor-driven CSS is visually identical.
  return (
    <div
      className={cn("w-[5px] h-[5px] rounded-full shrink-0 animate-led-breathe", color)}
      style={{ boxShadow: `0 0 6px ${shadow}` }}
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
  const { data: tradingMode } = useQuery({
    queryKey: ["trading-mode"],
    queryFn: api.tradingMode,
    refetchInterval: 30000,
    staleTime: 15000,
  });
  const isLiveTrading = tradingMode?.mode === "LIVE";
  const aiStatus = status?.aiStatus?.toLowerCase() ?? "unknown";
  const aiMode = status?.aiMode?.toLowerCase() ?? "";
  const aiOk = aiStatus.includes("healthy") || aiMode === "ai mode";
  const aiWarn = !aiOk && (aiStatus.includes("degraded") || aiMode.includes("fallback"));
  const aiLabel = status?.aiStatus
    ? status.aiStatus.toUpperCase()
    : "UNKNOWN";

  return (
    <div className="shrink-0 h-9 lg:h-10 w-full bg-background flex items-center px-4 sm:px-6 text-[10px] sm:text-[10px] xl:text-[10px] font-sans text-muted-foreground/60 tracking-[0.1em] uppercase z-50 overflow-x-auto whitespace-nowrap [&::-webkit-scrollbar]:hidden">
      <div className="flex shrink-0 items-center gap-5 sm:gap-6 text-foreground/60">
        {isLiveTrading && (
          <span className="flex items-center gap-1.5 cursor-help" title="Live trading armed — engine fills place real broker orders">
            <div className="flex items-center gap-1.5 bg-destructive/10 px-2 py-0.5 rounded-full">
              <StatusLed status="error" />
              <span className="font-normal text-[10px] text-destructive">LIVE</span>
            </div>
          </span>
        )}
        <span className="flex items-center gap-1.5 cursor-help" title="AI Status: Health of Native Math Models">
          AI
          <div className="flex items-center gap-1.5 bg-foreground/5 px-2 py-0.5 rounded-full">
            <StatusLed status={aiOk ? "ok" : aiWarn ? "warn" : "error"} />
            <span className={cn("font-normal text-[10px]", aiOk ? "text-bull" : aiWarn ? "text-yellow-500" : "text-bear")}>
              {aiLabel}
            </span>
          </div>
        </span>
        <Tooltip
          className="cursor-help flex items-center gap-1.5"
          content={
            <div className="flex flex-col gap-1 w-48 text-[11px]">
              <div className="font-normal pb-1 mb-1 text-foreground/60">REGIME ANALYSIS</div>
              <div className="flex justify-between text-muted-foreground">
                <span>VIX:</span>
                <span className={cn("font-mono font-normal", regime?.indiaVix ? (regime.indiaVix > 18 ? "text-bear" : regime.indiaVix < 13 ? "text-bull" : "text-foreground") : "text-foreground")}>
                  {regime?.indiaVix ? toFixed(regime.indiaVix, 2) : "N/A"}
                </span>
              </div>
              <div className="flex justify-between text-muted-foreground">
                <span>Nifty Change:</span>
                <span className={cn("font-mono font-normal", regime?.niftyChange ? (regime.niftyChange > 0 ? "text-bull" : "text-bear") : "text-foreground")}>
                  {regime?.niftyChange ? fmtPct(regime.niftyChange, 2) : "N/A"}
                </span>
              </div>
              <div className="flex justify-between text-muted-foreground">
                <span>Sector Breadth:</span>
                <span className="font-mono font-normal text-foreground">
                  {regime?.sectorBreadth != null ? `${toFixed(regime.sectorBreadth, 0)}%` : "N/A"}
                </span>
              </div>
              <div className="flex justify-between text-muted-foreground">
                <span>Momentum:</span>
                <span className="font-mono font-normal text-foreground">
                  {regime?.momentum != null ? toFixed(regime.momentum, 2) : "N/A"}
                </span>
              </div>
            </div>
          }
        >
          REGIME
          <span className={cn(
            "font-normal", 
            regime?.regime?.includes("UP") ? "text-bull" : 
            regime?.regime?.includes("DOWN") ? "text-bear" : 
            "text-foreground"
          )}>
            {regime?.regime ? regime.regime.replaceAll("_", " ") : "?"}
          </span>
        </Tooltip>
        <span className="flex items-center gap-1.5 cursor-help" title="Scheduler: Background job status for scans and ticks">
          SCHEDULER
          <div className="flex items-center gap-1.5 bg-foreground/5 px-2 py-0.5 rounded-full">
            <StatusLed status={status?.schedulerRunning ? "ok" : "error"} />
            <span className={cn("font-normal text-[10px]", status?.schedulerRunning ? "text-bull" : "text-bear")}>
              {status?.schedulerRunning ? "ON" : "OFF"}
            </span>
          </div>
        </span>
        <span className="flex items-center gap-1.5 cursor-help" title="Network: WebSocket real-time connection status">
          NETWORK
          <div className="flex items-center gap-1.5 bg-foreground/5 px-2 py-0.5 rounded-full">
            <StatusLed status={wsConnected ? "ok" : "error"} />
            <span className={cn("font-normal text-[10px]", wsConnected ? "text-bull" : "text-bear")}>
              {wsConnected ? "OK" : "ERR"}
            </span>
          </div>
        </span>
      </div>
      
      {macro && (
        <div className="flex items-center gap-3 sm:gap-4 ml-auto text-muted-foreground pl-6 shrink-0">
          <span className="font-normal text-foreground hidden sm:inline">INDIAN CONTEXT</span>
          <span className="font-normal text-foreground sm:hidden">MACRO</span>
          
          {macro.fiiDii ? (
            <div className="flex items-center gap-1.5">
              <span>FII:</span>
              <span className={cn("font-normal flex items-center gap-0.5", macro.fiiDii.fiiNetInr < 0 ? "text-bear" : "text-bull")}>
                {macro.fiiDii.fiiNetInr > 0 ? <ArrowUpRight className="h-3 w-3" /> : macro.fiiDii.fiiNetInr < 0 ? <ArrowDownRight className="h-3 w-3" /> : null}
                {fmtNum(Math.abs(macro.fiiDii.fiiNetInr))}Cr
              </span>
              <span className="mx-1.5 w-[3px] h-[3px] rounded-full bg-foreground/10 shrink-0" />
              <span>DII:</span>
              <span className={cn("font-normal flex items-center gap-0.5", macro.fiiDii.diiNetInr < 0 ? "text-bear" : "text-bull")}>
                {macro.fiiDii.diiNetInr > 0 ? <ArrowUpRight className="h-3 w-3" /> : macro.fiiDii.diiNetInr < 0 ? <ArrowDownRight className="h-3 w-3" /> : null}
                {fmtNum(Math.abs(macro.fiiDii.diiNetInr))}Cr
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 text-muted-foreground/50">
              <span>FII/DII:</span>
              <span className="font-normal">N/A</span>
            </div>
          )}

          {macro.niftyOptionChain && (
            <div className="hidden md:flex items-center gap-1.5">
              <span className="mx-1.5 w-[3px] h-[3px] rounded-full bg-foreground/10 shrink-0" />
              <span>PCR:</span>
              <span className={cn("font-normal", macro.niftyOptionChain.pcr > 1.2 ? "text-bull" : macro.niftyOptionChain.pcr < 0.7 ? "text-bear" : "text-foreground")}>
                {toFixed(macro.niftyOptionChain.pcr, 2)}
              </span>
              <span className="mx-1.5 w-[3px] h-[3px] rounded-full bg-foreground/10 shrink-0 hidden lg:inline-block" />
              <span className="hidden lg:inline">MAX PAIN:</span>
              <span className="font-normal text-foreground hidden lg:inline">
                {fmtNum(macro.niftyOptionChain.maxPain)}
              </span>
            </div>
          )}

          <span className="mx-1.5 w-[3px] h-[3px] rounded-full bg-foreground/10 shrink-0" />
          <div className="flex items-center gap-1.5">
            <span>USD/INR:</span>
            <span className={cn("font-normal", macro.usdInr > 86.0 ? "text-bear" : "text-foreground")}>
              {macro.usdInr ? toFixed(macro.usdInr, 2) : "—"}
            </span>
            <span className="mx-1.5 w-[3px] h-[3px] rounded-full bg-foreground/10 shrink-0 hidden lg:inline-block" />
            <span className="hidden lg:inline">IN10Y:</span>
            <span
              title={macro.india10yIsEstimate ? "Estimated from RBI repo rate — no free live 10Y feed" : undefined}
              className={cn("font-normal hidden lg:inline", macro.india10y > 7.2 ? "text-bear" : "text-foreground")}
            >
              {macro.india10y ? `${macro.india10yIsEstimate ? "~" : ""}${toFixed(macro.india10y, 2)}%` : "—"}
            </span>
          </div>

          <span className="mx-1.5 w-[3px] h-[3px] rounded-full bg-foreground/10 shrink-0" />
          <div className="flex items-center gap-1.5">
            <span>RISK:</span>
            {macro.eventRiskActive ? (
              <span className="bg-bear/20 text-bear px-1.5 py-0.5 rounded font-normal animate-pulse">ELEVATED</span>
            ) : (
              <span className="text-bull font-normal">NORMAL</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
});
