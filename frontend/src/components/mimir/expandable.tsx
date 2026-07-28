import React, { createContext, useContext, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/format";

interface ExpandableContextType {
  isExpanded: boolean;
  toggleExpand: () => void;
  expand: () => void;
  collapse: () => void;
}

const ExpandableContext = createContext<ExpandableContextType | undefined>(undefined);

export function useExpandable() {
  const context = useContext(ExpandableContext);
  if (!context) {
    throw new Error("useExpandable must be used within an Expandable component");
  }
  return context;
}

interface ExpandableProps {
  children: React.ReactNode;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  className?: string;
}

export function Expandable({ children, expanded: controlledExpanded, onExpandedChange, className }: ExpandableProps) {
  const [internalExpanded, setInternalExpanded] = useState(false);

  const isExpanded = controlledExpanded !== undefined ? controlledExpanded : internalExpanded;

  const toggleExpand = () => {
    const next = !isExpanded;
    if (controlledExpanded === undefined) setInternalExpanded(next);
    onExpandedChange?.(next);
  };

  const expand = () => {
    if (controlledExpanded === undefined) setInternalExpanded(true);
    onExpandedChange?.(true);
  };

  const collapse = () => {
    if (controlledExpanded === undefined) setInternalExpanded(false);
    onExpandedChange?.(false);
  };

  return (
    <ExpandableContext.Provider value={{ isExpanded, toggleExpand, expand, collapse }}>
      <motion.div
        layout
        transition={{ type: "spring", stiffness: 300, damping: 28 }}
        className={cn("overflow-hidden", className)}
      >
        {children}
      </motion.div>
    </ExpandableContext.Provider>
  );
}

export function ExpandableCard({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <motion.div
      layout
      transition={{ type: "spring", stiffness: 300, damping: 28 }}
      className={cn("rounded-3xl bg-[#1c1c1e] text-white overflow-hidden shadow-xl border border-white/10", className)}
    >
      {children}
    </motion.div>
  );
}

export function ExpandableCardHeader({ children, className, onClick }: { children: React.ReactNode; className?: string; onClick?: () => void }) {
  const { toggleExpand } = useExpandable();
  return (
    <motion.div
      layout="position"
      onClick={() => {
        onClick?.();
        toggleExpand();
      }}
      className={cn("cursor-pointer select-none", className)}
    >
      {children}
    </motion.div>
  );
}

export function ExpandableCardContent({ children, className }: { children: React.ReactNode; className?: string }) {
  const { isExpanded } = useExpandable();
  return (
    <AnimatePresence initial={false}>
      {isExpanded && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ type: "spring", stiffness: 300, damping: 28 }}
          className={cn("overflow-hidden", className)}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function ExpandableTrigger({ children, className }: { children: React.ReactNode; className?: string }) {
  const { toggleExpand } = useExpandable();
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        toggleExpand();
      }}
      className={className}
    >
      {children}
    </button>
  );
}
