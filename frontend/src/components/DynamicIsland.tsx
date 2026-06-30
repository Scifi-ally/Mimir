import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useStore } from "@/store/useStore";
import { cn } from "@/lib/format";
import { AlertCircle, Loader2 } from "lucide-react";
import { IslandContainer } from "./IslandContainer";
import { CommandPalette } from "./CommandPalette";

// ── Apple-style spring & ease presets ────────────────────────────────────────
const appleEase = [0.25, 0.1, 0.25, 1] as const;
const appleContentSpring = { type: "spring" as const, stiffness: 340, damping: 35, mass: 0.9 };

export function DynamicIsland() {
  const islandConfig = useStore((s) => s.islandConfig);
  const hideIsland = useStore((s) => s.hideIsland);
  const commandPaletteOpen = useStore((s) => s.commandPaletteOpen);
  const setCommandPaletteOpen = useStore((s) => s.setCommandPaletteOpen);
  const commandPaletteSearch = useStore((s) => s.commandPaletteSearch);

  const [isProcessing, setIsProcessing] = useState(false);
  const [isSuccessState, setIsSuccessState] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paletteWidth, setPaletteWidth] = useState(commandPaletteSearch.toLowerCase().startsWith('scan ') ? 650 : 560);

  const isSuccess = islandConfig?.showSuccessOnly ? true : isSuccessState;
  const showCommandPalette = commandPaletteOpen;
  const showIslandConfig = !commandPaletteOpen && !!islandConfig;
  const isOpen = showCommandPalette || showIslandConfig;

  // Reset state when island closes
  useEffect(() => {
    if (!isOpen) {
      setError(null);
      setIsSuccessState(false);
      setIsProcessing(false);
    }
  }, [isOpen]);

  // Auto-dismiss success-only islands
  useEffect(() => {
    if (islandConfig?.showSuccessOnly) {
      const timer = setTimeout(() => {
        setIsSuccessState(false);
        hideIsland();
      }, 2400);
      return () => clearTimeout(timer);
    }
  }, [islandConfig, hideIsland]);

  const handleConfirm = async () => {
    if (!islandConfig?.onConfirm) return;
    setIsProcessing(true);
    setError(null);
    try {
      const success = await islandConfig.onConfirm();
      if (success !== false) {
        setIsSuccessState(true);
        setTimeout(() => {
          setIsSuccessState(false);
          setIsProcessing(false);
          hideIsland();
        }, 2400);
      } else {
        setIsProcessing(false);
      }
    } catch (e) {
      setIsProcessing(false);
      setError(e instanceof Error ? e.message : "That action could not be completed. Please try again.");
    }
  };

  const handleCancel = () => {
    if (islandConfig?.onCancel) {
      islandConfig.onCancel();
    }
    setError(null);
    setIsProcessing(false);
    hideIsland();
  };

  const { title = "", subtitle = "", icon = null, confirmText = "Confirm", cancelText = "Cancel", isDestructive = false } = islandConfig || {};

  // Removed initialPillIcon

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* ── Backdrop ──────────────────────────────────────────────────── */}
          {/* Invisible backdrop to capture outside clicks without darkening or blurring */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.35, ease: appleEase }}
            className="fixed inset-0 z-[100] bg-transparent"
            onClick={() => {
              if (islandConfig) handleCancel();
              else setCommandPaletteOpen(false);
            }}
          />

          {/* ── Centering wrapper ─────────────────────────────────────────── */}
          <div className="fixed inset-x-0 top-4 z-[110] flex justify-center pointer-events-none">
            <IslandContainer
              width={isSuccess ? 120 : (islandConfig ? 360 : Math.max(560, paletteWidth))}
              minHeight={isSuccess ? 120 : "auto"}
              borderRadius={isSuccess ? "50px" : (islandConfig ? "26px" : "18px")}
              className="dynamic-confirmation-island"
            >
              <AnimatePresence mode="wait">
                {/* ─── Success state ─────────────────────────────────────── */}
                {isSuccess ? (
                  <motion.div
                    key="success"
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{
                      opacity: 1,
                      scale: 1,
                      transition: {
                        delay: 0.05,
                        ...appleContentSpring,
                      },
                    }}
                    exit={{
                      opacity: 0,
                      scale: 0.8,
                      transition: { duration: 0.15, ease: "easeIn" },
                    }}
                    className="w-full h-[120px] flex items-center justify-center"
                  >
                    {/* Apple-style animated check using SVG path drawing */}
                    <svg viewBox="0 0 50 50" className="w-16 h-16 overflow-visible">
                      <motion.circle
                        cx="25"
                        cy="25"
                        r="22"
                        fill="none"
                        stroke="#34C759"
                        strokeWidth="3.5"
                        initial={{ pathLength: 0, opacity: 0 }}
                        animate={{ pathLength: 1, opacity: 1 }}
                        transition={{ duration: 0.45, ease: [0.25, 0.1, 0.25, 1], delay: 0.2 }}
                      />
                      <motion.path
                        d="M16 26l6 6 13-13"
                        fill="none"
                        stroke="#34C759"
                        strokeWidth="4"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        initial={{ pathLength: 0 }}
                        animate={{ pathLength: 1 }}
                        transition={{ duration: 0.35, ease: "easeOut", delay: 0.45 }}
                      />
                    </svg>
                  </motion.div>

                ) : islandConfig ? (
                  /* ─── Confirmation dialog content ──────────────────────── */
                  <motion.div
                    key="content"
                    initial={{ opacity: 0 }}
                    animate={{
                      opacity: 1,
                      transition: {
                        delay: 0.08,
                        duration: 0.3,
                        ease: appleEase,
                      },
                    }}
                    exit={{
                      opacity: 0,
                      transition: { duration: 0.12, ease: "easeIn" },
                    }}
                    className="w-full flex flex-col p-5"
                    layout
                  >
                    {/* Title & subtitle */}
                    <div className="flex flex-col items-center text-center mt-1">
                      {icon && (
                        <motion.div
                          initial={{ scale: 0.8, opacity: 0 }}
                          animate={{ scale: 1, opacity: 1 }}
                          transition={{ delay: 0.15, ...appleContentSpring }}
                          className={cn("mb-3", isDestructive ? "text-destructive" : "text-foreground")}
                        >
                          {icon}
                        </motion.div>
                      )}
                      <motion.h3
                        initial={{ opacity: 0, y: 4 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.2, duration: 0.25, ease: appleEase }}
                        className="text-[15px] font-bold tracking-tight mb-1"
                      >
                        {title}
                      </motion.h3>
                      <motion.p
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ delay: 0.28, duration: 0.25, ease: appleEase }}
                        className="text-[12px] text-muted-foreground leading-relaxed font-mono px-2"
                      >
                        {subtitle}
                      </motion.p>

                      {/* Error banner */}
                      <AnimatePresence>
                        {error && (
                          <motion.div
                            initial={{ opacity: 0, height: 0, scale: 0.95 }}
                            animate={{ opacity: 1, height: "auto", scale: 1 }}
                            exit={{ opacity: 0, height: 0, scale: 0.95 }}
                            transition={{ duration: 0.25, ease: appleEase }}
                            className="mt-3 flex w-full items-start gap-2 rounded-xl bg-destructive/10 px-3 py-2 text-left text-[11px] leading-snug text-destructive"
                          >
                            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                            <span>{error}</span>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>

                    {/* Action buttons */}
                    <motion.div
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.32, duration: 0.28, ease: appleEase }}
                      className="flex w-full gap-2 mt-6"
                    >
                      {!(islandConfig?.hideCancel) && (
                        <button
                          onClick={handleCancel}
                          disabled={isProcessing}
                          className="flex-1 apple-hover py-2.5 rounded-xl bg-secondary text-[13px] font-bold transition-colors disabled:opacity-50 text-foreground"
                        >
                          {cancelText}
                        </button>
                      )}
                      <button
                        onClick={handleConfirm}
                        disabled={isProcessing}
                        className={cn(
                          "flex-1 apple-hover py-2.5 rounded-xl text-[13px] font-bold transition-colors flex items-center justify-center disabled:opacity-50",
                          isDestructive
                            ? "bg-destructive text-destructive-foreground"
                            : "bg-primary text-primary-foreground"
                        )}
                      >
                        {isProcessing ? (
                          <motion.div
                            initial={{ opacity: 0, scale: 0.8 }}
                            animate={{ opacity: 1, scale: 1 }}
                            transition={{ ...appleContentSpring }}
                          >
                            <Loader2 className="w-5 h-5 animate-spin" />
                          </motion.div>
                        ) : confirmText}
                      </button>
                    </motion.div>
                  </motion.div>

                ) : (
                  /* ─── Command palette content ─────────────────────────── */
                  <motion.div
                    key="command-palette"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="w-full flex flex-col"
                  >
                    <CommandPalette onClose={() => setCommandPaletteOpen(false)} onWidthChange={setPaletteWidth} />
                  </motion.div>
                )}
              </AnimatePresence>
            </IslandContainer>
          </div>
        </>
      )}
    </AnimatePresence>
  );
}
