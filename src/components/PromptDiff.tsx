import { useMemo, useState } from "react";
import { diffWords } from "diff";
import { AlignJustify, ArrowDown, Columns2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  getMessageText,
  roleLabel,
  type PromptMessage,
  type PromptMessageRole,
} from "@/lib/promptMessages";
import { cn } from "@/lib/utils";

type DiffMode = "side-by-side" | "unified";

interface PromptDiffProps {
  oldMessages: PromptMessage[];
  newMessages: PromptMessage[];
  mode?: DiffMode;
  onModeChange?: (mode: DiffMode) => void;
}

type AlignedPair =
  | {
      kind: "modified" | "unchanged" | "role-changed";
      index: number;
      oldMessage: PromptMessage;
      newMessage: PromptMessage;
    }
  | { kind: "added"; index: number; newMessage: PromptMessage }
  | { kind: "removed"; index: number; oldMessage: PromptMessage };

/**
 * Align two message arrays by position. The optimizer emits a new ordered list
 * rather than an id-preserving edit, so position is the most honest pairing we
 * have today. Extra messages fall out as added/removed.
 */
function alignMessages(
  oldMessages: PromptMessage[],
  newMessages: PromptMessage[],
): AlignedPair[] {
  const out: AlignedPair[] = [];
  const max = Math.max(oldMessages.length, newMessages.length);
  for (let i = 0; i < max; i++) {
    const oldMessage = oldMessages[i];
    const newMessage = newMessages[i];
    if (oldMessage && newMessage) {
      const textSame = getMessageText(oldMessage) === getMessageText(newMessage);
      const roleSame = oldMessage.role === newMessage.role;
      const kind = !roleSame
        ? "role-changed"
        : textSame
          ? "unchanged"
          : "modified";
      out.push({ kind, index: i, oldMessage, newMessage });
    } else if (newMessage) {
      out.push({ kind: "added", index: i, newMessage });
    } else if (oldMessage) {
      out.push({ kind: "removed", index: i, oldMessage });
    }
  }
  return out;
}

export function PromptDiff({
  oldMessages,
  newMessages,
  mode: controlledMode,
  onModeChange,
}: PromptDiffProps) {
  const [internalMode, setInternalMode] = useState<DiffMode>("side-by-side");
  const mode = controlledMode ?? internalMode;
  const setMode = onModeChange ?? setInternalMode;

  const aligned = useMemo(
    () => alignMessages(oldMessages, newMessages),
    [oldMessages, newMessages],
  );

  const hasChanges = aligned.some((p) => p.kind !== "unchanged");

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium text-muted-foreground">
          Messages{!hasChanges && " · No changes"}
        </h4>
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

      <div className="space-y-3">
        {aligned.map((pair) => (
          <MessageDiffBlock
            key={diffKey(pair)}
            pair={pair}
            mode={mode}
          />
        ))}
      </div>
    </div>
  );
}

function diffKey(pair: AlignedPair): string {
  if (pair.kind === "added") return `add:${pair.newMessage.id}`;
  if (pair.kind === "removed") return `rem:${pair.oldMessage.id}`;
  return `pair:${pair.oldMessage.id}:${pair.newMessage.id}`;
}

function MessageDiffBlock({
  pair,
  mode,
}: {
  pair: AlignedPair;
  mode: DiffMode;
}) {
  if (pair.kind === "added") {
    return (
      <DiffShell
        index={pair.index}
        role={pair.newMessage.role}
        badge={{ label: "Added", tone: "added" }}
      >
        <PreBlock
          text={getMessageText(pair.newMessage)}
          className="bg-blue-50/40 dark:bg-blue-950/20"
        />
      </DiffShell>
    );
  }

  if (pair.kind === "removed") {
    return (
      <DiffShell
        index={pair.index}
        role={pair.oldMessage.role}
        badge={{ label: "Removed", tone: "removed" }}
      >
        <PreBlock
          text={getMessageText(pair.oldMessage)}
          className="bg-purple-50/40 line-through dark:bg-purple-950/20"
        />
      </DiffShell>
    );
  }

  const oldText = getMessageText(pair.oldMessage);
  const newText = getMessageText(pair.newMessage);

  if (pair.kind === "unchanged") {
    return (
      <DiffShell
        index={pair.index}
        role={pair.newMessage.role}
        badge={{ label: "Unchanged", tone: "neutral" }}
      >
        <PreBlock text={newText} />
      </DiffShell>
    );
  }

  const parts = diffWords(oldText, newText);

  const roleBadge =
    pair.kind === "role-changed"
      ? {
          label: `Role: ${roleLabel(pair.oldMessage.role)} → ${roleLabel(
            pair.newMessage.role,
          )}`,
          tone: "modified" as const,
        }
      : { label: "Modified", tone: "modified" as const };

  return (
    <DiffShell
      index={pair.index}
      role={pair.newMessage.role}
      badge={roleBadge}
    >
      {mode === "side-by-side" ? (
        <SideBySide oldParts={parts} newParts={parts} />
      ) : (
        <Unified parts={parts} />
      )}
    </DiffShell>
  );
}

