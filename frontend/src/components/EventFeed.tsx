import { memo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Info, CheckCircle2, AlertTriangle, XCircle, Trash2 } from "lucide-react";
import { useStore, type AppEvent } from "@/store/useStore";
import { SPRING_SNAPPY } from "@/lib/motion";

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
      initial={{ opacity: 0, y: 6, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, height: 0, y: -4, scale: 0.96 }}
      transition={SPRING_SNAPPY}
      className="flex items-start gap-2.5 py-3 first:pt-0.5 last:pb-0.5"
    >
      <div className={`shrink-0 mt-0.5 ${config.color} opacity-80`}>
        <Icon className="h-3.5 w-3.5 stroke-[2]" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[12px] font-normal text-foreground/90 tracking-tight truncate leading-tight">
            {event.symbol && (
              <span className="font-normal text-primary mr-1">{event.symbol}</span>
            )}
            {event.title}
          </span>
          <span className="text-[10px] font-normal text-muted-foreground/50 shrink-0 tabular-nums">
            {formatRelativeTime(event.timestamp)}
          </span>
        </div>
        {event.message && (
          <p
            className="text-[11px] text-foreground/60 mt-0.5 leading-snug break-words line-clamp-2"
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
    <div className="flex flex-col w-full text-left" style={{ width: 320, maxHeight: 400 }}>
      <div className="shrink-0 flex items-center justify-between px-4 py-3">
        <div>
          <h2 className="text-[13px] font-normal text-foreground tracking-tight">Activity</h2>
          <p className="text-[10px] text-muted-foreground/60 mt-0.5">
            {events.length} event{events.length !== 1 ? "s" : ""}
          </p>
        </div>
        {events.length > 0 && (
          <button
            onClick={clearEvents}
            className="p-1.5 rounded-lg text-muted-foreground/40 hover:text-destructive hover:bg-destructive/10 transition-all duration-200"
            title="Clear all events"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto overflow-x-hidden px-4 pb-3 space-y-0.5" style={{ maxHeight: 350 }}>
        {events.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <p className="text-[11px] font-normal text-muted-foreground/50">No events yet</p>
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
