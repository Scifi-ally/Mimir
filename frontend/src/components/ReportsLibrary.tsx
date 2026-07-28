import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import { X, RefreshCw, BarChart3, TrendingUp, Layers, Zap, Wallet, Bell, FileText, Calendar, Sparkles } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "@/lib/api";
import { FADE_FAST, FADE_SLOW } from "@/lib/motion";
import { Skeleton } from "@/components/atoms/Skeleton";
import { Button } from "@/components/mimir/button";

interface ReportsLibraryProps {
  isOpen: boolean;
  onClose: () => void;
}

interface DailyReport {
  id: string;
  date: string;
  summary: string;
  content: string;
  createdAt: string;
}

// Custom aesthetic renderers for markdown reports
const customMarkdownComponents = {
  h1: ({ children }: any) => (
    <div className="flex items-center gap-3 pb-4 mb-6 border-b border-border/10">
      <div className="p-2 rounded-xl bg-primary/10 text-primary">
        <FileText className="w-5 h-5" />
      </div>
      <h1 className="text-xl font-medium tracking-tight text-foreground m-0">{children}</h1>
    </div>
  ),
  h3: ({ children }: any) => {
    const text = String(children || "");
    let icon = <BarChart3 className="w-4 h-4 text-primary" />;
    if (text.includes("Market Overview")) icon = <TrendingUp className="w-4 h-4 text-bull" />;
    else if (text.includes("Sector")) icon = <Layers className="w-4 h-4 text-primary" />;
    else if (text.includes("Signals")) icon = <Zap className="w-4 h-4 text-amber-500" />;
    else if (text.includes("Paper Trades")) icon = <Wallet className="w-4 h-4 text-bull" />;
    else if (text.includes("Alerts")) icon = <Bell className="w-4 h-4 text-primary" />;

    return (
      <div className="flex items-center gap-2.5 mt-8 mb-4">
        <div className="p-1.5 rounded-lg bg-foreground/5">{icon}</div>
        <h3 className="text-sm font-mono tracking-wider uppercase text-foreground/90 font-semibold m-0">{children}</h3>
      </div>
    );
  },
  table: ({ children }: any) => (
    <div className="my-4 overflow-hidden rounded-2xl border border-border/10 bg-foreground/[0.02] shadow-sm">
      <table className="w-full text-left text-xs font-sans border-collapse">{children}</table>
    </div>
  ),
  thead: ({ children }: any) => (
    <thead className="bg-foreground/[0.04] border-b border-border/10 text-[10px] uppercase font-mono tracking-wider text-muted-foreground">{children}</thead>
  ),
  tr: ({ children }: any) => (
    <tr className="border-b border-border/5 last:border-0 hover:bg-foreground/[0.03] transition-colors">{children}</tr>
  ),
  th: ({ children }: any) => (
    <th className="px-4 py-3 font-medium text-muted-foreground">{children}</th>
  ),
  td: ({ children }: any) => {
    const text = String(children || "");
    const isPos = text.includes("+") || (text.includes("Cr") && !text.includes("-"));
    const isNeg = text.includes("-");
    return (
      <td className="px-4 py-3 font-mono text-xs">
        {isPos && (text.includes("%") || text.includes("Cr")) ? (
          <span className="text-bull font-medium">{children}</span>
        ) : isNeg && (text.includes("%") || text.includes("Cr") || text.includes("-")) ? (
          <span className="text-bear font-medium">{children}</span>
        ) : (
          <span className="text-foreground/90">{children}</span>
        )}
      </td>
    );
  },
  blockquote: ({ children }: any) => (
    <div className="my-6 p-4 rounded-xl bg-gradient-to-r from-bull/10 via-bull/5 to-transparent border border-bull/20 text-bull font-mono text-sm flex items-center gap-3">
      <Sparkles className="w-5 h-5 shrink-0" />
      <div className="font-semibold">{children}</div>
    </div>
  ),
  ul: ({ children }: any) => (
    <ul className="my-3 space-y-2 pl-0 list-none">{children}</ul>
  ),
  li: ({ children }: any) => (
    <li className="flex items-center gap-2 p-3 rounded-xl bg-foreground/[0.02] border border-border/10 text-xs font-sans text-foreground/80 hover:border-border/20 transition-colors">
      <div className="w-1.5 h-1.5 rounded-full bg-primary shrink-0" />
      <div className="flex-1 min-w-0">{children}</div>
    </li>
  ),
};

