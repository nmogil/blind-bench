import { useState, useEffect } from "react";
import { useParams } from "react-router-dom";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { getGroupedShortcuts } from "@/lib/shortcuts";
import { onToggleCheatSheet } from "@/lib/shortcutCheatSheetState";

function isInputElement(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return true;
  if (target.contentEditable === "true") return true;
  if (target.closest("[role='textbox']")) return true;
  return false;
}

export function ShortcutCheatSheet() {
  const [open, setOpen] = useState(false);
  const { projectId, versionId, runId } = useParams<{
    projectId?: string;
    versionId?: string;
    runId?: string;
  }>();

  // Determine current context
  const context = versionId
    ? "version-editor"
    : runId
      ? "run-view"
      : projectId
        ? "project"
        : "global";

  // Subscribe to external toggle events (e.g. TopBar button)
  useEffect(() => onToggleCheatSheet(() => setOpen((prev) => !prev)), []);

  // Register ? shortcut
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (e.key === "?" && !isInputElement(e.target)) {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const groups = getGroupedShortcuts(context);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 max-h-[60vh] overflow-y-auto">
          {Object.entries(groups).map(([group, shortcuts]) => (
            <div key={group}>
              <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
                {group}
              </h4>
              <div className="space-y-1">
                {shortcuts.map((s) => (
                  <div
                    key={s.key}
                    className="flex items-center justify-between py-1"
                  >
                    <span className="text-sm">{s.description}</span>
                    <kbd className="ml-4 shrink-0 rounded border bg-muted px-1.5 py-0.5 text-xs font-mono">
                      {s.label}
                    </kbd>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
