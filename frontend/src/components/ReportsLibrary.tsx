import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import { X, RefreshCw } from "lucide-react";
import ReactMarkdown from "react-markdown";
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
            <div className="flex-1 overflow-y-auto px-8 py-4 flex flex-col">
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
                <div className="flex flex-col">
                  {reports.map((report: DailyReport) => (
                    <div key={report.id} className="py-8 border-b border-border/10 last:border-0">
                      <div className="flex items-center gap-3 mb-6">
                        <div className="w-1 h-6 bg-primary rounded-full" />
                        <h3 className="font-mono font-normal text-lg text-foreground flex items-center gap-2">
                          {report.date}
                        </h3>
                      </div>
                      {report.summary && (
                        <p className="text-sm text-muted-foreground mb-4 pl-4">{report.summary}</p>
                      )}
                      <div className="prose prose-sm dark:prose-invert prose-p:leading-relaxed prose-headings:font-normal prose-h1:text-xl prose-h2:text-lg prose-h3:text-base prose-a:text-primary max-w-none text-foreground/90 pl-4">
                        <ReactMarkdown>{report.content?.replace(/\\n/g, '\n')}</ReactMarkdown>
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
