import * as React from "react"
import { cn } from "@/lib/format"

interface ScrollAreaProps extends React.HTMLAttributes<HTMLDivElement> {
  orientation?: "vertical" | "horizontal" | "both"
}

const ScrollArea = React.forwardRef<HTMLDivElement, ScrollAreaProps>(
  ({ className, children, orientation = "vertical", ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        "relative overflow-hidden",
        orientation === "vertical" || orientation === "both" ? "overflow-y-auto" : "",
        orientation === "horizontal" || orientation === "both" ? "overflow-x-auto" : "",
        className
      )}
      {...props}
    >
      {children}
    </div>
  )
)
ScrollArea.displayName = "ScrollArea"

export { ScrollArea }
