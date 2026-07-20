import { useEffect, useRef, memo } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { useStore } from "@/store/useStore";
import { useShallow } from "zustand/react/shallow";
import { cn } from "@/lib/format";

interface ScanClockPanelProps {
  scanning?: boolean;
  scanProgress?: number;
  current?: number;
  total?: number;
  isMarketOpen?: boolean;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Glyph matrix — replaces the old flip clock during scans.
 *
 * A canvas grid of terminal glyphs. While scanning, a progress wave sweeps
 * left→right "locking" cells (dim green, settled) while cells ahead of the
 * wave keep scrambling — the matrix itself IS the progress bar. A translucent
 * center overlay carries the readable data: % complete, current symbol,
 * scanned/total. Idle (no stocks yet) renders a calm ambient version.
 *
 * Perf: cell glyphs mutate in-place (~3% per tick, 20fps), full redraw is
 * ~1k fillText calls — trivial for canvas. No React re-render per frame.
 * prefers-reduced-motion: no scramble; static grid, locks still track
 * progress (comprehension kept, vestibular motion dropped).
 * ──────────────────────────────────────────────────────────────────────────── */

const GLYPHS = "₹0123456789ABCDEFXKMNPRSTVZ+−%▲▼·";
const CELL = 20;          // px per cell (logical)
const TICK_MS = 50;       // scramble cadence while scanning (20fps)
const AMBIENT_TICK_MS = 120; // idle/standby cadence (~8fps) — ambient, not a progress read
const FONT = "11px ui-monospace, SFMono-Regular, Menlo, monospace";

function randGlyphIdx(): number {
  return (Math.random() * GLYPHS.length) | 0;
}

const GlyphField = memo(function GlyphField({ progress, active, reduced }: { progress: number; active: boolean; reduced: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Progress lives in a ref so the rAF loop reads it without re-arming effects
  const progressRef = useRef(progress);
  const activeRef = useRef(active);

  useEffect(() => {
    progressRef.current = progress;
    activeRef.current = active;
  }, [progress, active]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let cols = 0;
    let rows = 0;
    let glyphs: number[] = [];   // index into GLYPHS
    let jitter: number[] = [];   // per-cell threshold noise for an organic wave edge
    let heat: number[] = [];     // recently-changed cells glow briefly
    let raf = 0;
    let lastTick = 0;
    let disposed = false;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    // Theme-aware palette — the canvas can't use CSS vars directly, so read the
    // html.light class per draw (cheap) and flip glyph inks accordingly.
    const palette = () => {
      const light = document.documentElement.classList.contains("light");
      return light
        ? {
            locked: "rgba(22,140,66,0.55)",
            heatBase: 0.3,
            heatInk: "40,40,40",
            idle: "rgba(70,70,70,0.22)",
            wave: "34,160,80",
          }
        : {
            locked: "rgba(34,197,94,0.42)",
            heatBase: 0.25,
            heatInk: "220,220,220",
            idle: "rgba(160,160,160,0.20)",
            wave: "34,197,94",
          };
    };

    /* Sprite atlas: every glyph pre-rendered in every ink variant, blitted with
       drawImage per cell. The old path issued ~1k fillText + fillStyle changes
       per frame (text rasterization each time) — the main source of animation
       jank while a scan runs. Blits are pure compositor-friendly copies.
       Heat glow is quantized to HEAT_LEVELS discrete alphas (visually
       indistinguishable from continuous at 20fps decay). */
    const HEAT_LEVELS = 6;
    const VARIANTS = 2 + HEAT_LEVELS; // 0=idle, 1=locked, 2..=heat (bright→dim)
    let atlas: HTMLCanvasElement | null = null;
    let atlasIsLight: boolean | null = null;

    const buildAtlas = (light: boolean) => {
      const ink = palette();
      const cellPx = CELL * dpr;
      const a = document.createElement("canvas");
      a.width = cellPx * GLYPHS.length;
      a.height = cellPx * VARIANTS;
      const actx = a.getContext("2d")!;
      actx.setTransform(dpr, 0, 0, dpr, 0, 0);
      actx.font = FONT;
      actx.textAlign = "center";
      actx.textBaseline = "middle";
      for (let v = 0; v < VARIANTS; v++) {
        if (v === 0) actx.fillStyle = ink.idle;
        else if (v === 1) actx.fillStyle = ink.locked;
        else {
          const heatVal = 1 - (v - 2) / (HEAT_LEVELS - 1); // 1 → 0
          actx.fillStyle = `rgba(${ink.heatInk},${ink.heatBase + heatVal * 0.45})`;
        }
        for (let g = 0; g < GLYPHS.length; g++) {
          actx.fillText(GLYPHS[g], g * CELL + CELL / 2, v * CELL + CELL / 2);
        }
      }
      atlas = a;
      atlasIsLight = light;
    };

    const seed = () => {
      const { clientWidth: w, clientHeight: h } = parent;
      canvas.width = Math.max(1, Math.floor(w * dpr));
      canvas.height = Math.max(1, Math.floor(h * dpr));
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cols = Math.max(1, Math.ceil(w / CELL));
      rows = Math.max(1, Math.ceil(h / CELL));
      const n = cols * rows;
      glyphs = Array.from({ length: n }, randGlyphIdx);
      jitter = Array.from({ length: n }, () => (Math.random() - 0.5) * 0.14);
      heat = new Array(n).fill(0);
    };

    const draw = () => {
      const w = canvas.width / dpr;
      const h = canvas.height / dpr;
      const light = document.documentElement.classList.contains("light");
      if (!atlas || atlasIsLight !== light) buildAtlas(light);
      const cellPx = CELL * dpr;

      ctx.clearRect(0, 0, w, h);

      const p = Math.min(1, Math.max(0, progressRef.current / 100));
      const isActive = activeRef.current;

      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const i = r * cols + c;
          // Wave position for this cell (column fraction + per-cell noise)
          const cellPos = c / cols + jitter[i];
          const locked = isActive && cellPos < p;

          let v: number;
          if (locked) {
            v = 1;
          } else if (heat[i] > 0) {
            v = 2 + Math.min(HEAT_LEVELS - 1, ((1 - heat[i]) * HEAT_LEVELS) | 0);
            heat[i] -= 0.14;
          } else {
            v = 0;
          }
          ctx.drawImage(atlas!, glyphs[i] * cellPx, v * cellPx, cellPx, cellPx, c * CELL, r * CELL, CELL, CELL);
        }
      }

      // Wave front: a clear vertical scan-line shimmer at the progress edge
      if (isActive && p > 0 && p < 1) {
        const ink = palette();
        const fx = p * w;
        const grad = ctx.createLinearGradient(fx - 44, 0, fx + 2, 0);
        grad.addColorStop(0, `rgba(${ink.wave},0)`);
        grad.addColorStop(1, `rgba(${ink.wave},0.28)`);
        ctx.fillStyle = grad;
        ctx.fillRect(fx - 44, 0, 46, h);
        // Hairline at the exact front — the "read head"
        ctx.fillStyle = `rgba(${ink.wave},0.55)`;
        ctx.fillRect(fx, 0, 1.5, h);
      }
    };

    const loop = (t: number) => {
      if (disposed) return;
      // Ambient (no scan) runs at a calmer cadence — same look, ~2.5× less work
      const tickMs = activeRef.current ? TICK_MS : AMBIENT_TICK_MS;
      if (t - lastTick >= tickMs) {
        lastTick = t;
        if (!reduced) {
          // Mutate a small fraction of cells each tick; ambient mode mutates fewer
          const churn = activeRef.current ? 0.035 : 0.012;
          const n = glyphs.length;
          const count = Math.max(1, (n * churn) | 0);
          for (let k = 0; k < count; k++) {
            const i = (Math.random() * n) | 0;
            glyphs[i] = randGlyphIdx();
            heat[i] = 1;
          }
        }
        draw();
      }
      raf = requestAnimationFrame(loop);
    };

    seed();
    draw();
    if (!reduced) {
      raf = requestAnimationFrame(loop);
    } else {
      // Reduced motion: redraw only when progress changes (poll at 2s — no scramble)
      const iv = setInterval(draw, 2000);
      return () => {
        disposed = true;
        clearInterval(iv);
      };
    }

    const ro = new ResizeObserver(() => {
      seed();
      draw();
    });
    ro.observe(parent);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [reduced]);

  return <canvas ref={canvasRef} className="absolute inset-0" aria-hidden="true" />;
});

