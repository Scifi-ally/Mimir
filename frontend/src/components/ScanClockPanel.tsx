import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Card } from "@/components/mimir/card";
import { cn } from "@/lib/format";

interface ScanClockPanelProps {
  scanning: boolean;
  scanProgress?: number;
  current?: number;
  total?: number;
  isMarketOpen?: boolean;
}

function Digit({ value, className = "" }: { value: string; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center", className)}>
      <div className="relative overflow-hidden h-20 sm:h-24 md:h-32 flex items-center justify-center">
        <AnimatePresence mode="popLayout">
          <motion.span
            key={value}
            initial={{ y: "100%", opacity: 0 }}
            animate={{ y: "0%", opacity: 1 }}
            exit={{ y: "-100%", opacity: 0 }}
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
            className="text-7xl sm:text-8xl md:text-[9rem] font-mono font-black tracking-tighter text-foreground drop-shadow-lg tabular-nums leading-none"
          >
            {value}
          </motion.span>
        </AnimatePresence>
      </div>
    </div>
  );
}

export function ScanClockPanel({
  scanning,
  isMarketOpen = false,
}: ScanClockPanelProps) {
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
  
  const isPM = h >= 12;
  const hours = h % 12 || 12;
  const mins = m;
  const secs = s;

  const hh = hours.toString().padStart(2, "0");
  const mm = mins.toString().padStart(2, "0");
  const ss = secs.toString().padStart(2, "0");

  const formattedDate = istDate.toLocaleDateString("en-IN", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return (
    <div className="w-full h-full flex flex-col items-center justify-center relative overflow-hidden p-6 select-none">
      {/* Background Radar / Glows */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none opacity-30">
        <motion.div
          animate={{ rotate: 360 }}
          transition={{ repeat: Infinity, duration: 30, ease: "linear" }}
          className="w-[800px] h-[800px] rounded-full relative"
        >
          <div className="absolute inset-0 rounded-full bg-gradient-to-tr from-emerald-500/5 via-transparent to-transparent" />
        </motion.div>
      </div>

      <div className="relative z-10 flex flex-col items-center justify-center max-w-4xl w-full gap-8 py-10">
        {/* Digital Clock with sliding effect digits */}
        <div className="flex items-center gap-4 sm:gap-6 md:gap-8">
          <Digit value={hh} />
          <span className="text-6xl sm:text-7xl md:text-[8rem] font-mono text-foreground/20 -mt-4 animate-pulse leading-none">:</span>
          <Digit value={mm} />
          <span className="text-6xl sm:text-7xl md:text-[8rem] font-mono text-foreground/20 -mt-4 animate-pulse leading-none">:</span>
          <Digit value={ss} className="text-emerald-400" />
          <div className="flex flex-col justify-end h-20 sm:h-24 md:h-32 pb-2 sm:pb-3 md:pb-4 ml-4 sm:ml-6">
             <span className="text-2xl sm:text-3xl md:text-4xl font-black text-emerald-500/80 tracking-widest uppercase">{isPM ? "PM" : "AM"}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
