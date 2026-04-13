import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

interface ChangesPanelProps {
  changesSummary: string;
  changesReasoning: string;
}

/**
 * Highlights citation tokens (blind labels A/B/C, field names) in reasoning text.
 */
function highlightCitations(text: string): React.ReactNode[] {
  const pattern =
    /\b(Output [A-C]|[A-C])\b|(system[_ ]message|user[_ ](?:message[_ ])?template)/gi;

  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  const regex = new RegExp(pattern.source, pattern.flags);
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }

    const isBlindLabel = match[1] !== undefined;
    parts.push(
      <span
        key={match.index}
        className={cn(
          "inline-flex items-center rounded px-1 py-0.5 text-xs font-medium",
          isBlindLabel
            ? "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300"
            : "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
        )}
      >
        {match[0]}
      </span>,
    );

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts;
}

export function ChangesPanel({
  changesSummary,
  changesReasoning,
}: ChangesPanelProps) {
  return (
    <div className="space-y-6">
      {/* Summary */}
      <div>
        <h4 className="text-sm font-medium mb-2">Changes</h4>
        <div className="prose prose-sm dark:prose-invert max-w-none">
          <Markdown remarkPlugins={[remarkGfm]}>{changesSummary}</Markdown>
        </div>
      </div>

      {/* Reasoning */}
      <div>
        <h4 className="text-sm font-medium mb-2">Reasoning</h4>
        <div className="text-sm text-muted-foreground leading-relaxed">
          {highlightCitations(changesReasoning)}
        </div>
      </div>
    </div>
  );
}
