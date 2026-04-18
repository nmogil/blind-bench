import { useState, useMemo, useEffect, useCallback } from "react";
import { useParams } from "react-router-dom";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { AnnotatedEditor } from "@/components/tiptap/AnnotatedEditor";
import { BlindLabelBadge } from "@/components/BlindLabelBadge";
import { RatingButtons, type Rating } from "@/components/RatingButtons";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { friendlyError } from "@/lib/errors";
import { toast } from "sonner";
import { Check, Send, AlertCircle } from "lucide-react";

function getSessionId(): string {
  const key = "blind-bench-cycle-session-id";
  let id = sessionStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(key, id);
  }
  return id;
}

export function CycleShareableEvalView() {
  const { token } = useParams<{ token: string }>();
  const resolved = useQuery(
    api.cycleShareableLinks.resolveCycleShareableLink,
    token ? { token } : "skip",
  );

  const submitPreferences = useMutation(
    api.cycleShareableLinks.submitAnonymousCyclePreferences,
  );
  const addInvitedFeedback = useMutation(
    api.cycleShareableLinks.addInvitedCycleFeedback,
  );

  const [ratings, setRatings] = useState<Record<string, Rating>>({});
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const sessionId = useMemo(() => getSessionId(), []);

  const isInvitation = resolved?.purpose === "invitation";
  const ratingsLocked = resolved?.ratingsSubmitted ?? false;

  const handleCreateAnnotation = useCallback(
    async (
      cycleBlindLabel: string,
      from: number,
      to: number,
      highlightedText: string,
      comment: string,
    ) => {
      if (!token) return;
      try {
        await addInvitedFeedback({
          token,
          cycleBlindLabel,
          annotationData: { from, to, highlightedText, comment },
        });
      } catch (e) {
        toast.error(friendlyError(e, "Failed to save comment."));
      }
    },
    [token, addInvitedFeedback],
  );

  // Public share route has no app-wide theme provider, so honor the
  // viewer's OS preference directly on <html>.
  useEffect(() => {
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = (dark: boolean) => {
      document.documentElement.classList.toggle("dark", dark);
    };
    apply(mql.matches);
    const listener = (e: MediaQueryListEvent) => apply(e.matches);
    mql.addEventListener("change", listener);
    return () => {
      mql.removeEventListener("change", listener);
      document.documentElement.classList.remove("dark");
    };
  }, []);

  if (resolved === undefined) {
    return (
      <PageShell>
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-96 mt-2" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 mt-6">
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
        </div>
      </PageShell>
    );
  }

  if (resolved === null) {
    return (
      <PageShell>
        <div className="text-center py-12">
          <AlertCircle className="mx-auto h-10 w-10 text-muted-foreground/40" />
          <p className="mt-3 text-sm font-medium text-muted-foreground">
            This link has expired or is no longer available
          </p>
        </div>
      </PageShell>
    );
  }

  // Anonymous (non-invitation) flow: one-shot submit shows a thank-you.
  // Invitation flow: keep the view available so they can continue commenting.
  if (submitted && !isInvitation) {
    return (
      <PageShell>
        <div className="text-center py-12">
          <div className="mx-auto w-12 h-12 rounded-full bg-sky-100 dark:bg-sky-900/30 flex items-center justify-center">
            <Check className="h-6 w-6 text-sky-700 dark:text-sky-300" />
          </div>
          <p className="mt-3 text-lg font-medium">Thank you!</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Your preferences have been recorded.
          </p>
        </div>
      </PageShell>
    );
  }

  const outputCount = resolved.outputs.length;
  const ratedCount = Object.keys(ratings).length;
  const allRated = ratedCount === outputCount;

  const gridCols =
    outputCount <= 3
      ? "grid-cols-1 sm:grid-cols-3"
      : outputCount <= 6
        ? "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3"
        : "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4";

  async function handleSubmit() {
    if (!token) return;
    setSubmitting(true);
    try {
      await submitPreferences({
        token,
        sessionId,
        ratings: Object.entries(ratings).map(
          ([cycleBlindLabel, rating]) => ({
            cycleBlindLabel,
            rating,
          }),
        ),
      });
      setSubmitted(true);
    } catch (e) {
      toast.error(friendlyError(e, "Failed to submit."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <PageShell>
      <h1 className="text-xl font-bold">
        Blind Evaluation — {resolved.projectName}
      </h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {isInvitation
          ? "Rate each output and leave comments by selecting text. Labels are shuffled to remove bias."
          : "Rate each output below. Labels are shuffled to remove bias."}
      </p>

      {ratingsLocked && isInvitation && (
        <div className="mt-4 rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          Your ratings have been recorded. You can still add comments below.
        </div>
      )}

      {/* Progress */}
      {!ratingsLocked && (
        <div className="mt-4 flex items-center gap-3">
          <div
            className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden"
            role="progressbar"
            aria-valuenow={ratedCount}
            aria-valuemin={0}
            aria-valuemax={outputCount}
            aria-label={`${ratedCount} of ${outputCount} outputs rated`}
          >
            <div
              className="h-full bg-primary transition-all duration-300"
              style={{
                width: `${outputCount > 0 ? (ratedCount / outputCount) * 100 : 0}%`,
              }}
            />
          </div>
          <span className="text-xs text-muted-foreground">
            {ratedCount}/{outputCount}
          </span>
        </div>
      )}

      {/* Output grid */}
      <div className={cn("grid gap-4 mt-6", gridCols)}>
        {resolved.outputs.map((output) => (
          <div
            key={output.cycleBlindLabel}
            className="rounded-lg border bg-card flex flex-col"
          >
            <div className="flex items-center justify-between px-3 py-2 border-b">
              <BlindLabelBadge label={output.cycleBlindLabel} />
              <div className="flex items-center gap-2">
                {isInvitation && output.annotations.length > 0 && (
                  <span className="text-xs text-muted-foreground">
                    {output.annotations.length} comment
                    {output.annotations.length !== 1 ? "s" : ""}
                  </span>
                )}
                {ratings[output.cycleBlindLabel] && (
                  <span className="text-xs text-primary">rated</span>
                )}
              </div>
            </div>
            <div className="flex-1 overflow-y-auto sm:max-h-[300px]">
              {isInvitation ? (
                <AnnotatedEditor
                  content={output.outputContentSnapshot}
                  annotations={output.annotations}
                  canAnnotate={true}
                  showAuthor={false}
                  onCreateAnnotation={(from, to, highlightedText, comment) => {
                    handleCreateAnnotation(
                      output.cycleBlindLabel,
                      from,
                      to,
                      highlightedText,
                      comment,
                    );
                  }}
                />
              ) : (
                <p className="p-3 text-sm whitespace-pre-wrap">
                  {output.outputContentSnapshot}
                </p>
              )}
            </div>
            {!ratingsLocked && (
              <div className="px-3 py-2 border-t">
                <RatingButtons
                  currentRating={ratings[output.cycleBlindLabel] ?? null}
                  onRate={(rating) =>
                    setRatings((prev) => ({
                      ...prev,
                      [output.cycleBlindLabel]: rating,
                    }))
                  }
                />
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Submit */}
      {!ratingsLocked && (
        <div className="mt-6">
          <Button
            onClick={handleSubmit}
            disabled={!allRated || submitting}
            className="w-full"
          >
            <Send className="h-4 w-4 mr-2" />
            {submitting
              ? "Submitting..."
              : allRated
                ? "Submit Preferences"
                : `Rate all outputs to submit (${ratedCount}/${outputCount})`}
          </Button>
        </div>
      )}
    </PageShell>
  );
}

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background flex flex-col">
      <div className="border-b px-4 py-3">
        <span className="text-sm font-medium text-muted-foreground">
          Blind Bench — Anonymous Evaluation
        </span>
      </div>
      <div className="max-w-4xl mx-auto p-6 flex-1 w-full">{children}</div>
      <footer className="border-t px-4 py-4 text-center text-[11px] text-muted-foreground">
        By submitting ratings or comments, you agree to the Blind Bench{" "}
        <a
          href="/legal/terms"
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-2 hover:text-foreground"
        >
          Terms
        </a>{" "}
        and{" "}
        <a
          href="/legal/privacy"
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-2 hover:text-foreground"
        >
          Privacy Policy
        </a>
        .
      </footer>
    </div>
  );
}
