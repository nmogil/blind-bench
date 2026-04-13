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
import { OnboardingCallout } from "@/components/OnboardingCallout";

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
              <span>Model: {run.model}</span>
              <span>Temp: {run.temperature}</span>
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

      {/* Error banner */}
      {run.status === "failed" && run.errorMessage && (
        <div className="px-4 py-2 bg-destructive/10 border-b">
          <p className="text-sm text-destructive">{run.errorMessage}</p>
        </div>
      )}

      {/* Onboarding callout: Comment */}
      {run.status === "completed" && (
        <div className="px-4 pt-2 space-y-2">
          <OnboardingCallout calloutKey="onboarding_comment">
            Select any text and press C to leave a comment. When you're done,
            go back to the version editor and click "Request optimization" to
            turn your feedback into a rewritten prompt.
          </OnboardingCallout>
        </div>
      )}

      {/* Three-column output grid */}
      <div className="flex-1 overflow-hidden p-4">
        <div className="grid grid-cols-3 gap-4 h-full">
          {run.outputs.map((output) => (
            <StreamingOutputPanel
              key={output._id}
              output={output}
              runStatus={run.status}
              canAnnotate={true}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
