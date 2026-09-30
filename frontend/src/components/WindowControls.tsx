import { useEffect, useState } from "react";
import { isTauriRuntime } from "@/lib/backendOrigin";
import { cn } from "@/lib/format";

/**
 * macOS-style window controls, right-aligned.
 *
 * The shell runs with `decorations: false`, so the OS chrome is gone and these
 * replace it. Traffic lights on the right rather than the macOS left edge:
 * right-hand placement is what the surrounding app layout expects, and it keeps
 * the close button in the corner nearest the pointer.
 *
 * Windows draws these itself normally, so every action here needs a matching
 * permission in src-tauri/capabilities/default.json.
 */
export function WindowControls() {
  const [maximized, setMaximized] = useState(false);
  const tauri = isTauriRuntime();

  useEffect(() => {
    if (!tauri) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const win = getCurrentWindow();
        if (disposed) return;
        setMaximized(await win.isMaximized());
        unlisten = await win.onResized(() => {
          void win.isMaximized().then(setMaximized).catch(() => {});
        });
      } catch {
        // Older runtimes: controls render but do nothing, rather than throwing.
      }
    })();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [tauri]);

  if (!tauri) return null;

  const run = (fn: (w: import("@tauri-apps/api/window").Window) => Promise<unknown>) => {
    void (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        await fn(getCurrentWindow());
      } catch {
        // Best-effort window action.
      }
    })();
  };

  const base =
    "group inline-flex h-3 w-3 shrink-0 items-center justify-center rounded-full border transition-all duration-150";

  return (
    <div className="flex shrink-0 items-center gap-1.5" data-tauri-drag-region={false}>
      <button
        type="button"
        aria-label="Minimise"
        title="Minimise"
        className={cn(base, "border-amber-400/70 bg-amber-500/70 hover:bg-amber-400")}
        onClick={() => run((w) => w.minimize())}
      >
        <span className="h-[1.5px] w-[7px] rounded-full bg-black/55 opacity-0 transition-opacity group-hover:opacity-100" />
      </button>
      <button
        type="button"
        aria-label={maximized ? "Restore" : "Maximise"}
        title={maximized ? "Restore" : "Maximise"}
        className={cn(base, "border-emerald-400/70 bg-emerald-500/70 hover:bg-emerald-400")}
        onClick={() => run((w) => w.toggleMaximize())}
      >
        <span className="h-[7px] w-[7px] rounded-[1px] border-[1.5px] border-black/55 opacity-0 transition-opacity group-hover:opacity-100" />
      </button>
      <button
        type="button"
        aria-label="Close"
        title="Close"
        className={cn(base, "border-red-400/70 bg-red-500/70 hover:bg-red-500")}
        onClick={() => run((w) => w.close())}
      >
        <svg viewBox="0 0 8 8" className="h-[7px] w-[7px] opacity-0 transition-opacity group-hover:opacity-100">
          <path d="M1 1 L7 7 M7 1 L1 7" stroke="black" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
