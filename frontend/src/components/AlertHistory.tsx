import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Bell, AlertCircle, TrendingUp, TrendingDown, Target, Zap } from "lucide-react";
import { cn } from "@/lib/format";

import { api } from "@/lib/api";

interface AlertHistoryItem {
  id?: string | number;
  type: string;
  symbol?: string;
  message?: string;
  createdAt?: string;
  timestamp?: string;
}

function formatAlertTime(alert: AlertHistoryItem): string {
  const value = alert.timestamp ?? alert.createdAt;
  if (!value) return "";
  return new Date(value).toLocaleTimeString("en-US", { hour12: false });
}

export const AlertHistory = () => {
  const query = useQuery({
    queryKey: ["alerts"],
    queryFn: () => api.alertsHistory(),
    refetchInterval: 10000,
  });

  const alerts = (query.data || []) as AlertHistoryItem[];

  if (query.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <span className="text-sm text-muted-foreground animate-pulse">Loading alerts...</span>
      </div>
    );
  }

  if (alerts.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center opacity-50">
        <Bell className="mb-2 h-8 w-8 text-muted-foreground" />
        <span className="text-sm font-medium">No recent alerts</span>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b border-border/50 pb-2 mb-2 shrink-0">
        <Bell className="h-4 w-4 text-accent" />
        <h3 className="text-sm font-semibold">Alert History</h3>
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">
          {alerts.length} events
        </span>
      </div>
      
      <div className="flex-1 overflow-y-auto pr-1 space-y-2">
        {alerts.map((alert, i) => {
          const isPositive = alert.type.includes("BULL") || alert.type.includes("GREEN") || alert.type.includes("SUPPORT");
          const isNegative = alert.type.includes("BEAR") || alert.type.includes("RED") || alert.type.includes("RESISTANCE") || alert.type.includes("OVERSOLD");

          let Icon = AlertCircle;
          if (alert.type.includes("MTF")) Icon = Zap;
          if (alert.type.includes("VWAP")) Icon = Target;
          if (alert.type.includes("COMPOSITE")) Icon = isPositive ? TrendingUp : TrendingDown;

          return (
            <motion.div
              key={alert.id || i}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: Math.min(i * 0.05, 0.5) }}
              className="flex items-start gap-2 rounded border border-border/50 bg-background/50 p-2 text-sm relative overflow-hidden"
            >
              <div
                className={cn(
                  "absolute left-0 top-0 bottom-0 w-1",
                  isPositive ? "bg-bull/50" : isNegative ? "bg-bear/50" : "bg-accent/50"
                )}
              />
              <div className="pl-1 shrink-0 mt-0.5">
                <Icon className={cn("h-3.5 w-3.5", isPositive ? "text-bull" : isNegative ? "text-bear" : "text-accent")} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-bold text-foreground">{alert.symbol}</span>
                  <span className="text-[9px] text-muted-foreground whitespace-nowrap tabular-nums">
                    {formatAlertTime(alert)}
                  </span>
                </div>
                <div className="text-xs text-foreground/80 mt-0.5 leading-tight">
                  {alert.message}
                </div>
              </div>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
};
