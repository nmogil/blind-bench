import { useQuery } from "convex/react";
import { Link, useParams } from "react-router-dom";
import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";
import { useProject } from "@/contexts/ProjectContext";
import { RunStatusPill } from "@/components/RunStatusPill";
import { Skeleton } from "@/components/ui/skeleton";

export function RunsList() {
  const { projectId } = useProject();
  const { orgSlug } = useParams<{ orgSlug: string }>();

  // Get all versions to query runs
  const versions = useQuery(api.versions.list, { projectId });

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

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold">Runs</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        View runs across all versions. Start a run from the version editor.
      </p>

      <div className="mt-6 space-y-2">
        {versions.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Create a version and run it to see results here.
          </p>
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
    return (
      <p className="text-sm text-muted-foreground">
        No runs yet. Open a version and click "Run prompt" to see results here.
      </p>
    );
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
