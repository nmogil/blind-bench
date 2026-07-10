import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { Phase } from "./types";

const SHORTCUTS: Record<Phase, { key: string; label: string }[]> = {
  phase1: [
    { key: "← / →", label: "Previous / next output" },
    { key: "1", label: "Rate Weak" },
    { key: "2", label: "Rate Acceptable" },
    { key: "3", label: "Rate Best" },
    { key: "C", label: "Focus overall note" },
    { key: "Esc", label: "Exit note, return to shortcuts" },
    { key: "Z / ⌘Z", label: "Undo last action (via toast)" },
  ],
  phase2: [
    { key: "← / →", label: "Previous / next matchup" },
    { key: "1 or A", label: "Pick Output A" },
    { key: "2 or B", label: "Pick Output B" },
    { key: "= or T", label: "Tie" },
    { key: "S", label: "Skip matchup" },
  ],
  complete: [
    { key: "—", label: "No shortcuts; review complete." },
  ],
};

export function CheatSheetDialog({
  open,
  onOpenChange,
  phase,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  phase: Phase;
}) {
  const items = SHORTCUTS[phase];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            {phase === "phase1" &&
              "Score each attempt. Navigation is separate from rating."}
            {phase === "phase2" && "Compare two attempts and pick one."}
            {phase === "complete" && "Nothing to do here."}
          </DialogDescription>
        </DialogHeader>
        <ul className="space-y-1.5 text-sm">
          {items.map((s) => (
            <li key={s.key} className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">{s.label}</span>
              <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                {s.key}
              </kbd>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
