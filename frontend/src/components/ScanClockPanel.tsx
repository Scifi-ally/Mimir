import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { cn } from "@/lib/format";

interface ScanClockPanelProps {
  scanning?: boolean;
  scanProgress?: number;
  current?: number;
  total?: number;
  isMarketOpen?: boolean;
}

function SingleDigit({ char }: { char: string }) {
  return (
    <div className="relative overflow-hidden h-24 sm:h-32 md:h-40 flex items-center justify-center w-[1ch]">
      <AnimatePresence mode="popLayout">
        <motion.span
          key={char}
          initial={{ y: "100%", opacity: 0 }}
          animate={{ y: "0%", opacity: 1 }}
          exit={{ y: "-100%", opacity: 0 }}
          transition={{ type: "spring", stiffness: 300, damping: 30 }}
          className="text-[6rem] sm:text-[8rem] md:text-[12rem] font-mono font-black tracking-tighter text-foreground drop-shadow-lg tabular-nums leading-none"
        >
          {char}
        </motion.span>
      </AnimatePresence>
    </div>
  );
}

function DigitGroup({ value, className = "" }: { value: string; className?: string }) {
  const chars = value.split("");
  return (
    <div className={cn("flex items-center", className)}>
      {chars.map((char, index) => (
        <SingleDigit key={index} char={char} />
      ))}
    </div>
  );
}

export function ScanClockPanel(_props: ScanClockPanelProps) {
  const [time, setTime] = useState(new Date());

  useEffect(() => {
    const timer = setInterval(() => {
      setTime(new Date());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Convert current time to IST values
  const istString = time.toLocaleString("en-US", { timeZone: "Asia/Kolkata" });
  const istDate = new Date(istString);
  
  const h = istDate.getHours();
  const m = istDate.getMinutes();
  const s = istDate.getSeconds();
  
  const hours = h % 12 || 12;
  const mins = m;
  const secs = s;

  const hh = hours.toString().padStart(2, "0");
  const mm = mins.toString().padStart(2, "0");
  const ss = secs.toString().padStart(2, "0");

  return (
    <div className="w-full h-full flex items-center justify-center relative overflow-hidden select-none bg-background">
      <div className="relative z-10 flex items-center justify-center w-full">
        {/* Digital Clock with individual character sliding effect */}
        <div className="flex items-center gap-2 sm:gap-4 md:gap-6">
          <DigitGroup value={hh} />
          <span className="text-6xl sm:text-7xl md:text-[10rem] font-mono text-foreground/20 animate-pulse leading-none -mt-4 sm:-mt-6 md:-mt-8">:</span>
          <DigitGroup value={mm} />
          <span className="text-6xl sm:text-7xl md:text-[10rem] font-mono text-foreground/20 animate-pulse leading-none -mt-4 sm:-mt-6 md:-mt-8">:</span>
          <DigitGroup value={ss} />
        </div>
      </div>
    </div>
  );
}
