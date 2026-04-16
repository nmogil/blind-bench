import { useState } from "react";
import { useMutation } from "convex/react";
import { useNavigate } from "react-router-dom";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { friendlyError } from "@/lib/errors";
import { Sparkles, AlertTriangle } from "lucide-react";

interface OptimizeConfirmationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  versionId: Id<"promptVersions">;
  versionNumber: number;
  feedbackCount: {
    outputFeedbackCount: number;
    promptFeedbackCount: number;
    total: number;
  };
  hasMetaContext: boolean;
  orgSlug: string;
  projectId: Id<"projects">;
}

export function OptimizeConfirmationDialog({
  open,
  onOpenChange,
  versionId,
  versionNumber,
  feedbackCount,
  hasMetaContext,
  orgSlug,
  projectId,
}: OptimizeConfirmationDialogProps) {
  const requestOptimization = useMutation(api.optimize.requestOptimization);
  const navigate = useNavigate();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const handleOptimize = async () => {
    setSubmitting(true);
    setError("");
    try {
      const requestId = await requestOptimization({ versionId });
      onOpenChange(false);
      navigate(
        `/orgs/${orgSlug}/projects/${projectId}/optimizations/${requestId}`,
      );
    } catch (err) {
      setError(friendlyError(err));
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Optimize version v{versionNumber}?</DialogTitle>
          <DialogDescription>
            This reads all feedback and meta-context and proposes a new prompt.
            You'll review before anything is saved.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          {/* Input preview */}
          <div className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            <p>
              The optimizer will read{" "}
              <span className="font-medium text-foreground">
                {formatFeedbackSummary(feedbackCount)}
              </span>{" "}
              from v{versionNumber}.
            </p>
          </div>

          {/* Meta context warning */}
          {!hasMetaContext && (
            <div className="flex items-start gap-2 rounded-md border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/10 px-3 py-2">
              <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
              <p className="text-xs text-amber-800 dark:text-amber-300">
                No meta-context set. Meta-context helps ground the rewrite in
                your prompt's intent. You can set it up first, or continue
                without it.
              </p>
            </div>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button onClick={handleOptimize} disabled={submitting}>
            <Sparkles className="mr-1.5 h-3.5 w-3.5" />
            {submitting ? "Starting..." : "Optimize"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function formatFeedbackSummary(counts: {
  outputFeedbackCount: number;
  promptFeedbackCount: number;
}): string {
  const parts: string[] = [];
  if (counts.outputFeedbackCount > 0) {
    parts.push(
      `${counts.outputFeedbackCount} note${counts.outputFeedbackCount === 1 ? "" : "s"} on outputs`,
    );
  }
  if (counts.promptFeedbackCount > 0) {
    parts.push(
      `${counts.promptFeedbackCount} note${counts.promptFeedbackCount === 1 ? "" : "s"} on the prompt`,
    );
  }
  if (parts.length === 0) return "no feedback yet";
  if (parts.length === 1) return parts[0]!;
  return `${parts[0]} and ${parts[1]}`;
}
