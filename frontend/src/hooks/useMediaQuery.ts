import { useSyncExternalStore } from "react";

// Cache one MediaQueryList per query string so every consumer shares a single
// listener instead of re-parsing the query per component.
const mqlCache = new Map<string, MediaQueryList>();

function getMql(query: string): MediaQueryList {
  let mql = mqlCache.get(query);
  if (!mql) {
    mql = window.matchMedia(query);
    mqlCache.set(query, mql);
  }
  return mql;
}

/**
 * Reactive media query — used to mount ONLY the active responsive layout.
 * Rendering both desktop and mobile trees and hiding one with CSS doubles
 * chart instances, canvas loops, and live-price subscriptions.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mql = getMql(query);
      mql.addEventListener("change", cb);
      return () => mql.removeEventListener("change", cb);
    },
    () => getMql(query).matches,
    () => false,
  );
}
