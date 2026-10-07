import { memo, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Info, CheckCircle2, AlertTriangle, XCircle, Trash2, X } from "lucide-react";
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

interface EventItemProps {
  event: AppEvent;
  index: number;
  isClearingStacked: boolean;
  onDelete: (id: string) => void;
}

const itemVariants = {
  initial: { opacity: 0, y: 8, scale: 0.98 },
  animate: (custom: { isClearingStacked: boolean; index: number }) => {
    if (custom.isClearingStacked) {
      // Stacked delete animation: move one by one to the right
      return {
        x: 260,
        opacity: 0,
        scale: 0.94,
        transition: {
          delay: custom.index * 0.045,
          duration: 0.28,
          ease: [0.32, 0.72, 0, 1] as const,
        },
      };
    }
    return {
      x: 0,
      y: 0,
      opacity: 1,
      scale: 1,
      transition: SPRING_SNAPPY,
    };
  },
  exit: {
    // Single delete animation: slide left
    x: -260,
    opacity: 0,
    height: 0,
    paddingTop: 0,
    paddingBottom: 0,
    marginTop: 0,
    marginBottom: 0,
    transition: {
      duration: 0.24,
      ease: [0.32, 0.72, 0, 1] as const,
    },
  },
};

function EventItem({ event, index, isClearingStacked, onDelete }: EventItemProps) {
  const config = typeConfig[event.type] ?? typeConfig.info;
  const Icon = config.icon;

  return (
    <motion.div
      layout
      custom={{ isClearingStacked, index }}
      variants={itemVariants}
      initial="initial"
      animate="animate"
      exit="exit"
      drag="x"
      dragConstraints={{ left: 0, right: 0 }}
      dragElastic={{ left: 0.6, right: 0.05 }}
      onDragEnd={(_, info) => {
        if (info.offset.x < -45 || info.velocity.x < -250) {
          onDelete(event.id);
        }
      }}
      className="group relative flex items-start gap-2.5 py-2.5 px-2 rounded-lg hover:bg-foreground/[0.04] transition-colors duration-150 cursor-default select-none overflow-hidden"
    >
      <div className={`shrink-0 mt-0.5 ${config.color} opacity-80`}>
        <Icon className="h-3.5 w-3.5 stroke-[2]" />
      </div>
      <div className="flex-1 min-w-0 pr-1">
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

      <button
        onClick={(e) => {
          e.stopPropagation();
          onDelete(event.id);
        }}
        className="opacity-40 group-hover:opacity-100 focus:opacity-100 p-1 rounded-md text-muted-foreground/60 hover:text-destructive hover:bg-destructive/10 transition-all duration-150 shrink-0 self-center"
        title="Delete notification"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </motion.div>
  );
}

export const EventFeed = memo(function EventFeed() {
  const events = useStore((s) => s.events);
  const clearEvents = useStore((s) => s.clearEvents);
  const removeEvent = useStore((s) => s.removeEvent);

  const [isClearingStacked, setIsClearingStacked] = useState(false);

  const handleDelete = useCallback((id: string) => {
    removeEvent(id);
  }, [removeEvent]);

  const handleClearAll = useCallback(() => {
    if (events.length === 0 || isClearingStacked) return;
    setIsClearingStacked(true);
    // Staggered delay: wait for all stacked items to complete sliding to the right
    const totalTimeMs = Math.min(events.length * 45 + 280, 800);
    setTimeout(() => {
      clearEvents();
      setIsClearingStacked(false);
    }, totalTimeMs);
  }, [events.length, isClearingStacked, clearEvents]);

  return (
    <div className="flex flex-col w-full text-left" style={{ width: 330, maxHeight: 420 }}>
      <div className="shrink-0 flex items-center justify-between px-4 py-3 border-b border-border/10">
        <div>
          <h2 className="text-[13px] font-medium text-foreground tracking-tight">Notifications</h2>
          <p className="text-[10px] text-muted-foreground/60 mt-0.5">
            {events.length} {events.length === 1 ? "notification" : "notifications stacked"}
          </p>
        </div>
        {events.length > 0 && (
          <button
            onClick={handleClearAll}
            disabled={isClearingStacked}
            className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-normal text-muted-foreground/60 hover:text-destructive hover:bg-destructive/10 transition-all duration-200"
            title="Clear all stacked notifications"
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span>Clear all</span>
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto overflow-x-hidden px-2 py-2 space-y-0.5" style={{ maxHeight: 350 }}>
        {events.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <p className="text-[11px] font-normal text-muted-foreground/50">No notifications yet</p>
          </div>
        ) : (
          <AnimatePresence initial={false}>
            {events.map((event, index) => (
              <EventItem
                key={event.id}
                event={event}
                index={index}
                isClearingStacked={isClearingStacked}
                onDelete={handleDelete}
              />
            ))}
          </AnimatePresence>
        )}
      </div>
    </div>
  );
});