function DiffShell({
  index,
  role,
  badge,
  children,
}: {
  index: number;
  role: PromptMessageRole;
  badge: { label: string; tone: "added" | "removed" | "modified" | "neutral" };
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border bg-card">
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          #{index + 1}
        </span>
        <span
          className={cn(
            "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
            roleBadgeClass(role),
          )}
        >
          {roleLabel(role)}
        </span>
        <span
          className={cn(
            "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
            toneClass(badge.tone),
          )}
        >
          {badge.label}
        </span>
      </header>
      <div className="p-3">{children}</div>
    </section>
  );
}

function PreBlock({ text, className }: { text: string; className?: string }) {
  return (
    <pre
      className={cn(
        "whitespace-pre-wrap rounded-md px-2 py-1 text-sm font-mono leading-relaxed",
        className,
      )}
    >
      {text || (
        <span className="text-muted-foreground italic">(empty)</span>
      )}
    </pre>
  );
}

interface DiffPart {
  value: string;
  added?: boolean;
  removed?: boolean;
}

function SideBySide({
  oldParts,
  newParts,
}: {
  oldParts: DiffPart[];
  newParts: DiffPart[];
}) {
  return (
    <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
      <div className="rounded-md border bg-card p-3 overflow-auto">
        <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-purple-600 dark:text-purple-400">
          Previous
        </div>
        <pre className="whitespace-pre-wrap text-sm font-mono leading-relaxed">
          {oldParts.map((part, i) => {
            if (part.added) return null;
            return (
              <span
                key={i}
                className={cn(
                  part.removed &&
                    "rounded-sm bg-purple-100 px-0.5 text-purple-900 dark:bg-purple-900/30 dark:text-purple-300",
                )}
              >
                {part.value}
              </span>
            );
          })}
        </pre>
      </div>
      <div className="rounded-md border bg-card p-3 overflow-auto">
        <div className="mb-2 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider text-blue-600 dark:text-blue-400">
          Proposed
          <ArrowDown className="hidden h-3 w-3 md:inline" />
        </div>
        <pre className="whitespace-pre-wrap text-sm font-mono leading-relaxed">
          {newParts.map((part, i) => {
            if (part.removed) return null;
            return (
              <span
                key={i}
                className={cn(
                  part.added &&
                    "rounded-sm bg-blue-100 px-0.5 text-blue-900 dark:bg-blue-900/30 dark:text-blue-300",
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

function Unified({ parts }: { parts: DiffPart[] }) {
  return (
    <div className="rounded-md border bg-card p-3 overflow-auto">
      <pre className="whitespace-pre-wrap text-sm font-mono leading-relaxed">
        {parts.map((part, i) => (
          <span
            key={i}
            className={cn(
              part.removed &&
                "rounded-sm bg-purple-100 px-0.5 text-purple-900 line-through dark:bg-purple-900/30 dark:text-purple-300",
              part.added &&
                "rounded-sm bg-blue-100 px-0.5 text-blue-900 dark:bg-blue-900/30 dark:text-blue-300",
            )}
          >
            {part.value}
          </span>
        ))}
      </pre>
    </div>
  );
}

function toneClass(
  tone: "added" | "removed" | "modified" | "neutral",
): string {
  switch (tone) {
    case "added":
      return "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300";
    case "removed":
      return "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300";
    case "modified":
      return "bg-primary/12 text-primary";
    case "neutral":
      return "bg-muted text-muted-foreground";
  }
}

function roleBadgeClass(role: PromptMessageRole): string {
  switch (role) {
    case "system":
      return "bg-primary/12 text-primary border border-primary/25";
    case "developer":
      return "bg-primary/8 text-primary/90 border border-primary/20";
    case "user":
      return "bg-muted text-foreground border border-border";
    case "assistant":
      return "bg-muted/60 text-muted-foreground border border-border";
  }
}
