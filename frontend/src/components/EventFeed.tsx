import { memo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Bell, Info, CheckCircle2, AlertTriangle, XCircle, Trash2 } from "lucide-react";
import { useStore, type AppEvent } from "@/store/useStore";

const typeConfig: Record<AppEvent["type"], { icon: typeof Info; color: string }> = {
  info:    { icon: Info,          color: "text-blue-400" },
  success: { icon: CheckCircle2,  color: "text-[#34C759]" },
  warning: { icon: AlertTriangle, color: "text-amber-400" },
  error:   { icon: XCircle,       color: "text-red-500" },
};

function formatRelativeTime(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function EventItem({ event }: { event: AppEvent }) {
  const config = typeConfig[event.type] ?? typeConfig.info;
  const Icon = config.icon;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, height: 0, y: -8 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      className="flex items-start gap-3 py-3.5 first:pt-1 last:pb-1"
    >
      <div className={`shrink-0 mt-0.5 ${config.color}`}>
        <Icon className="h-4 w-4 stroke-[2.2]" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[13px] font-semibold text-foreground tracking-tight truncate">
            {event.symbol && (
              <span className="font-bold text-primary mr-1.5">{event.symbol}</span>
            )}
            {event.title}
          </span>
          <span className="text-[11px] font-medium text-muted-foreground/70 shrink-0 tabular-nums">
            {formatRelativeTime(event.timestamp)}
          </span>
        </div>
        {event.message && (
          <p 
            className="text-[12px] font-normal text-foreground/80 mt-1 leading-relaxed break-words line-clamp-3"
            title={event.message}
          >
            {event.message}
          </p>
        )}
      </div>
    </motion.div>
  );
}



export const EventFeed = memo(function EventFeed() {
  const events = useStore((s) => s.events);
  const clearEvents = useStore((s) => s.clearEvents);

  return (
    <div className="flex flex-col w-full text-left" style={{ width: 340, maxHeight: 420 }}>
      {/* Header */}
      <div className="shrink-0 flex items-center justify-between px-4 py-3 border-b border-border/30">
        <div>
          <h2 className="text-[15px] font-semibold text-foreground tracking-tight">Activity Feed</h2>
          <p className="text-[11px] font-medium text-muted-foreground mt-0.5">
            {events.length} event{events.length !== 1 ? "s" : ""}
          </p>
        </div>
        <div className="flex items-center gap-1">
          {events.length > 0 && (
            <button
              onClick={clearEvents}
              className="p-1.5 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
              title="Clear all events"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {/* Event List without boxes */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden px-4 py-2 divide-y divide-border/30" style={{ maxHeight: 360 }}>
        {events.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <div className="p-3 rounded-full bg-white/[0.03] mb-3">
              <Bell className="h-6 w-6 text-muted-foreground/40" />
            </div>
            <p className="text-[13px] font-semibold text-muted-foreground">No activity yet</p>
            <p className="text-[11px] font-medium text-muted-foreground/60 mt-1">
              Events will appear here as the system runs
            </p>
          </div>
        ) : (
          <AnimatePresence initial={false}>
            {events.map((event) => (
              <EventItem key={event.id} event={event} />
            ))}
          </AnimatePresence>
        )}
      </div>
    </div>
  );
});
