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
export const SPRING_SNAPPY: Transition = { type: "spring", stiffness: 500, damping: 30 };

/** Standard — panels, cards, the dynamic island, most structural motion. */
export const SPRING_STANDARD: Transition = { type: "spring", stiffness: 450, damping: 32, mass: 0.8 };

/** Gentle — large surfaces: full-screen sheets, settings slide-up. */
export const SPRING_GENTLE: Transition = { type: "spring", stiffness: 300, damping: 34, mass: 0.9 };

/** Fast fade — content swaps inside a container that itself animates. */
export const FADE_FAST: Transition = { duration: 0.16, ease: "easeInOut" };

/** Standard fade — backdrops, overlays, list items appearing. */
export const FADE_STANDARD: Transition = { duration: 0.25, ease: "easeOut" };

/** Slow fade — big backdrops where abruptness would be jarring. */
export const FADE_SLOW: Transition = { duration: 0.35, ease: [0.16, 1, 0.3, 1] };

/** Stagger children of a list by index: `transition={stagger(i)}`. */
export const stagger = (index: number, base: Transition = FADE_STANDARD): Transition => ({
  ...base,
  delay: Math.min(index * 0.04, 0.3),
});
