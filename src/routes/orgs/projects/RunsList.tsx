import { useQuery } from "convex/react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";
import { useProject } from "@/contexts/ProjectContext";
import { RunStatusPill } from "@/components/RunStatusPill";
import { Skeleton } from "@/components/ui/skeleton";
import { buttonVariants } from "@/components/ui/button";
import { ArrowRight, GitCompareArrows, Play } from "lucide-react";

export function RunsList() {
  const { projectId } = useProject();
  const { orgSlug } = useParams<{ orgSlug: string }>();
  const [searchParams] = useSearchParams();

  // Get all versions to query runs
  const versions = useQuery(api.versions.list, { projectId });

  // Check for multi-version comparison context from RunConfigurator
  const compareParam = searchParams.get("compare");
  const compareVersionIds = compareParam ? compareParam.split(",") : [];

  if (versions === undefined) {
    return (
      <div className="p-6 space-y-3">
        <Skeleton className="h-8 w-48" />
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    );
  }

  // Resolve compared version numbers for the banner
  const compareVersionLabels = compareVersionIds
    .map((id) => {
      const v = versions.find((ver) => ver._id === id);
      return v ? `v${v.versionNumber}` : null;
    })
    .filter(Boolean);

  return (
    <div className="p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Runs</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            View and manage runs across all versions.
          </p>
        </div>
        <Link
          to={`/orgs/${orgSlug}/projects/${projectId}/run`}
          className={buttonVariants({ size: "sm" })}
        >
          <Play className="mr-1.5 h-3.5 w-3.5" />
          New Run
        </Link>
      </div>

      {/* Cycle CTA banner — shown when runs were triggered for multiple versions */}
      {compareVersionIds.length >= 2 && (
        <div className="mt-4 flex items-center justify-between gap-4 rounded-lg border border-primary/30 bg-primary/5 px-4 py-3">
          <div className="flex items-center gap-3 min-w-0">
            <GitCompareArrows className="h-5 w-5 text-primary shrink-0" />
            <div>
              <p className="text-sm font-medium">
                Comparing {compareVersionLabels.join(" vs ")}
              </p>
              <p className="text-xs text-muted-foreground">
                Once runs complete, create a review cycle to get blind
                evaluations.
              </p>
            </div>
          </div>
          <Link
            to={`/orgs/${orgSlug}/projects/${projectId}/cycles/new?primaryVersionId=${compareVersionIds[0]}&controlVersionId=${compareVersionIds[1]}`}
            className={buttonVariants({ size: "sm" })}
          >
            Create Review Cycle
          </Link>
        </div>
      )}

      <div className="mt-6 space-y-2">
        {versions.length === 0 ? (
          <RunsEmptyState orgSlug={orgSlug!} projectId={projectId} />
        ) : (
          <RunsContent
            versions={versions}
            orgSlug={orgSlug!}
            projectId={projectId}
          />
        )}
      </div>
    </div>
  );
}

function RunsContent({
  versions,
  orgSlug,
  projectId,
}: {
  versions: { _id: string; versionNumber: number }[];
  orgSlug: string;
  projectId: string;
}) {
  // Query runs for all versions to check if any exist
  const firstVersionRuns = useQuery(api.runs.list, {
    versionId: versions[0]!._id as Id<"promptVersions">,
  });

  // If there's only one version and it has no runs, show the hint
  // For multiple versions, we show sections + hint as a fallback
  const showHint =
    versions.length === 1 && firstVersionRuns && firstVersionRuns.length === 0;

  if (showHint) {
    return <RunsEmptyState orgSlug={orgSlug} projectId={projectId} />;
  }

  return (
    <>
      {versions.map((version) => (
        <VersionRunsSection
          key={version._id}
          versionId={version._id}
          versionNumber={version.versionNumber}
          orgSlug={orgSlug}
          projectId={projectId}
        />
      ))}
    </>
  );
}

function VersionRunsSection({
  versionId,
  versionNumber,
  orgSlug,
  projectId,
}: {
  versionId: string;
  versionNumber: number;
  orgSlug: string;
  projectId: string;
}) {
  const runs = useQuery(api.runs.list, {
    versionId: versionId as Id<"promptVersions">,
  });

  if (!runs || runs.length === 0) return null;

  return (
    <div className="space-y-1">
      <h3 className="text-xs font-medium text-muted-foreground uppercase">
        Version {versionNumber}
      </h3>
      {runs.slice(0, 5).map((run) => (
        <Link
          key={run._id}
          to={`/orgs/${orgSlug}/projects/${projectId}/runs/${run._id}`}
          className="flex items-center justify-between rounded-md border px-3 py-2 text-sm hover:bg-muted/50 transition-colors"
        >
          <div className="flex items-center gap-3">
            {run.mode === "mix" ? (
              <span className="inline-flex items-center rounded-full bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300 px-1.5 py-0.5 text-[10px] font-medium">
                Mix & Match ({run.slotConfigs?.length ?? 3})
              </span>
            ) : (
              <>
                <span className="font-mono text-xs text-muted-foreground">
                  {run.model.split("/").pop()}
                </span>
                <span className="text-xs text-muted-foreground">
                  T={run.temperature}
                </span>
              </>
            )}
            <span className="text-xs text-muted-foreground">
              {new Date(run._creationTime).toLocaleString()}
            </span>
          </div>
          <RunStatusPill status={run.status} />
        </Link>
      ))}
    </div>
  );
}

// M28.5: pre-activation empty state — actionable copy + a named next step
// (open the versions list so the user can hit Run on a specific version).
function RunsEmptyState({
  orgSlug,
  projectId,
}: {
  orgSlug: string;
  projectId: string;
}) {
  return (
    <div className="max-w-lg space-y-3 rounded-lg border border-dashed p-5">
      <p className="text-sm">
        Click <span className="font-medium">Run</span> on a version to evaluate
        it across three models.
      </p>
      <Link
        to={`/orgs/${orgSlug}/projects/${projectId}/versions`}
        className={buttonVariants({ size: "sm", variant: "outline" })}
      >
        Go to versions
        <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
      </Link>
    </div>
  );
}
