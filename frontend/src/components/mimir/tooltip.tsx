import React, { useState } from "react";
import { cn } from "@/lib/format";

interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  align?: "center" | "start" | "end";
  className?: string;
  contentClassName?: string;
}

export function Tooltip({
  content,
  children,
  side = "top",
  align = "center",
  className,
  contentClassName,
}: TooltipProps) {
  const [isVisible, setIsVisible] = useState(false);

  const positionClasses = {
    top: "bottom-full mb-2",
    bottom: "top-full mt-2",
    left: "right-full mr-2",
    right: "left-full ml-2",
  };

  const alignClasses = {
    top: {
      center: "left-1/2 -translate-x-1/2",
      start: "left-0",
      end: "right-0",
    },
    bottom: {
      center: "left-1/2 -translate-x-1/2",
      start: "left-0",
      end: "right-0",
    },
    left: { center: "top-1/2 -translate-y-1/2", start: "top-0", end: "bottom-0" },
    right: { center: "top-1/2 -translate-y-1/2", start: "top-0", end: "bottom-0" },
  };

  return (
    <div
      className={cn("relative inline-block", className)}
      onMouseEnter={() => setIsVisible(true)}
      onMouseLeave={() => setIsVisible(false)}
    >
      {children}
      {isVisible && (
        <div
          className={cn(
            "absolute z-50 px-2.5 py-1.5 text-[10px] font-medium text-foreground bg-secondary rounded shadow-lg pointer-events-none w-max max-w-xs text-wrap leading-tight text-center",
            positionClasses[side],
            alignClasses[side][align],
            contentClassName
          )}
        >
          {content}
        </div>
      )}
    </div>
  );
}
