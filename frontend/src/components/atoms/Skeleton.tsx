import { cn } from "@/lib/format";

/**
 * Shimmer skeleton primitive. Shape it with className (h-*, w-*, rounded-*)
 * so placeholders mirror the real content's silhouette — never spinners.
 * prefers-reduced-motion: the shimmer sweep is dropped, leaving a gentle
 * opacity pulse (non-vestibular, comprehension kept).
 */
export function Skeleton({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <div
      aria-hidden="true"
      style={style}
      className={cn(
        "relative overflow-hidden rounded-md bg-foreground/[0.06] isolate",
        "after:absolute after:inset-0 after:-translate-x-full",
        "after:bg-gradient-to-r after:from-transparent after:via-foreground/[0.07] after:to-transparent",
        "after:animate-[skeleton-shimmer_1.8s_ease-in-out_infinite]",
        "motion-reduce:after:hidden motion-reduce:animate-pulse",
        className,
      )}
    />
  );
}
