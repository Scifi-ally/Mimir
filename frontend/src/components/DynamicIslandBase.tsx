import { AnimatePresence, motion } from "framer-motion";
import { useState, type CSSProperties, type ReactNode } from "react";
import { SPRING_STANDARD, FADE_FAST } from "@/lib/motion";

export interface DynamicIslandProps {
  children?: ReactNode;
  collapsedContent?: ReactNode;
  expanded?: boolean;
  defaultExpanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  toggleOnClick?: boolean;
  placement?: "center" | "top";
  className?: string;
  style?: CSSProperties;
  contentKey?: string | number;
}

const islandStyle: CSSProperties = {
  position: "relative",
  display: "flex",
  flexDirection: "column",
  width: "fit-content",
  maxWidth: "calc(100vw - 32px)",
  overflow: "hidden",
  boxShadow: "0 8px 16px rgba(0, 0, 0, 0.25)",
};

const contentStyle: CSSProperties = {
  display: "flex",
  width: "max-content",
  maxWidth: "100%",
  alignItems: "flex-start",
  justifyContent: "center",
};

// One spring for everything the island does — entry, exit, and size changes —
// so the first descent and every subsequent morph share identical physics.
const ISLAND_SPRING = SPRING_STANDARD;

export function DynamicIsland({
  children,
  collapsedContent,
  expanded: controlledExpanded,
  defaultExpanded = true,
  onExpandedChange,
  toggleOnClick = false,
  placement = "center",
  className,
  style,
  contentKey,
}: DynamicIslandProps) {
  const [uncontrolledExpanded, setUncontrolledExpanded] =
    useState(defaultExpanded);
  const isControlled = controlledExpanded !== undefined;
  const expanded = isControlled ? controlledExpanded : uncontrolledExpanded;

  // Layout projection stays OFF during the entry descent. If it's on from the
  // first frame, Framer takes its initial measurements while the island is
  // mid-flight (translated and scaled to 0.82), which visibly distorts the
  // very first descent; every later open measures a settled element and looks
  // right. Enabling `layout` only after the entry completes makes the first
  // descent a pure transform animation — identical every time — while size
  // morphs (palette → prompt → success tick) still animate once landed.
  const [entryDone, setEntryDone] = useState(false);

  const setExpanded = (nextExpanded: boolean) => {
    if (!isControlled) setUncontrolledExpanded(nextExpanded);
    onExpandedChange?.(nextExpanded);
  };

  // The entry/exit slide lives on an outer wrapper that never has `layout`,
  // while the pill itself owns `layout` for size morphs. When both lived on one
  // element, the very first mount ran the layout projection and the entry
  // spring together (with content that could resize mid-flight, e.g. a lazy
  // chunk arriving), producing a visibly different first animation.
  return (
    <motion.div
      role="region"
      aria-label="Dynamic Island"
      aria-expanded={expanded}
      initial={
        placement === "top"
          ? { y: -140, opacity: 0, scale: 0.82 }
          : { y: 0, opacity: 1, scale: 1 }
      }
      animate={{ y: 0, opacity: 1, scale: 1 }}
      onAnimationComplete={() => setEntryDone(true)}
      exit={
        placement === "top"
          ? { y: -140, opacity: 0, scale: 0.82 }
          : { y: 0, opacity: 0, scale: 0.82 }
      }
      transition={ISLAND_SPRING}
      className={className}
      style={{
        display: "flex",
        justifyContent: "center",
        pointerEvents: "none",
        // Promote to its own compositor layer up front so the browser doesn't
        // rasterize mid-descent on the first open (one-time jank that reads as
        // a "different" first animation).
        willChange: "transform, opacity",
        ...(placement === "top" && {
          position: "fixed",
          top: 16,
          left: 0,
          right: 0,
          zIndex: 9999,
        }),
      }}
    >
      <motion.div
        layout={entryDone}
        onClick={() => toggleOnClick && setExpanded(!expanded)}
        transition={{ layout: ISLAND_SPRING }}
        className="bg-background text-foreground font-sans"
        style={{
          ...islandStyle,
          pointerEvents: "auto",
          ...(expanded
            ? { minWidth: 36, minHeight: 36, borderRadius: 42, padding: "8px 12px" }
            : {
                minWidth: 100,
                minHeight: 36,
                borderRadius: 999,
                padding: "8px 16px",
                cursor: toggleOnClick ? "pointer" : undefined,
              }),
          ...style,
        }}
      >
        <AnimatePresence initial={false} mode="wait">
          <motion.div
            layout={entryDone}
            key={contentKey ?? (expanded ? "expanded-content" : "collapsed-content")}
            initial={{ opacity: 0, scale: 0.88, filter: "blur(4px)" }}
            animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
            exit={{ opacity: 0, scale: 0.88, filter: "blur(4px)" }}
            transition={FADE_FAST}
            style={contentStyle}
          >
            {expanded ? children : collapsedContent}
          </motion.div>
        </AnimatePresence>
      </motion.div>
    </motion.div>
  );
}

export default DynamicIsland;
