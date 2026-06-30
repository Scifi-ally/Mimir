import { motion, usePresence } from "framer-motion";
import { type ReactNode, useEffect, useState } from "react";
import { cn } from "@/lib/format";

const morphSpring = { type: "spring" as const, stiffness: 500, damping: 32, mass: 0.5 };
const appleEase = [0.25, 0.1, 0.25, 1] as const;

interface IslandContainerProps {
  children: ReactNode;
  width?: number | string;
  minHeight?: number | string;
  borderRadius?: number | string;
  className?: string;
}

export function IslandContainer({
  children,
  width = 320,
  minHeight = "auto",
  borderRadius = "28px",
  className,
}: IslandContainerProps) {
  
  const targetWidth = typeof width === "number" ? width : width;
  const targetHeight = minHeight !== "auto" ? minHeight : "auto";

  const [phase, setPhase] = useState<"pill" | "wide" | "full">("pill");
  const [isPresent, safeToRemove] = usePresence();

  useEffect(() => {
    if (isPresent) {
      setPhase("pill");
      const t1 = setTimeout(() => setPhase("wide"), 10);
      const t2 = setTimeout(() => setPhase("full"), 110);
      return () => { clearTimeout(t1); clearTimeout(t2); };
    } else {
      setPhase("wide");
      const t1 = setTimeout(() => setPhase("pill"), 120);
      const t2 = setTimeout(() => safeToRemove(), 350);
      return () => { clearTimeout(t1); clearTimeout(t2); };
    }
  }, [isPresent, safeToRemove]);

  const tNumWidth = typeof targetWidth === "number" ? targetWidth : 250;
  const currentWidth = phase === "pill" ? Math.min(250, tNumWidth) : targetWidth;
  const currentHeight = phase === "full" ? targetHeight : 48;
  const currentRadius = phase === "full" ? borderRadius : "30px";

  return (
    <motion.div
      initial={{ scale: 0.95, opacity: 0 }}
      animate={{ scale: 1, opacity: 1, transition: { duration: 0.3, ease: appleEase } }}
      exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.2, delay: 0.15, ease: "easeIn" } }}
      className={cn("pointer-events-auto transform-gpu isolation-isolate mx-auto", className)}
      style={{ transformOrigin: "top center" }}
    >
      <motion.div
        layout
        initial={{ width: 250, height: 48, borderRadius: "30px" }}
        animate={{ width: currentWidth, height: currentHeight, borderRadius: currentRadius }}
        transition={morphSpring}
        className="dark relative flex items-start justify-center border-none ring-0 shadow-none"
        style={{ backgroundColor: "var(--island-bg)", color: "var(--island-text)", overflow: "hidden", willChange: "width, height, border-radius" }}
      >
        <motion.div
          layout
          initial={{ opacity: 0, filter: "blur(8px)" }}
          animate={{ opacity: 1, filter: "blur(0px)", transition: { delay: 0.08, duration: 0.2, ease: appleEase } }}
          exit={{ opacity: 0, filter: "blur(4px)", transition: { duration: 0.12, ease: "easeOut" } }}
          className="flex h-max shrink-0 flex-col items-center justify-center w-full"
          style={{ minHeight: typeof minHeight === "number" ? minHeight : undefined }}
        >
          {children}
        </motion.div>
      </motion.div>
    </motion.div>
  );
}
