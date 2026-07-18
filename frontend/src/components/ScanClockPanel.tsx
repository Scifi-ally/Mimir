import { useEffect, useState, memo } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { SPRING_GENTLE } from "@/lib/motion";

interface ScanClockPanelProps {
  scanning?: boolean;
  scanProgress?: number;
  current?: number;
  total?: number;
  isMarketOpen?: boolean;
}

const SingleDigit = memo(function SingleDigit({ char }: { char: string }) {
  return (
    <div className="relative inline-block w-[72px] h-[96px] sm:w-[96px] sm:h-[128px] md:w-[120px] md:h-[160px] overflow-hidden">
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={char}
          initial={{ y: "100%" }}
          animate={{ y: "0%" }}
          exit={{ y: "-100%" }}
          transition={SPRING_GENTLE}
          className="absolute inset-0 flex items-center justify-center text-7xl sm:text-8xl md:text-9xl font-mono font-black text-foreground tabular-nums select-none"
        >
          {char}
        </motion.span>
      </AnimatePresence>
    </div>
  );
});

function Colon() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 sm:gap-4 md:gap-5 mx-1 sm:mx-2 md:mx-3 h-[96px] sm:h-[128px] md:h-[160px]">
      <div className="w-3 h-3 sm:w-4 sm:h-4 md:w-5 md:h-5 rounded-full bg-foreground/40" />
      <div className="w-3 h-3 sm:w-4 sm:h-4 md:w-5 md:h-5 rounded-full bg-foreground/40" />
    </div>
  );
}

export function ScanClockPanel(_props: ScanClockPanelProps) {
  const [time, setTime] = useState(new Date());

  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const istString = time.toLocaleString("en-US", { timeZone: "Asia/Kolkata" });
  const istDate = new Date(istString);

  const h = istDate.getHours();
  const m = istDate.getMinutes();
  const s = istDate.getSeconds();

  const hours = h % 12 || 12;
  const hh = hours.toString().padStart(2, "0");
  const mm = m.toString().padStart(2, "0");
  const ss = s.toString().padStart(2, "0");

  return (
    <div className="w-full h-full flex items-center justify-center bg-transparent">
      <div className="flex items-center">
        <SingleDigit char={hh[0]} />
        <SingleDigit char={hh[1]} />
        <Colon />
        <SingleDigit char={mm[0]} />
        <SingleDigit char={mm[1]} />
        <Colon />
        <SingleDigit char={ss[0]} />
        <SingleDigit char={ss[1]} />
      </div>
    </div>
  );
}
