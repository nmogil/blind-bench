import { useState, useMemo } from "react";
import { diffWords } from "diff";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Columns2, AlignJustify } from "lucide-react";

interface PromptDiffProps {
  oldText: string;
  newText: string;
  label: string;
  mode?: "side-by-side" | "unified";
  onModeChange?: (mode: "side-by-side" | "unified") => void;
}

interface DiffPart {
  value: string;
  added?: boolean;
  removed?: boolean;
}

export function PromptDiff({
  oldText,
  newText,
  label,
  mode: controlledMode,
  onModeChange,
}: PromptDiffProps) {
  const [internalMode, setInternalMode] = useState<"side-by-side" | "unified">(
    "side-by-side",
  );
  const mode = controlledMode ?? internalMode;
  const setMode = onModeChange ?? setInternalMode;

  const parts = useMemo(() => diffWords(oldText, newText), [oldText, newText]);

  const hasChanges = parts.some((p) => p.added || p.removed);

  if (!hasChanges) {
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-medium text-muted-foreground">
            {label}
          </h4>
          <span className="text-xs text-muted-foreground">No changes</span>
        </div>
        <div className="rounded-md border bg-muted/30 p-3">
          <pre className="whitespace-pre-wrap text-sm font-mono">
            {newText}
          </pre>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium text-muted-foreground">{label}</h4>
        <div className="flex items-center gap-1 rounded-md border p-0.5">
          <Button
            variant={mode === "side-by-side" ? "secondary" : "ghost"}
            size="icon-xs"
            onClick={() => setMode("side-by-side")}
            title="Side by side"
          >
            <Columns2 className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant={mode === "unified" ? "secondary" : "ghost"}
            size="icon-xs"
            onClick={() => setMode("unified")}
            title="Unified"
          >
            <AlignJustify className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {mode === "side-by-side" ? (
        <SideBySideView parts={parts} />
      ) : (
        <UnifiedView parts={parts} />
      )}
    </div>
  );
}

function SideBySideView({ parts }: { parts: DiffPart[] }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {/* Old (removed) */}
      <div className="rounded-md border bg-card p-3 overflow-auto">
        <div className="text-[10px] font-medium text-purple-600 dark:text-purple-400 mb-2 uppercase tracking-wider">
          Previous
        </div>
        <pre className="whitespace-pre-wrap text-sm font-mono leading-relaxed">
          {parts.map((part, i) => {
            if (part.added) return null;
            return (
              <span
                key={i}
                className={cn(
                  part.removed &&
                    "bg-purple-100 text-purple-900 dark:bg-purple-900/30 dark:text-purple-300 rounded-sm px-0.5",
                )}
              >
                {part.value}
              </span>
            );
          })}
        </pre>
      </div>

      {/* New (added) */}
      <div className="rounded-md border bg-card p-3 overflow-auto">
        <div className="text-[10px] font-medium text-blue-600 dark:text-blue-400 mb-2 uppercase tracking-wider">
          Proposed
        </div>
        <pre className="whitespace-pre-wrap text-sm font-mono leading-relaxed">
          {parts.map((part, i) => {
            if (part.removed) return null;
            return (
              <span
                key={i}
                className={cn(
                  part.added &&
                    "bg-blue-100 text-blue-900 dark:bg-blue-900/30 dark:text-blue-300 rounded-sm px-0.5",
                )}
              >
                {part.value}
              </span>
            );
          })}
        </pre>
      </div>
    </div>
  );
}

function UnifiedView({ parts }: { parts: DiffPart[] }) {
  return (
    <div className="rounded-md border bg-card p-3 overflow-auto">
      <pre className="whitespace-pre-wrap text-sm font-mono leading-relaxed">
        {parts.map((part, i) => (
          <span
            key={i}
            className={cn(
              part.removed &&
                "bg-purple-100 text-purple-900 line-through dark:bg-purple-900/30 dark:text-purple-300 rounded-sm px-0.5",
              part.added &&
                "bg-blue-100 text-blue-900 dark:bg-blue-900/30 dark:text-blue-300 rounded-sm px-0.5",
            )}
          >
            {part.value}
          </span>
        ))}
      </pre>
    </div>
  );
}
