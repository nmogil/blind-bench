import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { ChevronDown, ChevronRight, Sparkles } from "lucide-react";
import { sanitizeStoredError } from "@/lib/errors";

interface InsightsPanelProps {
  runId: Id<"promptRuns">;
}

export function InsightsPanel({ runId }: InsightsPanelProps) {
  const insights = useQuery(api.runInsights.getInsights, { runId });
  const [expanded, setExpanded] = useState(true);

  if (!insights) return null;

  if (insights.status === "pending" || insights.status === "processing") {
    return (
      <div className="rounded-lg border bg-card p-4 space-y-2">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-violet-500 animate-pulse" />
          <span className="text-sm font-medium">Analyzing outputs...</span>
        </div>
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    );
  }

  if (insights.status === "failed") {
    return (
      <div className="rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3">
        <p className="text-xs text-destructive">
          Failed to generate insights: {sanitizeStoredError(insights.errorMessage)}
        </p>
      </div>
    );
  }

  if (!insights.insightContent) return null;

  return (
    <div className="rounded-lg border bg-card">
      <button
        className="flex items-center gap-2 w-full px-4 py-3 text-left hover:bg-muted/50 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        )}
        <Sparkles className="h-4 w-4 text-violet-500" />
        <span className="text-sm font-medium">AI Insights</span>
      </button>

      {expanded && (
        <div
          className={cn(
            "px-4 pb-4 text-sm prose prose-sm dark:prose-invert max-w-none",
            "[&_h3]:text-sm [&_h3]:font-semibold [&_h3]:mt-3 [&_h3]:mb-1",
            "[&_p]:text-muted-foreground [&_p]:leading-relaxed",
            "[&_strong]:text-foreground",
          )}
          dangerouslySetInnerHTML={{
            __html: markdownToHtml(insights.insightContent),
          }}
        />
      )}
    </div>
  );
}

/**
 * Minimal markdown → HTML for insight content.
 * Handles: headers, bold, paragraphs, lists.
 */
function markdownToHtml(md: string): string {
  return md
    .replace(/### (.+)/g, "<h3>$1</h3>")
    .replace(/## (.+)/g, "<h3>$1</h3>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/^- (.+)/gm, "<li>$1</li>")
    .replace(/(<li>.*<\/li>\n?)+/g, "<ul>$&</ul>")
    .replace(/\n\n/g, "</p><p>")
    .replace(/^(?!<[hul])(.+)$/gm, "<p>$1</p>")
    .replace(/<p><\/p>/g, "");
}
