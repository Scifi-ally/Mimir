import { useState, useMemo, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import { X, RefreshCw, Calendar, ChevronLeft, ChevronRight, Sparkles } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "@/lib/api";
import { FADE_FAST, FADE_SLOW } from "@/lib/motion";
import { Skeleton } from "@/components/atoms/Skeleton";
import { Button } from "@/components/mimir/button";
import { cn } from "@/lib/format";

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

// Custom borderless, boxless markdown renderers
const borderlessMarkdownComponents = {
  h1: ({ children }: any) => (
    <h1 className="text-2xl font-bold tracking-tight text-slate-200 mt-2 mb-6 m-0 flex items-center gap-3">
      {children}
    </h1>
  ),
  h3: ({ children }: any) => (
    <div className="flex items-center gap-2.5 mt-8 mb-3 pb-1 border-b border-border/10">
      <span className="w-1.5 h-1.5 rounded-full bg-slate-400 shrink-0" />
      <h3 className="text-xs font-mono tracking-wider uppercase text-slate-400 font-bold m-0">{children}</h3>
    </div>
  ),
  table: ({ children }: any) => (
    <div className="my-4 overflow-x-auto">
      <table className="w-full text-left text-xs font-mono border-collapse">{children}</table>
    </div>
  ),
  thead: ({ children }: any) => (
    <thead className="border-b border-border/15 text-[10px] uppercase font-mono tracking-wider text-slate-400">{children}</thead>
  ),
  tr: ({ children }: any) => (
    <tr className="border-b border-border/5 last:border-0 hover:bg-foreground/[0.02] transition-colors">{children}</tr>
  ),
  th: ({ children }: any) => (
    <th className="py-2.5 pr-6 font-semibold">{children}</th>
  ),
  td: ({ children }: any) => {
    const text = String(children || "");
    const isPos = text.includes("+") || (text.includes("Cr") && !text.includes("-"));
    const isNeg = text.includes("-");
    return (
      <td className="py-2.5 pr-6 font-mono text-xs">
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
    <div className="my-6 pl-4 border-l-2 border-slate-500 py-1.5 text-foreground/90 font-mono text-sm flex items-center gap-3">
      <Sparkles className="w-4 h-4 text-slate-400 shrink-0" />
      <div className="font-medium">{children}</div>
    </div>
  ),
  ul: ({ children }: any) => (
    <ul className="my-3 space-y-2 pl-0 list-none">{children}</ul>
  ),
  li: ({ children }: any) => (
    <li className="flex items-start gap-2.5 py-1 text-xs font-sans text-foreground/80">
      <span className="w-1.5 h-1.5 rounded-full bg-slate-500/80 mt-1.5 shrink-0" />
      <div className="flex-1 min-w-0">{children}</div>
    </li>
  ),
};

// Apple Calendar Component (matching Apple Dark Theme Calendar)
function AppleCalendarCard({ 
  selectedDate, 
  onSelectDate, 
  availableDates 
}: { 
  selectedDate: string; 
  onSelectDate: (dateStr: string) => void;
  availableDates: Set<string>;
}) {
  const parsed = selectedDate ? new Date(selectedDate) : new Date();
  const [viewDate, setViewDate] = useState(() => isNaN(parsed.getTime()) ? new Date() : parsed);

  useEffect(() => {
    const p = selectedDate ? new Date(selectedDate) : new Date();
    if (!isNaN(p.getTime())) setViewDate(p);
  }, [selectedDate]);

  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();

  const monthName = viewDate.toLocaleString('default', { month: 'long' }).toUpperCase();

  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const prevMonthDays = Array.from({ length: firstDay });
  const currentMonthDays = Array.from({ length: daysInMonth }, (_, i) => i + 1);

  const formatYMD = (d: number) => {
    const mm = String(month + 1).padStart(2, '0');
    const dd = String(d).padStart(2, '0');
    return `${year}-${mm}-${dd}`;
  };

  const handlePrevMonth = (e: React.MouseEvent) => {
    e.stopPropagation();
    setViewDate(new Date(year, month - 1, 1));
  };
  
  const handleNextMonth = (e: React.MouseEvent) => {
    e.stopPropagation();
    setViewDate(new Date(year, month + 1, 1));
  };

  return (
    <div className="w-72 p-5 rounded-3xl bg-[#1c1c1e] text-white shadow-2xl border border-white/10 select-none font-sans">
      {/* Month Header */}
      <div className="flex items-center justify-between mb-4 px-1">
        <span className="text-xs font-bold tracking-wider text-rose-500 uppercase font-mono">
          {monthName} {year}
        </span>
        <div className="flex items-center gap-1">
          <button onClick={handlePrevMonth} className="p-1.5 rounded-full hover:bg-white/10 text-white/70 hover:text-white transition-colors">
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button onClick={handleNextMonth} className="p-1.5 rounded-full hover:bg-white/10 text-white/70 hover:text-white transition-colors">
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Weekday Headers */}
      <div className="grid grid-cols-7 gap-1 text-center mb-2">
        {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((day, idx) => (
          <span key={idx} className="text-[11px] font-semibold text-white/40">
            {day}
          </span>
        ))}
      </div>

      {/* Days Grid */}
      <div className="grid grid-cols-7 gap-1 text-center text-xs font-mono">
        {prevMonthDays.map((_, i) => (
          <div key={`prev-${i}`} className="h-8" />
        ))}

        {currentMonthDays.map((d) => {
          const dateStr = formatYMD(d);
          const isSelected = dateStr === selectedDate;
          const hasReport = availableDates.has(dateStr);

          return (
            <button
              key={d}
              onClick={(e) => {
                e.stopPropagation();
                onSelectDate(dateStr);
              }}
              className={cn(
                "relative h-8 w-8 mx-auto flex items-center justify-center rounded-full transition-all text-xs font-medium",
                isSelected
                  ? "bg-rose-500 text-white font-bold shadow-md shadow-rose-500/40"
                  : hasReport
                  ? "text-white font-bold hover:bg-white/15"
                  : "text-white/40 hover:bg-white/10"
              )}
            >
              {d}
              {hasReport && !isSelected && (
                <span className="absolute bottom-1 w-1 h-1 rounded-full bg-rose-500" />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function ReportsLibrary({ isOpen, onClose }: ReportsLibraryProps) {
  const queryClient = useQueryClient();
  const [selectedDate, setSelectedDate] = useState<string>("");
  const [isCalendarOpen, setIsCalendarOpen] = useState(false);
  const calendarRef = useRef<HTMLDivElement>(null);

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

  const reports: DailyReport[] = reportsQuery.data ?? [];

  // Index reports by date (normalized YYYY-MM-DD)
  const reportsByDate = useMemo(() => {
    const map = new Map<string, DailyReport>();
    reports.forEach((r) => {
      const dateKey = (r.date || "").split("T")[0].trim();
      if (dateKey) map.set(dateKey, r);
    });
    return map;
  }, [reports]);

  const availableDates = useMemo(() => new Set(reportsByDate.keys()), [reportsByDate]);

  // Set default date to latest report date ONCE when reports load
  useEffect(() => {
    if (reports.length > 0 && !selectedDate) {
      const latestDate = (reports[0].date || "").split("T")[0].trim();
      setSelectedDate(latestDate);
    }
  }, [reports, selectedDate]);

  // Close calendar popover on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (calendarRef.current && !calendarRef.current.contains(event.target as Node)) {
        setIsCalendarOpen(false);
      }
    };
    if (isCalendarOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isCalendarOpen]);

  // Query single date report on-demand if missing from local map
  const singleDateReportQuery = useQuery({
    queryKey: ["report-by-date", selectedDate],
    queryFn: async () => {
      const res = await api.reportByDate(selectedDate);
      queryClient.invalidateQueries({ queryKey: ["reports"] });
      return res;
    },
    enabled: Boolean(isOpen && selectedDate && !reportsByDate.has(selectedDate)),
    retry: false,
  });

  const activeReport = (selectedDate ? reportsByDate.get(selectedDate) : null) ?? singleDateReportQuery.data ?? reports[0];

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
            className="fixed left-1/2 bottom-0 z-[70] flex flex-col bg-background text-foreground h-[86vh] w-full max-w-4xl rounded-t-3xl shadow-[0_-8px_40px_rgba(0,0,0,0.08)] dark:shadow-[0_-8px_40px_rgba(0,0,0,0.4)] border border-b-0 border-foreground/5 ring-0 outline-none"
          >
            {/* Side-Docked Apple Calendar (Positioned to the LEFT side of the panel outside the modal) */}
            <div ref={calendarRef} className="absolute left-0 top-0 h-full">
              <AnimatePresence>
                {isCalendarOpen && (
                  <motion.div
                    initial={{ opacity: 0, x: 20, scale: 0.94 }}
                    animate={{ opacity: 1, x: 0, scale: 1 }}
                    exit={{ opacity: 0, x: 20, scale: 0.94 }}
                    transition={{ type: "spring", stiffness: 300, damping: 28 }}
                    className="absolute -left-[304px] top-6 z-[80] hidden lg:block"
                  >
                    <AppleCalendarCard
                      selectedDate={selectedDate}
                      onSelectDate={(d) => {
                        setSelectedDate(d);
                        setIsCalendarOpen(false);
                      }}
                      availableDates={availableDates}
                    />
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Header */}
            <div className="relative px-8 pt-6 pb-4 flex items-center justify-between shrink-0 border-b border-border/10">
              <div className="flex items-center gap-3">
                <h2 className="text-[10px] font-mono font-normal tracking-[0.08em] uppercase text-muted-foreground">
                  Daily Reports
                </h2>

                {/* Calendar Side-Dock Trigger Button */}
                <button
                  onClick={() => setIsCalendarOpen(!isCalendarOpen)}
                  className="flex items-center gap-2 px-3 py-1 rounded-full bg-rose-500/10 hover:bg-rose-500/20 text-rose-500 text-xs font-mono font-semibold transition-all border border-rose-500/20 active:scale-95"
                >
                  <Calendar className="w-3.5 h-3.5 text-rose-500" />
                  <span>{selectedDate || "Select Date"}</span>
                  <ChevronLeft className={cn("w-3.5 h-3.5 text-rose-500 transition-transform duration-300", isCalendarOpen ? "rotate-90" : "-rotate-90")} />
                </button>
              </div>

              <div className="flex items-center gap-3">
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

            {/* Mobile Calendar Popover Fallback (For small screens) */}
            <AnimatePresence>
              {isCalendarOpen && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  className="block lg:hidden border-b border-border/10 bg-[#1c1c1e] p-4 flex justify-center shrink-0"
                >
                  <AppleCalendarCard
                    selectedDate={selectedDate}
                    onSelectDate={(d) => {
                      setSelectedDate(d);
                      setIsCalendarOpen(false);
                    }}
                    availableDates={availableDates}
                  />
                </motion.div>
              )}
            </AnimatePresence>

            {/* Report Body: Completely Borderless, Boxless View */}
            <div className="flex-1 overflow-y-auto px-10 py-8 flex flex-col">
              {reportsQuery.isPending ? (
                <div className="flex flex-col gap-4 pt-2">
                  <Skeleton className="h-6 w-48" />
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-32 w-full mt-4" />
                </div>
              ) : reportsQuery.isError ? (
                <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground">
                  <p className="text-sm text-destructive font-mono">{reportsQuery.error?.message ?? "Failed to load reports"}</p>
                </div>
              ) : !activeReport ? (
                <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground py-16">
                  <p className="text-sm font-normal text-foreground/60">No report available for {selectedDate}</p>
                </div>
              ) : (
                <div className="flex flex-col">
                  {/* Date Title Header */}
                  <div className="mb-6">
                    <span className="text-xs font-mono font-semibold text-rose-500 uppercase tracking-wider">
                      {activeReport.date}
                    </span>
                    {activeReport.summary && (
                      <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">{activeReport.summary}</p>
                    )}
                  </div>

                  {/* Borderless Markdown Body */}
                  <div className="max-w-none text-foreground/90 font-sans">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={borderlessMarkdownComponents}
                    >
                      {activeReport.content?.replace(/\\n/g, '\n')}
                    </ReactMarkdown>
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
