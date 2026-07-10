/**
 * #267 (M31.4): list of imported agent trajectories in a project. Links each to
 * its step-level review view. For blind reviewers the backend strips
 * product/harness/model, so those rows show only "Trajectory · N steps".
 */
import { useQuery } from "convex/react";
import { Link, useParams } from "react-router-dom";
import { api } from "../../../convex/_generated/api";
import { useProject } from "@/contexts/ProjectContext";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Route, ArrowRight, Upload } from "lucide-react";

type TraceStatus = "pending" | "ready" | "failed";

function StatusBadge({ status }: { status: TraceStatus }) {
  if (status === "failed") {
    return <Badge variant="destructive">Failed</Badge>;
  }
  if (status === "pending") {
    return <Badge variant="outline">Processing</Badge>;
  }
  return <Badge variant="secondary">Ready</Badge>;
}

export function TraceList() {
  const { projectId } = useProject();
  const { orgSlug } = useParams<{ orgSlug: string }>();
  const traces = useQuery(api.agentTraces.listTraces, { projectId });

  const base = `/orgs/${orgSlug}`;
  const projectBase = `${base}/projects/${projectId}`;

  return (
    <div className="mx-auto max-w-3xl p-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Route aria-hidden="true" className="h-5 w-5 text-primary" />
            <h1 className="text-2xl font-bold">Runs</h1>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Completed AI behavior from your existing systems. A run may be one
            response or a multi-step agent trace with tool calls.
          </p>
        </div>
        <Link
          to={`${projectBase}/import`}
          className={buttonVariants({ size: "sm", variant: "outline" })}
        >
          <Upload aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
          Import
        </Link>
      </header>

      <div className="mt-6">
        {traces === undefined ? (
          <div className="space-y-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : traces.length === 0 ? (
          <div className="max-w-lg space-y-3 rounded-lg border border-dashed p-6">
            <p className="text-sm">
              Add completed runs from the systems you already use, then create a
              blind review for the people whose judgment matters.
            </p>
            <Link
              to={`${projectBase}/import`}
              className={buttonVariants({ size: "sm" })}
            >
              <Upload aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
              Import completed runs
            </Link>
          </div>
        ) : (
          <ul className="space-y-2">
            {traces.map((t) => {
              const provenance = [t.product, t.harnessName, t.model].filter(
                Boolean,
              );
              return (
                <li key={t._id}>
                  <Link
                    to={`${projectBase}/traces/${t._id}`}
                    className="flex items-center justify-between gap-4 rounded-lg border bg-card px-4 py-3 transition-colors hover:bg-muted/50"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {provenance.length > 0
                          ? provenance.join(" · ")
                          : "Imported run"}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {t.stepCount} {t.stepCount === 1 ? "step" : "steps"} ·{" "}
                        {new Date(t.createdAt).toLocaleString()}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <StatusBadge status={t.status} />
                      <ArrowRight
                        aria-hidden="true"
                        className="h-4 w-4 text-muted-foreground"
                      />
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
