import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { Sparkles, AlertCircle, ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { friendlyError, sanitizeStoredError } from "@/lib/errors";

interface FeedbackDigestProps {
  versionId: Id<"promptVersions">;
  compact?: boolean;
}

const SEVERITY_STYLES = {
  high: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
  medium: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
  low: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
};

export function FeedbackDigest({ versionId, compact = false }: FeedbackDigestProps) {
  const digest = useQuery(api.feedbackDigest.getDigest, { versionId });
  const requestDigest = useMutation(api.feedbackDigest.requestDigest);
  const [requesting, setRequesting] = useState(false);
  const [error, setError] = useState("");

  async function handleRequest() {
    setRequesting(true);
    setError("");
    try {
      await requestDigest({ versionId });
    } catch (err) {
      setError(friendlyError(err, "Failed to request digest."));
    } finally {
      setRequesting(false);
    }
  }

  // Loading
  if (digest === undefined) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }

  // No digest yet — show CTA
  if (!digest) {
    return (
      <div className="rounded-lg border border-dashed p-3 space-y-2">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <Sparkles className="h-4 w-4 text-muted-foreground" />
          AI Feedback Digest
        </div>
        <p className="text-xs text-muted-foreground">
          Generate an AI summary of evaluator feedback to see patterns and recommendations.
        </p>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <Button
          size="sm"
          variant="outline"
          onClick={handleRequest}
          disabled={requesting}
        >
          <Sparkles className="mr-1.5 h-3.5 w-3.5" />
          {requesting ? "Requesting..." : "Generate digest"}
        </Button>
      </div>
    );
  }

  // Pending / Processing
  if (digest.status === "pending" || digest.status === "processing") {
    return (
      <div className="rounded-lg border p-3 space-y-2">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <Sparkles className="h-4 w-4 text-primary animate-pulse" />
          Analyzing feedback...
        </div>
        <div className="space-y-1.5">
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-4/5" />
          <Skeleton className="h-3 w-3/5" />
        </div>
      </div>
    );
  }

  // Failed
  if (digest.status === "failed") {
    return (
      <div className="rounded-lg border border-destructive/30 p-3 space-y-2">
        <div className="flex items-center gap-1.5 text-sm font-medium text-destructive">
          <AlertCircle className="h-4 w-4" />
          Digest failed
        </div>
        <p className="text-xs text-muted-foreground">{sanitizeStoredError(digest.errorMessage)}</p>
        <Button size="sm" variant="outline" onClick={handleRequest}>
          Try again
        </Button>
      </div>
    );
  }

  // Completed — render digest
  if (compact) {
    return (
      <div className="rounded-lg border p-3 space-y-1.5">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <Sparkles className="h-4 w-4 text-primary" />
          Feedback Digest
        </div>
        <p className="text-xs text-muted-foreground">{digest.summary}</p>
        {digest.themes && digest.themes.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {digest.themes.map((theme, i) => (
              <span
                key={i}
                className={cn(
                  "rounded-full px-2 py-0.5 text-[10px] font-medium",
                  SEVERITY_STYLES[theme.severity],
                )}
              >
                {theme.title}
              </span>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-lg border p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <Sparkles className="h-4 w-4 text-primary" />
          Feedback Digest
        </div>
        <Button size="sm" variant="ghost" onClick={handleRequest} disabled={requesting}>
          {requesting ? "Generating..." : "Refresh"}
        </Button>
      </div>

      {/* Summary */}
      <p className="text-sm text-foreground">{digest.summary}</p>

      {/* Preference breakdown */}
      {digest.preferenceBreakdown && (
        <div className="flex items-center gap-3 text-xs">
          <span className="text-green-600 dark:text-green-400">
            Best: {digest.preferenceBreakdown.bestCount}
          </span>
          <span className="text-muted-foreground">
            Acceptable: {digest.preferenceBreakdown.acceptableCount}
          </span>
          <span className="text-amber-600 dark:text-amber-400">
            Weak: {digest.preferenceBreakdown.weakCount}
          </span>
        </div>
      )}

      {/* Themes */}
      {digest.themes && digest.themes.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-xs font-medium uppercase text-muted-foreground">
            Themes
          </h4>
          {digest.themes.map((theme, i) => (
            <ThemeItem key={i} theme={theme} />
          ))}
        </div>
      )}

      {/* Recommendations */}
      {digest.recommendations && digest.recommendations.length > 0 && (
        <div className="space-y-1">
          <h4 className="text-xs font-medium uppercase text-muted-foreground">
            Recommendations
          </h4>
          <ul className="space-y-1">
            {digest.recommendations.map((rec, i) => (
              <li key={i} className="text-sm text-foreground flex gap-2">
                <span className="text-primary shrink-0">-</span>
                {rec}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ThemeItem({
  theme,
}: {
  theme: {
    title: string;
    severity: "high" | "medium" | "low";
    description: string;
    feedbackCount: number;
  };
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-md border p-2">
      <button
        className="flex items-center gap-2 w-full text-left"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
        )}
        <span
          className={cn(
            "rounded-full px-1.5 py-0.5 text-[10px] font-medium",
            SEVERITY_STYLES[theme.severity],
          )}
        >
          {theme.severity}
        </span>
        <span className="text-sm font-medium flex-1">{theme.title}</span>
        <span className="text-xs text-muted-foreground">
          {theme.feedbackCount} item{theme.feedbackCount !== 1 ? "s" : ""}
        </span>
      </button>
      {expanded && (
        <p className="text-xs text-muted-foreground mt-1.5 ml-5">
          {theme.description}
        </p>
      )}
    </div>
  );
}
