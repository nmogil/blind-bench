import { useQuery } from "convex/react";
import { useParams, Link } from "react-router-dom";
import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";
import { useProject } from "@/contexts/ProjectContext";
import { StreamingOutputPanel } from "@/components/StreamingOutputPanel";
import { RunStatusPill } from "@/components/RunStatusPill";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft } from "lucide-react";
import { FeedbackSheet } from "@/components/FeedbackSheet";
import { InsightsPanel } from "@/components/InsightsPanel";
import { OnboardingCallout } from "@/components/OnboardingCallout";
import { cn } from "@/lib/utils";

function formatTime(ts: number | undefined): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleTimeString();
}

export function RunView() {
  const { projectId } = useProject();
  const { orgSlug, runId } = useParams<{
    orgSlug: string;
    runId: string;
  }>();

  const run = useQuery(
    api.runs.get,
    runId ? { runId: runId as Id<"promptRuns"> } : "skip",
  );

  if (run === undefined) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-6 w-64" />
        <div className="grid grid-cols-3 gap-4">
          <Skeleton className="h-96" />
          <Skeleton className="h-96" />
          <Skeleton className="h-96" />
        </div>
      </div>
    );
  }

  if (run === null) {
    return (
      <div className="p-6">
        <p className="text-sm text-muted-foreground">Run not found.</p>
        <Link
          to={`/orgs/${orgSlug}/projects/${projectId}/versions`}
          className="text-sm text-primary hover:underline mt-2 inline-block"
        >
          Back to versions
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-3">
          <Link
            to={`/orgs/${orgSlug}/projects/${projectId}/versions/${run.promptVersionId}`}
            className="text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">
                Run &middot; Version {run.versionNumber ?? "?"}
              </span>
              <RunStatusPill status={run.status} />
            </div>
            <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5">
              <span>Test: {run.testCaseName ?? "—"}</span>
              {run.mode === "mix" ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300 px-2 py-0.5 text-[10px] font-medium">
                  Mix & Match
                </span>
              ) : (
                <>
                  <span>Model: {run.model}</span>
                  <span>Temp: {run.temperature}</span>
                </>
              )}
              <span>By: {run.triggeredByName ?? "—"}</span>
              <span>Started: {formatTime(run.startedAt)}</span>
            </div>
          </div>
        </div>
        {run.status === "completed" && (
          <FeedbackSheet
            runId={runId as Id<"promptRuns">}
            versionId={run.promptVersionId}
          />
        )}
      </div>

      {/* Error banner — shown on full failure or partial failure (some outputs failed) */}
      {run.errorMessage && (
        <div className={cn(
          "px-4 py-2 border-b",
          run.status === "failed"
            ? "bg-destructive/10"
            : "bg-amber-50/50 dark:bg-amber-950/10",
        )}>
          <p className={cn(
            "text-sm",
            run.status === "failed" ? "text-destructive" : "text-amber-700 dark:text-amber-400",
          )}>
            {run.status === "completed"
              ? `Some outputs failed: ${run.errorMessage}`
              : run.errorMessage}
          </p>
        </div>
      )}

      {/* Onboarding callouts: Aha moment + Comment */}
      {run.status === "completed" && (
        <div className="px-4 pt-2 space-y-2">
          <OnboardingCallout calloutKey="onboarding_aha_blind_eval">
            These 3 outputs came from the same prompt and model — only the
            randomness differs. They're labeled A, B, C so you evaluate the
            writing, not the version number. This is blind evaluation: the best
            output wins on merit.
          </OnboardingCallout>
          <OnboardingCallout
            calloutKey="onboarding_comment"
            prerequisiteDismissed="onboarding_aha_blind_eval"
          >
            Select any text and press C to leave a comment. When you're done,
            go back to the version editor and click "Request optimization" to
            turn your feedback into a rewritten prompt.
          </OnboardingCallout>
        </div>
      )}

      {/* Dynamic output grid */}
      <div className="flex-1 overflow-auto p-4 space-y-4">
        <div
          className={cn("grid gap-4", {
            "grid-cols-1 sm:grid-cols-2": run.outputs.length === 2,
            "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3": run.outputs.length === 3,
            "grid-cols-1 sm:grid-cols-2 lg:grid-cols-4": run.outputs.length === 4,
            "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5": run.outputs.length >= 5,
          })}
        >
          {run.outputs.map((output) => {
            const isMix = run.mode === "mix";
            return (
              <StreamingOutputPanel
                key={output._id}
                output={output}
                runStatus={run.status}
                canAnnotate={true}
                resolvedModel={isMix ? (output.model ?? run.model) : undefined}
                resolvedTemperature={isMix ? (output.temperature ?? run.temperature) : undefined}
              />
            );
          })}
        </div>

        {/* Post-run AI insights (mix-mode only) */}
        {run.mode === "mix" && run.status === "completed" && (
          <InsightsPanel runId={runId as Id<"promptRuns">} />
        )}
      </div>
    </div>
  );
}
