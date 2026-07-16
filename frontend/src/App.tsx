import { useEffect } from "react";
import Dashboard from "@/pages/Dashboard";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { DynamicIsland } from "@/components/DynamicIsland";

import { useStore } from "@/store/useStore";

export default function App() {
  const setCommandPaletteOpen = useStore((s) => s.setCommandPaletteOpen);
  const commandPaletteOpen = useStore((s) => s.commandPaletteOpen);


  useEffect(() => {
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
  }, [commandPaletteOpen, setCommandPaletteOpen]);

  return (
    <ErrorBoundary>
      <Dashboard />
      <DynamicIsland />
    </ErrorBoundary>
  );
}
