import { useEffect } from "react";

import Dashboard from "@/pages/Dashboard";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { DynamicIsland } from "@/components/DynamicIsland";
import { isTauriRuntime } from "@/lib/backendOrigin";

import { useStore } from "@/store/useStore";

export default function App() {
  const setCommandPaletteOpen = useStore((s) => s.setCommandPaletteOpen);
  const commandPaletteOpen = useStore((s) => s.commandPaletteOpen);
  const theme = useStore((s) => s.theme);


  useEffect(() => {
    document.documentElement.classList.toggle("light", theme === "light");

    // The native title bar follows the WINDOW theme, not the document's CSS
    // variables, so in the desktop app the title bar stayed dark while the app
    // body rendered light. Tell the window which theme we are actually using so
    // the two match. "quant" is a dark variant, so it maps to dark.
    if (isTauriRuntime()) {
      void (async () => {
        try {
          const { getCurrentWindow } = await import("@tauri-apps/api/window");
          await getCurrentWindow().setTheme(theme === "light" ? "light" : "dark");
        } catch {
          // Older runtimes may not expose setTheme; the app still works, only
          // the native title bar colour is unaffected.
        }
      })();
    }

    const down = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setCommandPaletteOpen(!commandPaletteOpen);
        return;
      }

      const target = e.target as HTMLElement;
      const isInput = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable;
      if (!commandPaletteOpen && !isInput && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1 && /[a-zA-Z0-9]/.test(e.key)) {
        e.preventDefault();
        setCommandPaletteOpen(true, e.key);
      }
    };
    document.addEventListener('keydown', down);
    return () => document.removeEventListener('keydown', down);
  }, [commandPaletteOpen, setCommandPaletteOpen, theme]);

  return (
    <ErrorBoundary>
      <Dashboard />
      <DynamicIsland />
    </ErrorBoundary>
  );
}