export function ScanClockPanel({ scanProgress }: ScanClockPanelProps) {
  const reduced = useReducedMotion() ?? false;
  const { scanning, current, total, currentStock } = useStore(
    useShallow((s) => ({
      scanning: s.scanState.scanning,
      current: s.scanState.current,
      total: s.scanState.total,
      currentStock: s.scanState.currentStock,
    })),
  );

  const progress = scanProgress ?? (total > 0 ? (current / total) * 100 : 0);
  const isActive = scanning || (scanProgress != null && scanProgress > 0 && scanProgress < 100);

  return (
    <div className="relative w-full h-full overflow-hidden rounded-2xl">
      <GlyphField progress={progress} active={isActive} reduced={reduced} />

      {/* Soft vignette only at the very center so the symbol stays legible —
          light enough that the matrix reads clearly across the whole field.
          Uses --background so it fades to white in light mode instead of a
          dark smudge. */}
      <div className="absolute inset-0 pointer-events-none [background:radial-gradient(ellipse_35%_28%_at_center,color-mix(in_srgb,var(--background)_65%,transparent)_0%,transparent_100%)]" />

      {/* Center overlay — the symbol under the scanner is the hero.
          Progress % is NOT repeated here (TopBar owns the number; the matrix
          wave itself is the spatial progress read). */}
      <div className="absolute inset-0 flex flex-col items-center justify-center select-none">
        {isActive ? (
          <motion.div
            initial={{ opacity: 0, scale: 0.97 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ type: "spring", bounce: 0, duration: 0.4 }}
            className="flex flex-col items-center"
          >
            <span className="text-[10px] font-sans font-medium uppercase tracking-[0.32em] text-bull/70 flex items-center gap-2">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full rounded-full bg-bull/60 animate-ping [animation-duration:1.6s]" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-bull" />
              </span>
              Analyzing
            </span>

            {/* Hero: the symbol currently under the scanner. Progress lives in
                the TopBar % and the matrix wave itself — not repeated here. */}
            <div className="mt-2 font-mono tabular-nums leading-none text-center">
              <SymbolTicker symbol={currentStock || null} />
            </div>
          </motion.div>
        ) : (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.5 }}
            className="flex flex-col items-center gap-1.5"
          >
            <span className={cn("relative flex h-2 w-2")}>
              <span className="absolute inline-flex h-full w-full rounded-full bg-bull/50 animate-ping [animation-duration:3s]" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-bull/70" />
            </span>
            <span className="text-[10px] font-sans font-medium uppercase tracking-[0.3em] text-muted-foreground/60">
              Standby
            </span>
            <span className="text-[10px] font-mono text-muted-foreground/40">awaiting market data</span>
          </motion.div>
        )}
      </div>
    </div>
  );
}

