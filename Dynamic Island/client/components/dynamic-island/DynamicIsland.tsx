import { AnimatePresence, motion } from "framer-motion";
import { useState, type CSSProperties, type ReactNode } from "react";

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
}

const islandStyle: CSSProperties = {
  position: "relative",
  display: "flex",
  flexDirection: "column",
  width: "fit-content",
  maxWidth: "calc(100vw - 32px)",
  overflow: "hidden",
  background: "#000",
  color: "#fff",
  boxShadow: "0 8px 16px rgba(0, 0, 0, 0.25)",
};

const contentStyle: CSSProperties = {
  display: "flex",
  width: "max-content",
  maxWidth: "100%",
  alignItems: "center",
  justifyContent: "center",
};

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
}: DynamicIslandProps) {
  const [uncontrolledExpanded, setUncontrolledExpanded] =
    useState(defaultExpanded);
  const isControlled = controlledExpanded !== undefined;
  const expanded = isControlled ? controlledExpanded : uncontrolledExpanded;

  const setExpanded = (nextExpanded: boolean) => {
    if (!isControlled) setUncontrolledExpanded(nextExpanded);
    onExpandedChange?.(nextExpanded);
  };

  return (
    <motion.div
      layout
      role="region"
      aria-label="Dynamic Island"
      aria-expanded={expanded}
      initial={
        placement === "top"
          ? { y: -140, opacity: 0, scale: 0.82 }
          : { y: 0, opacity: 1, scale: 1 }
      }
      animate={{ y: 0, opacity: 1, scale: 1 }}
      onClick={() => toggleOnClick && setExpanded(!expanded)}
      transition={{
        type: "spring",
        stiffness: 380,
        damping: 35,
        mass: 0.8,
        layout: { type: "spring", stiffness: 380, damping: 35 },
      }}
      className={className}
      style={{
        ...islandStyle,
        ...(placement === "top" && {
          position: "fixed",
          top: 16,
          left: 0,
          right: 0,
          margin: "0 auto",
          zIndex: 50,
        }),
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
          key={expanded ? "expanded-content" : "collapsed-content"}
          initial={{ opacity: 0, scale: 0.94 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.94 }}
          transition={{ duration: expanded ? 0.2 : 0.16, ease: "easeOut" }}
          style={contentStyle}
        >
          {expanded ? children : collapsedContent}
        </motion.div>
      </AnimatePresence>
    </motion.div>
  );
}

export default DynamicIsland;
