import { useQuery } from "convex/react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../../../../convex/_generated/api";
import { useProject } from "@/contexts/ProjectContext";
import { CycleStatusPill } from "@/components/CycleStatusPill";
import { EmptyState } from "@/components/EmptyState";
import { buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowRight, ClipboardCheck, Layers, Plus } from "lucide-react";

export function EvaluatePage() {
  const { projectId, role } = useProject();
  const { orgSlug } = useParams<{ orgSlug: string }>();
  const navigate = useNavigate();

  const cycles = useQuery(
    api.reviewCycles.list,
    role !== "evaluator" ? { projectId } : "skip",
  );

  const isLoading = cycles === undefined;

  const basePath = `/orgs/${orgSlug}/projects/${projectId}`;

  const openCycles = cycles?.filter((c) => c.status === "open") ?? [];
  const draftCycles = cycles?.filter((c) => c.status === "draft") ?? [];
  const closedCycles = cycles?.filter((c) => c.status === "closed") ?? [];

  const pastItems: Array<{
    type: "cycle";
    id: string;
    name: string;
    date: number;
    closedAction: string | null;
  }> = closedCycles
    .map((c) => ({
      type: "cycle" as const,
      id: c._id,
      name: c.name,
      date: c.closedAt ?? c.createdAt,
      closedAction: c.closedAction,
    }))
    .sort((a, b) => b.date - a.date);

  if (isLoading) {
    return (
      <div className="p-6 space-y-4">
        <div className="flex items-center justify-between">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-9 w-32" />
        </div>
        <div className="space-y-3">
          {[...Array(3)].map((_, i) => (
            <Skeleton key={i} className="h-20 w-full max-w-2xl" />
          ))}
        </div>
      </div>
    );
  }

  const hasAnything =
    openCycles.length > 0 ||
    draftCycles.length > 0 ||
    pastItems.length > 0;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Evaluate</h1>
        <div className="flex items-center gap-2">
          <Link
            to={`${basePath}/cycles/new`}
            className={buttonVariants({ size: "sm" })}
          >
            <Plus className="mr-1.5 h-4 w-4" />
            New cycle
          </Link>
        </div>
      </div>

      {!hasAnything ? (
        <EmptyState
          icon={ClipboardCheck}
          heading="Pool runs into a Review Cycle to evaluate them blind"
          description="Once you have completed runs, group them here so reviewers can rate outputs without seeing which version produced what."
          action={{
            label: "Start a cycle",
            onClick: () => navigate(`${basePath}/cycles/new`),
          }}
        />
      ) : (
        <div className="max-w-2xl space-y-6">
          {/* Active items — need attention now */}
          {(openCycles.length > 0 || draftCycles.length > 0) && (
            <section className="space-y-3">
              <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                Needs attention
              </h2>

              {/* Open cycles */}
              {openCycles.map((cycle) => (
                <Link
                  key={cycle._id}
                  to={`${basePath}/cycles/${cycle._id}`}
                  className="flex items-center justify-between rounded-lg border border-primary/20 bg-primary/5 px-4 py-3 hover:bg-primary/10 transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <Layers className="h-4 w-4 text-primary shrink-0" />
                      <span className="text-sm font-medium truncate">
                        {cycle.name}
                      </span>
                      <CycleStatusPill status={cycle.status} />
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {cycle.evaluatorProgress.completed}/
                      {cycle.evaluatorProgress.total} evaluators complete
                      {cycle.outputCount > 0 &&
                        ` · ${cycle.outputCount} outputs`}
                    </p>
                  </div>
                  <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />
                </Link>
              ))}

              {/* Draft cycles */}
              {draftCycles.map((cycle) => (
                <Link
                  key={cycle._id}
                  to={`${basePath}/cycles/${cycle._id}`}
                  className="flex items-center justify-between rounded-lg border border-dashed px-4 py-3 hover:bg-muted/50 transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <Layers className="h-4 w-4 text-muted-foreground shrink-0" />
                      <span className="text-sm font-medium truncate">
                        {cycle.name}
                      </span>
                      <CycleStatusPill status={cycle.status} />
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Draft — configure and start when ready
                    </p>
                  </div>
                  <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />
                </Link>
              ))}

            </section>
          )}

          {/* Past evaluations */}
          {pastItems.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                Past evaluations
              </h2>
              {pastItems.map((item) => (
                <Link
                  key={`cycle-${item.id}`}
                  to={`${basePath}/cycles/${item.id}`}
                  className="flex items-center justify-between rounded-lg border px-4 py-3 hover:bg-muted/50 transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <Layers className="h-4 w-4 text-muted-foreground shrink-0" />
                      <span className="text-sm font-medium truncate">
                        {item.name}
                      </span>
                      <CycleStatusPill status="closed" />
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {formatDate(item.date)}
                      {item.closedAction &&
                        ` · ${formatAction(item.closedAction)}`}
                    </p>
                  </div>
                  <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />
                </Link>
              ))}
            </section>
          )}
        </div>
      )}

    </div>
  );
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatAction(action: string): string {
  switch (action) {
    case "optimized":
      return "Optimized";
    case "new_version":
      return "New version created";
    case "no_action":
      return "No action taken";
    default:
      return action;
  }
}