export function ReportsLibrary({ isOpen, onClose }: ReportsLibraryProps) {
  const queryClient = useQueryClient();

  const reportsQuery = useQuery({
    queryKey: ["reports"],
    queryFn: () => api.reports(),
    enabled: isOpen,
  });

  const generateMutation = useMutation({
    mutationFn: () => api.generateReport(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["reports"] });
    },
  });

  const reports = reportsQuery.data ?? [];

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={FADE_FAST}
            className="fixed inset-0 z-[60] bg-background/80"
            onClick={onClose}
          />

          {/* Modal Panel */}
          <motion.div
            initial={{ y: "100%", x: "-50%" }}
            animate={{ y: 0, x: "-50%" }}
            exit={{ y: "100%", x: "-50%" }}
            transition={FADE_SLOW}
            className="fixed left-1/2 bottom-0 z-[70] flex flex-col bg-background text-foreground overflow-hidden h-[86vh] w-full max-w-4xl rounded-t-3xl shadow-[0_-8px_40px_rgba(0,0,0,0.08)] dark:shadow-[0_-8px_40px_rgba(0,0,0,0.4)] border border-b-0 border-foreground/5 ring-0 outline-none"
          >
            {/* Header */}
            <div className="relative px-8 pt-6 pb-4 flex flex-col sm:flex-row items-center justify-between shrink-0 border-b border-border/10">
              <h2 className="text-[10px] font-mono font-normal tracking-[0.08em] uppercase text-muted-foreground flex items-center gap-2">
                Daily Reports
                <span className="text-foreground/40 hidden sm:inline ml-2">— End of day market summaries</span>
              </h2>

              <div className="absolute right-6 top-5 z-10 flex items-center gap-3">
                <Button 
                  variant="outline" 
                  size="sm" 
                  className="hidden sm:flex text-xs h-8"
                  disabled={generateMutation.isPending}
                  onClick={() => generateMutation.mutate()}
                >
                  <RefreshCw className={`w-3.5 h-3.5 mr-2 ${generateMutation.isPending ? 'animate-spin' : ''}`} />
                  {generateMutation.isPending ? 'Generating...' : 'Generate Today'}
                </Button>
                <button
                  onClick={onClose}
                  className="p-2 rounded-full hover:bg-secondary/60 text-muted-foreground hover:text-foreground transition-all duration-200"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto px-8 py-6 flex flex-col">
              {reportsQuery.isPending ? (
                <div className="flex flex-col gap-3 pt-2">
                  {[0, 1, 2, 3, 4].map((i) => (
                    <div key={i} className="flex flex-col gap-2 rounded-xl border border-border/10 p-4">
                      <div className="flex items-center justify-between">
                        <Skeleton className="h-3.5 w-32" />
                        <Skeleton className="h-2.5 w-20" />
                      </div>
                      <Skeleton className="h-2.5 w-full max-w-lg" />
                      <Skeleton className="h-2.5 w-2/3" />
                    </div>
                  ))}
                </div>
              ) : reportsQuery.isError ? (
                <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground">
                  <p className="text-sm text-destructive font-mono">{reportsQuery.error?.message ?? "Failed to load reports"}</p>
                </div>
              ) : reports.length === 0 ? (
                <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground">
                  <p className="text-sm font-normal text-foreground/60">No reports generated yet</p>
                </div>
              ) : (
                <div className="flex flex-col gap-8">
                  {reports.map((report: DailyReport) => (
                    <div key={report.id} className="p-6 rounded-2xl border border-border/10 bg-foreground/[0.01] hover:bg-foreground/[0.015] transition-all duration-200 shadow-sm">
                      <div className="flex items-center justify-between gap-4 mb-4 pb-4 border-b border-border/10">
                        <div className="flex items-center gap-3">
                          <div className="p-2 rounded-xl bg-primary/10 text-primary">
                            <Calendar className="w-5 h-5" />
                          </div>
                          <div>
                            <h3 className="font-mono font-semibold text-lg text-foreground tracking-tight">
                              {report.date}
                            </h3>
                            {report.summary && (
                              <p className="text-xs text-muted-foreground mt-0.5">{report.summary}</p>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="max-w-none text-foreground/90">
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          components={customMarkdownComponents}
                        >
                          {report.content?.replace(/\\n/g, '\n')}
                        </ReactMarkdown>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
