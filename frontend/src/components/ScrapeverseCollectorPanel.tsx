import { useQuery } from "@tanstack/react-query";
import { Activity, AlertTriangle, CheckCircle2, Database, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import { fmtNum } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/mimir/card";

function formatDate(value: string | null | undefined): string {
  if (!value) return "N/A";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

function signedValue(value: number): string {
  return `${value >= 0 ? "+" : ""}${fmtNum(value, 2)} Cr`;
}

export function ScrapeverseCollectorPanel() {
  const healthQuery = useQuery({
    queryKey: ["scrapeverse", "fii-dii", "health"],
    queryFn: api.scrapeverse.fiiDiiHealth,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const latestQuery = useQuery({
    queryKey: ["scrapeverse", "fii-dii", "latest"],
    queryFn: api.scrapeverse.fiiDiiLatest,
    refetchInterval: 5 * 60_000,
    staleTime: 2 * 60_000,
  });

  const health = healthQuery.data;
  const rows = latestQuery.data?.rows ?? [];
  const fii = rows.find((row) => row.category === "FII_FPI");
  const dii = rows.find((row) => row.category === "DII");
  const configured = health?.configured ?? false;
  const lastRun = health?.lastRun;
  const success = lastRun?.status === "SUCCEEDED";
  const loading = healthQuery.isLoading || latestQuery.isLoading;

  return (
    <Card className="border-border/60 bg-card/70 shadow-sm">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-sm font-semibold tracking-tight">
              <Activity className="h-4 w-4 text-cyan-400" />
              Scrapeverse · FII/DII
            </CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">Bright Data Scraper Studio · provisional post-market flow</p>
          </div>
          <div className={cn("flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider", success ? "text-emerald-400" : configured ? "text-amber-400" : "text-muted-foreground")}>
            {success ? <CheckCircle2 className="h-3.5 w-3.5" /> : configured ? <AlertTriangle className="h-3.5 w-3.5" /> : <Database className="h-3.5 w-3.5" />}
            {success ? "validated" : configured ? "degraded" : "not configured"}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="h-16 animate-pulse rounded-md bg-muted/40" />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-md border border-border/50 bg-background/40 p-3">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">FII/FPI net</div>
                <div className={cn("mt-1 text-lg font-semibold tabular-nums", fii && fii.netCrore >= 0 ? "text-emerald-400" : "text-rose-400")}>
                  {fii ? signedValue(fii.netCrore) : "N/A"}
                </div>
              </div>
              <div className="rounded-md border border-border/50 bg-background/40 p-3">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">DII net</div>
                <div className={cn("mt-1 text-lg font-semibold tabular-nums", dii && dii.netCrore >= 0 ? "text-emerald-400" : "text-rose-400")}>
                  {dii ? signedValue(dii.netCrore) : "N/A"}
                </div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs text-muted-foreground">
              <div className="flex items-center justify-between gap-2"><span>Data as of</span><span className="text-foreground">{fii?.dataAsOf ?? dii?.dataAsOf ?? "N/A"}</span></div>
              <div className="flex items-center justify-between gap-2"><span>Scraped</span><span className="text-foreground">{formatDate(fii?.scrapedAt ?? dii?.scrapedAt)}</span></div>
              <div className="flex items-center justify-between gap-2"><span>Recent completeness</span><span className="text-foreground">{health?.recentCompletenessRate == null ? "N/A" : `${Math.round(health.recentCompletenessRate * 100)}%`}</span></div>
              <div className="flex items-center justify-between gap-2"><span>Last run</span><span className="text-foreground">{lastRun ? formatDate(lastRun.completedAt ?? lastRun.startedAt) : "N/A"}</span></div>
            </div>
            {!configured && (
              <div className="rounded-md border border-dashed border-border/70 bg-muted/20 p-3 text-xs leading-relaxed text-muted-foreground">
                Live Scraper Studio access is not configured. No collector ID or live FII/DII values are being invented. Configure `BRIGHT_DATA_API_TOKEN` and `BRIGHT_DATA_FII_DII_COLLECTOR_ID` after publishing the collector.
              </div>
            )}
            {configured && lastRun?.lastError && (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs leading-relaxed text-amber-200">
                Latest collector issue: {lastRun.lastError}
              </div>
            )}
            {healthQuery.isFetching || latestQuery.isFetching ? <RefreshCw className="ml-auto h-3.5 w-3.5 animate-spin text-muted-foreground" /> : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
