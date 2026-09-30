import { useEffect, useState } from "react";
import { Minus, Square, Copy, X } from "lucide-react";
import { cn } from "@/lib/format";
import { isTauriRuntime } from "@/lib/backendOrigin";

/**
 * Custom window controls.
 *
 * The shell runs with `decorations: false`, which removes the native title bar
 * entirely - it was rendering as a lighter grey band above a near-black app and
 * could never match. That also removes minimise/maximise/close, so they are
 * provided here instead. Windows control placement themselves; we only invoke
 * the actions.
 */
export function WindowControls() {
  const [maximized, setMaximized] = useState(false);
  const tauri = isTauriRuntime();

  useEffect(() => {
    if (!tauri) return;
    let cancelled = false;
    void (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const win = getCurrentWindow();
        if (cancelled) return;
        setMaximized(await win.isMaximized());
        const un = await win.onResized(() => {
          void win.isMaximized().then(setMaximized).catch(() => {});
        });
        // Keep the listener alive for the window's lifetime.
        void un;
      } catch {
        // Older runtimes: the controls simply do nothing rather than throwing.
      }
    })();
    return () => { cancelled = true; };
  }, [tauri]);

  if (!tauri) return null;

  const run = (fn: (w: import("@tauri-apps/api/window").Window) => Promise<unknown>) => {
    void (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        await fn(getCurrentWindow());
      } catch {
        // Ignore: the window action is best-effort.
      }
    })();
  };

  const base =
    "inline-flex h-[calc(48px+env(safe-area-inset-top))] w-11 items-center justify-center text-foreground/60 transition-colors hover:bg-white/[0.07] hover:text-foreground";

  return (
    <div className="flex shrink-0 items-stretch" data-tauri-drag-region={false}>
      <button type="button" aria-label="Minimise" className={base}
        onClick={() => run((w) => w.minimize())}>
        <Minus className="h-3.5 w-3.5" strokeWidth={1.75} />
      </button>
      <button type="button" aria-label={maximized ? "Restore" : "Maximise"}
        className={base} onClick={() => run((w) => w.toggleMaximize())}>
        {maximized ? <Copy className="h-3 w-3" strokeWidth={1.75} />
          : <Square className="h-3 w-3" strokeWidth={1.75} />}
      </button>
      <button type="button" aria-label="Close"
        className={cn(base, "hover:bg-red-600 hover:text-white")}
        onClick={() => run((w) => w.close())}>
        <X className="h-4 w-4" strokeWidth={1.75} />
      </button>
    </div>
  );
}
