import { useEffect, useState } from "react";
import { isTauriRuntime } from "@/lib/backendOrigin";
import { cn } from "@/lib/format";

/**
 * Custom window controls.
 *
 * The shell runs with `decorations: false`, so the OS chrome is gone and these
 * replace it. They are deliberately NOT macOS traffic lights: no coloured
 * circles, no glyphs hidden until hover. Just three thin monochrome marks that
 * stay visible, so the controls are always discoverable, and they keep the
 * Windows convention of minimise / maximise / close reading left to right.
 *
 * These sit as the last item in the header's flex row rather than being
 * absolutely positioned over it. That makes overlap with the theme toggle and
 * the Live indicator structurally impossible, instead of merely unlikely.
 *
 * Windows draws these itself normally, so every action needs a matching
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
    "inline-flex h-6 w-7 shrink-0 items-center justify-center rounded text-foreground/45 " +
    "transition-colors duration-150 hover:bg-foreground/10 hover:text-foreground " +
    "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground/40";

  return (
    <div className="-mr-1 flex shrink-0 items-center" data-tauri-drag-region={false}>
      <button
        type="button"
        aria-label="Minimise"
        title="Minimise"
        className={base}
        onClick={() => run((w) => w.minimize())}
      >
        <span className="block h-px w-2.5 bg-current" />
      </button>

      <button
        type="button"
        aria-label={maximized ? "Restore" : "Maximise"}
        title={maximized ? "Restore" : "Maximise"}
        className={base}
        onClick={() => run((w) => w.toggleMaximize())}
      >
        {maximized ? (
          // Two offset outlines read as "restore" without needing a label.
          <span className="relative block h-[7px] w-[7px]">
            <span className="absolute left-0 top-0 h-[5px] w-[5px] rounded-[1px] border border-current" />
            <span className="absolute bottom-0 right-0 h-[5px] w-[5px] rounded-[1px] border border-current bg-background" />
          </span>
        ) : (
          <span className="block h-[7px] w-[7px] rounded-[1px] border border-current" />
        )}
      </button>

      <button
        type="button"
        aria-label="Close"
        title="Close"
        // Red appears only on hover, so the resting bar stays monochrome.
        className={cn(base, "hover:bg-destructive/15 hover:text-destructive")}
        onClick={() => run((w) => w.close())}
      >
        <svg viewBox="0 0 10 10" className="h-[9px] w-[9px]">
          <path
            d="M1 1 L9 9 M9 1 L1 9"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </div>
  );
}
