import { useEffect, useState, useRef } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { useStore } from "@/store/useStore";
import { AlertCircle, Loader2, CheckCircle2, Bell } from "lucide-react";
import { CommandPalette } from "./CommandPalette";

// ── Design Tokens ─────────────────────────────────────────────────────────────
const TOKENS = {
  colors: {
    surface: "var(--island-bg)",
    surfaceElevated: "var(--card)",
    border: "var(--border)",
    innerHighlight: "rgba(128,128,128,0.05)",
    textPrimary: "var(--island-text)",
    textSecondary: "var(--muted-foreground)",
    textTertiary: "var(--muted-foreground)",
    placeholder: "var(--muted-foreground)",
    divider: "var(--border)",
    shadow: "0 20px 60px rgba(0,0,0,0.15)",
    success: "#34C759",
    destructive: "var(--destructive)",
    primary: "var(--primary)",
  },
  spacing: {
    outer: "16px 20px",
    safeSide: "16px",
    contentGap: "12px",
    controlGap: "4px",
    sectionGap: "16px",
    buttonGap: "10px",
  },
  typography: {
    fontFamily: '"Geist Mono", ui-monospace, monospace',
  },
  blur: "28px"
} as const;

// ── Physics Engine ────────────────────────────────────────────────────────────
const morphSpring = { type: "spring" as const, stiffness: 450, damping: 35, mass: 0.8, restDelta: 0.001, restSpeed: 0.001 };
const bouncySpring = { type: "spring" as const, stiffness: 500, damping: 25, mass: 0.8 };
const layoutTransition = { ...morphSpring };

const contentTransition = {
  initial: { opacity: 0, filter: "blur(12px)", scale: 0.96 },
  animate: { opacity: 1, filter: "blur(0px)", scale: 1, transition: { ...morphSpring, delay: 0.03 } },
  exit: { opacity: 0, filter: "blur(8px)", scale: 0.96, transition: { ...morphSpring } },
};

// ── Apple Tick Component ──────────────────────────────────────────────────────
function AppleTick() {
  return (
    <motion.div
      key="success"
      initial={{ opacity: 0, scale: 0.6, filter: "blur(4px)" }}
      animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
      exit={{ opacity: 0, scale: 0.8, filter: "blur(4px)" }}
      transition={{ type: "spring", damping: 18, stiffness: 250 }}
      className="w-[140px] h-[140px] flex items-center justify-center pointer-events-auto"
    >
      <svg viewBox="0 0 50 50" className="w-[72px] h-[72px] overflow-visible">
        <motion.circle
          cx="25" cy="25" r="22"
          fill="none" stroke={TOKENS.colors.success} strokeWidth="4"
          initial={{ pathLength: 0, scale: 0.8, opacity: 0 }}
          animate={{ pathLength: 1, scale: 1, opacity: 1 }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          style={{ originX: "50%", originY: "50%" }}
        />
        <motion.path
          d="M15 25.5l7 7 14-14"
          fill="none" stroke={TOKENS.colors.success} strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 0.35, ease: "easeOut", delay: 0.15 }}
        />
      </svg>
    </motion.div>
  );
}

