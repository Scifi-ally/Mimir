import { lazy, Suspense, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { useStore } from "@/store/useStore";
import { AlertCircle, Loader2, CheckCircle2, Bell, X } from "lucide-react";
import { EventFeed } from "./EventFeed";
import DynamicIslandBase from "./DynamicIslandBase";
import { FADE_SLOW } from "@/lib/motion";

// The palette chunk starts downloading the moment this module evaluates (app
// startup), and the island refuses to open for the palette until it has
// resolved. Both matter: if the chunk arrives mid-descent, Suspense renders an
// empty pill that snaps to full size when the code lands — which reads as a
// completely different first animation.
const palettePromise = import("./CommandPalette");
let paletteLoaded = false;
void palettePromise.then(() => { paletteLoaded = true; });
const CommandPalette = lazy(() => palettePromise.then((m) => ({ default: m.CommandPalette })));

// ── Design Tokens ─────────────────────────────────────────────────────────────
const TOKENS = {
  colors: {
    surfaceElevated: "var(--card)",
    border: "var(--border)",
    textPrimary: "var(--foreground)",
    textSecondary: "var(--muted-foreground)",
    destructive: "var(--destructive)",
    surface: "var(--background)",
  },
  spacing: {
    outer: "16px 20px",
    contentGap: "12px",
    controlGap: "4px",
    sectionGap: "16px",
    buttonGap: "10px",
  },
} as const;

function AppleTick() {
  return (
    <div
      aria-label="Confirmation complete"
      className="dynamic-island--active flex flex-col items-center justify-center gap-1.5 pointer-events-auto select-none py-2 w-[130px] h-[130px]"
      role="status"
    >
      <svg className="confirmation-mark" viewBox="0 0 116 116" fill="none" aria-hidden="true">
        <circle className="confirmation-ring" cx="58" cy="58" r="39" />
        <path className="confirmation-check" d="m40 59 12 13 25-30" />
      </svg>
      <span className="text-[12px] font-medium font-sans tracking-tight text-[#8cf58d]">
        Done
      </span>
    </div>
  );
}

export function DynamicIsland() {
  const islandConfig = useStore((s) => s.islandConfig);
  const hideIsland = useStore((s) => s.hideIsland);
  const commandPaletteOpen = useStore((s) => s.commandPaletteOpen);
  const setCommandPaletteOpen = useStore((s) => s.setCommandPaletteOpen);
  const commandPaletteSearch = useStore((s) => s.commandPaletteSearch);
  const commandPaletteEditRuleId = useStore((s) => s.commandPaletteEditRuleId);
  const eventFeedOpen = useStore((s) => s.eventFeedOpen);
  const setEventFeedOpen = useStore((s) => s.setEventFeedOpen);

  const [isProcessing, setIsProcessing] = useState(false);
  const [isSuccessState, setIsSuccessState] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paletteWidth, setPaletteWidth] = useState(480);
  const [mounted, setMounted] = useState(false);

  // Set the pill's width for THIS open synchronously, during render, before
  // the descent starts. paletteWidth persists across opens, so without this
  // the first rule-builder open descended at the stale 480px and snapped to
  // 650px when CommandPalette's effect fired mid-flight — the "different
  // first animation". (Render-time state adjustment per React docs.)
  const [wasPaletteOpen, setWasPaletteOpen] = useState(commandPaletteOpen);
  if (commandPaletteOpen !== wasPaletteOpen) {
    setWasPaletteOpen(commandPaletteOpen);
    if (commandPaletteOpen) {
      // Must mirror CommandPalette's isBuildingRule initializer exactly.
      const opensAsRuleBuilder =
        commandPaletteEditRuleId != null ||
        commandPaletteSearch.toLowerCase().startsWith("scan ");
      setPaletteWidth(opensAsRuleBuilder ? 650 : 480);
    }
  }
  // Don't open the island for the palette until its code has actually arrived —
  // an empty Suspense pill that snaps to size mid-descent is the "different
  // first animation". The chunk is prefetched at module load, so this wait is
  // ~zero in practice; it only guards the cold-cache race.
  const [paletteReady, setPaletteReady] = useState(paletteLoaded);
  useEffect(() => {
    if (!paletteReady) {
      let cancelled = false;
      void palettePromise.then(() => { if (!cancelled) setPaletteReady(true); });
      return () => { cancelled = true; };
    }
  }, [paletteReady]);

  const showCommandPalette = commandPaletteOpen && paletteReady;
  const showIslandConfig = !commandPaletteOpen && !eventFeedOpen && !!islandConfig;
  const showEventFeed = eventFeedOpen;
  const isSuccess = islandConfig?.showSuccessOnly ? true : isSuccessState;
  const isOpen = showCommandPalette || showIslandConfig || showEventFeed || (islandConfig && !showCommandPalette && !showEventFeed);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!isOpen) {
      setError(null);
      setIsSuccessState(false);
      setIsProcessing(false);
    }
  }, [isOpen]);

  const isNotification = Boolean(islandConfig?.isNotification || (islandConfig && !islandConfig.onConfirm && !islandConfig.showSuccessOnly && !islandConfig.content)) && !showCommandPalette && !showEventFeed;

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
    if (!islandConfig?.onConfirm) {
      hideIsland();
      return;
    }
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

  const { title = "", subtitle = "", icon = null, confirmText = "Confirm", cancelText = "Cancel", isDestructive = false } = islandConfig || {};

  if (!mounted) return null;

  return createPortal(
    <div className="isolate relative z-[1000]">
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={FADE_SLOW}
            // Dim to focus for modal tasks (palette/prompt); notifications are
            // non-blocking so the scrim stays fully transparent for them.
            className={`fixed inset-0 z-[9998] ${isNotification ? "pointer-events-none" : "pointer-events-auto bg-black/25 [backdrop-filter:blur(2px)]"}`}
            onClick={() => {
              if (isNotification) {
                hideIsland();
              } else if (islandConfig) {
                handleCancel();
              } else if (showEventFeed) {
                setEventFeedOpen(false);
              } else {
                setCommandPaletteOpen(false);
              }
            }}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {isOpen && (
          <DynamicIslandBase
            placement="top"
            expanded={true}
            contentKey={showEventFeed ? "feed" : isSuccess ? "success" : isNotification ? "notification" : islandConfig ? "prompt" : "palette"}
            className="z-[9999]"
            collapsedContent={<div className="w-12 h-12" />}
          >
            {showEventFeed ? (
              <div style={{ width: 340 }} className="w-full flex flex-col">
                <EventFeed />
              </div>
            ) : isSuccess ? (
              <AppleTick key="success" />
            ) : isNotification ? (
              <div
                onClick={() => hideIsland()}
                className="flex items-center gap-3 cursor-pointer text-left w-full max-w-[540px] min-w-[340px]"
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
                  {title && <span className="text-[13px] font-medium font-sans text-foreground tracking-[-0.01em] truncate">{title}</span>}
                  {subtitle && <span className="text-[11px] font-normal font-sans text-muted-foreground/70 truncate">{subtitle}</span>}
                </div>
              </div>
            ) : islandConfig ? (
              <div className="flex flex-col shrink-0" style={{ padding: TOKENS.spacing.outer, width: 340 }}>
                <>
                  <div className="flex flex-col items-center text-center">
                    {icon && (
                      <div style={{ marginBottom: TOKENS.spacing.contentGap, color: isDestructive ? TOKENS.colors.destructive : TOKENS.colors.textPrimary }}>
                        {icon}
                      </div>
                    )}
                    <h3 style={{ fontSize: "16px", fontWeight: 600, color: TOKENS.colors.textPrimary, marginBottom: TOKENS.spacing.controlGap, letterSpacing: "-0.02em", fontFamily: "var(--font-sans)" }}>
                      {title}
                    </h3>
                    {subtitle && (
                      <p style={{ fontSize: "13px", fontWeight: 500, color: TOKENS.colors.textSecondary, lineHeight: 1.5 }}>
                        {subtitle}
                      </p>
                    )}
                    {islandConfig.content && (
                      <div className="w-full text-left mt-2">
                        {islandConfig.content}
                      </div>
                    )}
                    {error && (
                      <div className="flex items-start w-full gap-2 text-left" style={{ marginTop: TOKENS.spacing.contentGap, padding: "10px 14px", borderRadius: "12px", backgroundColor: "rgba(255,59,48,0.12)", color: TOKENS.colors.destructive, fontSize: "12px", fontWeight: 600 }}>
                        <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                        <span className="flex-1">{error}</span>
                        <button onClick={handleCancel} className="shrink-0 opacity-70 hover:opacity-100 transition-opacity" title="Dismiss">
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    )}
                  </div>

                  {islandConfig?.onConfirm && (
                    <div className="flex w-full" style={{ marginTop: TOKENS.spacing.sectionGap, gap: TOKENS.spacing.buttonGap }}>
                      {!(islandConfig?.hideCancel) && (
                        <button
                          onClick={handleCancel}
                          disabled={isProcessing}
                          style={{ flex: 1, padding: "12px 0", borderRadius: "14px", backgroundColor: "var(--secondary)", color: "var(--foreground)", fontSize: "13px", fontWeight: 600, border: "none", opacity: isProcessing ? 0.5 : 1 }}
                          className="hover:opacity-80 active:scale-[0.98] transition-all duration-200"
                        >
                          {cancelText}
                        </button>
                      )}
                      <button
                        onClick={handleConfirm}
                        disabled={isProcessing}
                        style={{ flex: 1, padding: "12px 0", borderRadius: "14px", backgroundColor: isDestructive ? "var(--destructive)" : "var(--foreground)", color: isDestructive ? "#ffffff" : "var(--background)", fontSize: "13px", fontWeight: 600, border: "none", display: "flex", alignItems: "center", justifyContent: "center", opacity: isProcessing ? 0.5 : 1 }}
                        className="hover:opacity-90 active:scale-[0.98] transition-all duration-200 shadow-sm"
                      >
                        {isProcessing ? <Loader2 className="w-4 h-4 animate-spin text-[inherit]" /> : confirmText}
                      </button>
                    </div>
                  )}
                </>
              </div>
            ) : (
              // Clamp to viewport: a fixed 650px pill would clip (the island
              // has overflow:hidden) on phones.
              <div className="w-full flex flex-col" style={{ width: `min(${paletteWidth}px, calc(100vw - 48px))` }}>
                <Suspense fallback={null}>
                  <CommandPalette onClose={() => setCommandPaletteOpen(false)} onWidthChange={setPaletteWidth} />
                </Suspense>
              </div>
            )}
          </DynamicIslandBase>
        )}
      </AnimatePresence>
    </div>,
    document.body
  );
}
