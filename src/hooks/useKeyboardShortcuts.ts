import { useEffect } from "react";

interface Shortcut {
  key: string;
  meta?: boolean;
  handler: () => void;
}

function isInputElement(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return true;
  if (target.contentEditable === "true") return true;
  if (target.closest("[role='textbox']")) return true;
  return false;
}

export function useKeyboardShortcuts(shortcuts: Shortcut[]) {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      for (const shortcut of shortcuts) {
        const meta = e.metaKey || e.ctrlKey;

        if (shortcut.meta && !meta) continue;
        if (!shortcut.meta && meta) continue;

        if (e.key.toLowerCase() !== shortcut.key.toLowerCase()) continue;

        // Meta shortcuts (Cmd+S, etc.) fire even in inputs
        // Plain key shortcuts are suppressed in inputs
        if (!shortcut.meta && isInputElement(e.target)) continue;

        e.preventDefault();
        shortcut.handler();
        return;
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [shortcuts]);
}
