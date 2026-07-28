import type { Transition } from "framer-motion";

/**
 * Mimir motion system — the single source of truth for animation physics.
 *
 * Rules:
 *  - Structural movement (panels, islands, cards entering/exiting) uses springs.
 *  - Opacity/blur-only fades use durations.
 *  - Never inline a bespoke `transition={{...}}` in a component; import from here.
 *
 * Three spring tiers, one fade scale. Fewer options = coherent feel.
 */

/** Snappy — small UI: rows, chips, toggles, hover reveals. */
export const SPRING_SNAPPY: Transition = { type: "spring", stiffness: 600, damping: 28 };
export const SPRING_STANDARD: Transition = { type: "spring", stiffness: 550, damping: 28, mass: 0.6 };
export const SPRING_GENTLE: Transition = { type: "spring", stiffness: 450, damping: 30, mass: 0.7 };

export const FADE_FAST: Transition = { duration: 0.08, ease: "easeOut" };
export const FADE_STANDARD: Transition = { duration: 0.12, ease: "easeOut" };
export const FADE_SLOW: Transition = { duration: 0.18, ease: [0.16, 1, 0.3, 1] };

export const stagger = (index: number, base: Transition = FADE_STANDARD): Transition => ({
  ...base,
  delay: Math.min(index * 0.01, 0.05),
});
