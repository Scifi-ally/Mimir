import { useQuery } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import { X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { api } from "@/lib/api";

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
  const reportsQuery = useQuery({
    queryKey: ["reports"],
    queryFn: () => api.reports(),
    enabled: isOpen,
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
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-[60] bg-background/80"
            onClick={onClose}
          />

          {/* Modal Panel */}
          <motion.div
            initial={{ y: "100%", x: "-50%" }}
            animate={{ y: 0, x: "-50%" }}
            exit={{ y: "100%", x: "-50%" }}
            transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
            className="fixed left-1/2 bottom-0 z-[70] flex flex-col bg-background text-foreground overflow-hidden h-[86vh] w-full max-w-4xl rounded-t-3xl shadow-[0_-8px_40px_rgba(0,0,0,0.08)] dark:shadow-[0_-8px_40px_rgba(0,0,0,0.4)] border border-b-0 border-foreground/5 ring-0 outline-none"
          >
            {/* Header */}
            <div className="relative px-8 pt-6 pb-4 flex flex-col sm:flex-row items-center justify-between shrink-0 border-b border-border/10">
              <h2 className="text-[10px] font-mono font-bold tracking-widest uppercase text-muted-foreground flex items-center gap-2">
                Daily Reports
                <span className="text-foreground/40 hidden sm:inline ml-2">— End of day market summaries</span>
              </h2>

              <button
                onClick={onClose}
                className="absolute right-6 top-6 z-10 p-2 rounded-full hover:bg-secondary/60 text-muted-foreground hover:text-foreground transition-all duration-200"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto px-8 py-4 flex flex-col">
              {reportsQuery.isPending ? (
                <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground">
                  <div className="animate-pulse flex gap-2 items-center">
                    <div className="w-2 h-2 rounded-full bg-primary animate-bounce" />
                    <div className="w-2 h-2 rounded-full bg-primary animate-bounce delay-100" />
                    <div className="w-2 h-2 rounded-full bg-primary animate-bounce delay-200" />
                  </div>
                </div>
              ) : reportsQuery.isError ? (
                <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground">
                  <p className="text-sm text-destructive font-mono">{reportsQuery.error?.message ?? "Failed to load reports"}</p>
                </div>
              ) : reports.length === 0 ? (
                <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground">
                  <p className="text-base font-semibold text-foreground">No reports available yet.</p>
                </div>
              ) : (
                <div className="flex flex-col">
                  {reports.map((report: DailyReport) => (
                    <div key={report.id} className="py-8 border-b border-border/10 last:border-0">
                      <div className="flex items-center gap-3 mb-6">
                        <div className="w-1 h-6 bg-primary rounded-full" />
                        <h3 className="font-mono font-bold text-lg text-foreground flex items-center gap-2">
                          {report.date}
                        </h3>
                      </div>
                      {report.summary && (
                        <p className="text-sm text-muted-foreground mb-4 pl-4">{report.summary}</p>
                      )}
                      <div className="prose prose-sm dark:prose-invert prose-p:leading-relaxed prose-headings:font-bold prose-h1:text-xl prose-h2:text-lg prose-h3:text-base prose-a:text-primary max-w-none text-foreground/90 pl-4">
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