// ── Dynamic Island Component ──────────────────────────────────────────────────
export function DynamicIsland() {
  const islandConfig = useStore((s) => s.islandConfig);
  const hideIsland = useStore((s) => s.hideIsland);
  const commandPaletteOpen = useStore((s) => s.commandPaletteOpen);
  const setCommandPaletteOpen = useStore((s) => s.setCommandPaletteOpen);
  const commandPaletteSearch = useStore((s) => s.commandPaletteSearch);

  const [isProcessing, setIsProcessing] = useState(false);
  const [isSuccessState, setIsSuccessState] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paletteWidth, setPaletteWidth] = useState(commandPaletteSearch.toLowerCase().startsWith('scan ') ? 650 : 480);
  const [mounted, setMounted] = useState(false);
  const [contentHeight, setContentHeight] = useState<number>(44);
  const contentRef = useRef<HTMLDivElement>(null);

  const isSuccess = islandConfig?.showSuccessOnly ? true : isSuccessState;
  const showCommandPalette = commandPaletteOpen;
  const showIslandConfig = !commandPaletteOpen && !!islandConfig;
  const isOpen = showCommandPalette || showIslandConfig;

  useEffect(() => {
    if (contentRef.current) {
      const observer = new ResizeObserver((entries) => {
        if (entries[0]) {
          // Add a small buffer for safety if needed, but border-box usually handles it
          setContentHeight(entries[0].contentRect.height);
        }
      });
      observer.observe(contentRef.current);
      return () => observer.disconnect();
    }
  }, [isOpen]);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Cleanup state on close
  useEffect(() => {
    if (!isOpen) {
      setError(null);
      setIsSuccessState(false);
      setIsProcessing(false);
    }
  }, [isOpen]);

  // Determine if this is a notification banner (explicit flag OR no confirm AND no showSuccessOnly)
  const isNotification = Boolean(islandConfig?.isNotification || (islandConfig && !islandConfig.onConfirm && !islandConfig.showSuccessOnly));

  // Auto-dismiss logic for success state or notifications
  useEffect(() => {
    if (islandConfig?.showSuccessOnly || isNotification) {
      const duration = islandConfig?.duration ?? (islandConfig?.showSuccessOnly ? 2400 : 3500);
      const timer = setTimeout(() => {
        setIsSuccessState(false);
        hideIsland();
      }, duration);
      return () => clearTimeout(timer);
    }
  }, [islandConfig, hideIsland, isNotification]);

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
    if (islandConfig?.onCancel) islandConfig.onCancel();
    setError(null);
    setIsProcessing(false);
    hideIsland();
  };

  // Determine current active payload dimensions
  let targetWidth: number = 200; // Default min
  let targetRadius = 36;
  
  if (isSuccess) {
    targetWidth = 140;
    targetRadius = 44;
  } else if (isNotification) {
    const textLen = (islandConfig?.title?.length || 0) + (islandConfig?.subtitle?.length || 0);
    targetWidth = Math.min(540, Math.max(340, textLen * 8 + 80));
    targetRadius = 26;
  } else if (islandConfig) {
    targetWidth = 340;
    targetRadius = 28;
  } else if (commandPaletteOpen) {
    targetWidth = paletteWidth;
    targetRadius = 24;
  }

  const { title = "", subtitle = "", icon = null, confirmText = "Confirm", cancelText = "Cancel", isDestructive = false } = islandConfig || {};

  if (!mounted) return null;

  return createPortal(
    <AnimatePresence mode="wait">
      {isOpen && (
        <div className="fixed inset-0 z-[9999] pointer-events-none isolate">
          {/* ── Backdrop Layer ───────────────────────────────────────────── */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.35, ease: [0.25, 0.1, 0.25, 1] }}
            className={`absolute inset-0 ${isNotification ? "pointer-events-none" : "pointer-events-auto"}`}
            onClick={() => {
              if (isNotification) {
                hideIsland();
              } else if (islandConfig) {
                handleCancel();
              } else {
                setCommandPaletteOpen(false);
              }
            }}
          />

          {/* ── Safe Area Container ──────────────────────────────────────── */}
          <div 
            className="absolute inset-0 flex justify-center items-start pointer-events-none"
            style={{ 
              paddingTop: 24, // Increased spacing so it clears top components better
              paddingLeft: TOKENS.spacing.safeSide,
              paddingRight: TOKENS.spacing.safeSide
            }}
          >
            {/* ── Structural Wrapper ── */}
            <motion.div
              initial={{ opacity: 0, y: -20, scale: 0.95, width: 200, height: 44, borderRadius: "22px" }}
              animate={{ opacity: 1, y: 0, scale: 1, width: targetWidth, height: Math.max(44, contentHeight), borderRadius: targetRadius + "px" }}
              exit={{ opacity: 0, y: -20, scale: 0.95, width: 200, height: 44, borderRadius: "22px", transition: layoutTransition }}
              transition={layoutTransition}
              className="relative flex flex-col items-center justify-start pointer-events-auto overflow-hidden"
              style={{
                fontFamily: TOKENS.typography.fontFamily,
                willChange: "width, height, transform, border-radius",
                transformOrigin: "top center",
                backgroundColor: TOKENS.colors.surface,
                boxShadow: TOKENS.colors.shadow,
                border: `1px solid ${TOKENS.colors.border}`,
                backdropFilter: `blur(${TOKENS.blur})`,
                WebkitBackdropFilter: `blur(${TOKENS.blur})`,
              }}
            >
              {/* Inner Highlight Noise */}
              <div 
                className="absolute inset-0 pointer-events-none z-0 rounded-[inherit]"
                style={{ boxShadow: `inset 0 1px 1px ${TOKENS.colors.innerHighlight}` }}
              />

              {/* ── Content Router (Z-10 sits safely above background) ────── */}
              <div ref={contentRef} className="w-full flex flex-col items-center justify-start">
                <AnimatePresence mode="popLayout">
                  {isSuccess ? (
                    <AppleTick key="success" />
                  ) : isNotification ? (
                    <motion.div
                      key="notification"
                      variants={contentTransition}
                      initial="initial"
                      animate="animate"
                      exit="exit"
                      layout="position"
                      onClick={() => hideIsland()}
                      className="flex items-center gap-3 relative z-10 shrink-0 cursor-pointer w-full text-left"
                      style={{ padding: "12px 18px" }}
                    >
                      <div className="flex shrink-0 items-center justify-center">
                        {icon ? (
                          <div className="text-bull">{icon}</div>
                        ) : islandConfig?.showSuccessOnly || title?.toLowerCase().includes("complete") || title?.toLowerCase().includes("finish") || title?.toLowerCase().includes("success") || title?.toLowerCase().includes("started") ? (
                          <CheckCircle2 className="w-5 h-5 text-[#34C759]" />
                        ) : title?.toLowerCase().includes("fail") || title?.toLowerCase().includes("error") || title?.toLowerCase().includes("warning") ? (
                          <AlertCircle className="w-5 h-5 text-amber-400" />
                        ) : (
                          <Bell className="w-5 h-5 text-primary" />
                        )}
                      </div>
                      <div className="flex flex-col truncate flex-1 min-w-0">
                        {title && (
                          <span className="text-[13px] font-semibold text-foreground tracking-tight truncate">
                            {title}
                          </span>
                        )}
                        {subtitle && (
                          <span className="text-[12px] font-medium text-muted-foreground truncate">
                            {subtitle}
                          </span>
                        )}
                      </div>
                    </motion.div>
                  ) : islandConfig ? (
                    
                    // Confirmation Content Payload
                    <motion.div
                      key="confirmation"
                      variants={contentTransition}
                      initial="initial"
                      animate="animate"
                      exit="exit"
                      layout="position"
                      className="flex flex-col relative z-10 shrink-0"
                      style={{ padding: TOKENS.spacing.outer, width: 340 }}
                    >
                      <div className="flex flex-col items-center text-center">
                        {icon && (
                          <motion.div
                            initial={{ scale: 0.8, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            transition={{ delay: 0.1, ...bouncySpring }}
                            style={{
                              marginBottom: TOKENS.spacing.contentGap,
                              color: isDestructive ? TOKENS.colors.destructive : TOKENS.colors.textPrimary
                            }}
                          >
                            {icon}
                          </motion.div>
                        )}
                        
                        <motion.h3
                          layout="position"
                          style={{
                            fontSize: "16px",
                            fontWeight: 700,
                            color: TOKENS.colors.textPrimary,
                            marginBottom: TOKENS.spacing.controlGap,
                            letterSpacing: "-0.015em",
                          }}
                        >
                          {title}
                        </motion.h3>
                        
                        <motion.p
                          layout="position"
                          style={{
                            fontSize: "13px",
                            fontWeight: 500,
                            color: TOKENS.colors.textSecondary,
                            lineHeight: 1.5,
                          }}
                        >
                          {subtitle}
                        </motion.p>

                        <AnimatePresence>
                          {error && (
                            <motion.div
                              initial={{ opacity: 0, height: 0, scale: 0.95 }}
                              animate={{ opacity: 1, height: "auto", scale: 1 }}
                              exit={{ opacity: 0, height: 0, scale: 0.95 }}
                              transition={bouncySpring}
                              className="flex items-start w-full gap-2 text-left"
                              style={{
                                marginTop: TOKENS.spacing.contentGap,
                                padding: "10px 14px",
                                borderRadius: "12px",
                                backgroundColor: "rgba(255,59,48,0.12)",
                                color: TOKENS.colors.destructive,
                                fontSize: "12px",
                                fontWeight: 600,
                              }}
                            >
                              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                              <span>{error}</span>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>

                      <motion.div
                        layout="position"
                        className="flex w-full"
                        style={{
                          marginTop: TOKENS.spacing.sectionGap,
                          gap: TOKENS.spacing.buttonGap,
                        }}
                      >
                        {!(islandConfig?.hideCancel) && (
                          <button
                            onClick={handleCancel}
                            disabled={isProcessing}
                            style={{
                              flex: 1,
                              padding: "12px 0",
                              borderRadius: "14px",
                              backgroundColor: TOKENS.colors.surfaceElevated,
                              color: TOKENS.colors.textPrimary,
                              fontSize: "13px",
                              fontWeight: 600,
                              border: `1px solid ${TOKENS.colors.border}`,
                              transition: "all 0.2s cubic-bezier(0.25, 0.1, 0.25, 1)",
                              opacity: isProcessing ? 0.5 : 1,
                            }}
                            className="hover:bg-white/5 active:scale-[0.98]"
                          >
                            {cancelText}
                          </button>
                        )}
                        <button
                          onClick={handleConfirm}
                          disabled={isProcessing}
                          style={{
                            flex: 1,
                            padding: "12px 0",
                            borderRadius: "14px",
                            backgroundColor: isDestructive ? TOKENS.colors.destructive : TOKENS.colors.textPrimary,
                            color: isDestructive ? "#fff" : TOKENS.colors.surface,
                            fontSize: "13px",
                            fontWeight: 600,
                            border: "none",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            transition: "all 0.2s cubic-bezier(0.25, 0.1, 0.25, 1)",
                            opacity: isProcessing ? 0.5 : 1,
                          }}
                          className="hover:opacity-90 active:scale-[0.98]"
                        >
                          {isProcessing ? (
                            <motion.div initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }}>
                              <Loader2 className="w-4 h-4 animate-spin text-[inherit]" />
                            </motion.div>
                          ) : confirmText}
                        </button>
                      </motion.div>
                    </motion.div>

                  ) : (

                    // Command Palette Payload
                    <motion.div
                      key="command-palette"
                      variants={contentTransition}
                      initial="initial"
                      animate="animate"
                      exit="exit"
                      className="w-full flex flex-col relative z-10"
                    >
                      <CommandPalette onClose={() => setCommandPaletteOpen(false)} onWidthChange={setPaletteWidth} />
                    </motion.div>
                    
                  )}
                </AnimatePresence>
              </div>
            </motion.div>
          </div>
        </div>
      )}
    </AnimatePresence>,
    document.body
  );
}