/**
 * Large decrypt-style ticker: when the scanned symbol changes, characters
 * resolve left→right from scramble — the hero moment of the scan view.
 * Fixed line height; long symbols scale down via font clamp, never wrap.
 */
function SymbolTicker({ symbol }: { symbol: string | null }) {
  const ref = useRef<HTMLSpanElement>(null);
  const prevRef = useRef<string>("");

  useEffect(() => {
    const el = ref.current;
    const text = symbol || "";
    if (!el) return;
    if (!text || text === prevRef.current) {
      el.innerText = text || "· · ·";
      return;
    }
    prevRef.current = text;
    let iteration = 0;
    const interval = setInterval(() => {
      if (!ref.current) return;
      ref.current.innerText = text
        .split("")
        .map((ch, i) => (i < iteration ? ch : GLYPHS[(Math.random() * GLYPHS.length) | 0]))
        .join("");
      if (iteration >= text.length) {
        clearInterval(interval);
        if (ref.current) ref.current.innerText = text;
      }
      iteration += 1;
    }, 28);
    return () => clearInterval(interval);
  }, [symbol]);

  return (
    <span
      ref={ref}
      className={cn(
        "font-medium uppercase tracking-[-0.02em] text-foreground whitespace-nowrap",
        (symbol?.length ?? 0) > 12 ? "text-3xl sm:text-4xl" : "text-4xl sm:text-5xl md:text-6xl",
      )}
    >
      {symbol || "· · ·"}
    </span>
  );
}
