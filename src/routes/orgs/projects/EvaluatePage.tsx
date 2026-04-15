import { useState } from "react";
import { useQuery } from "convex/react";
import { Link, useParams } from "react-router-dom";
import { api } from "../../../../convex/_generated/api";
import { useProject } from "@/contexts/ProjectContext";
import { CycleStatusPill } from "@/components/CycleStatusPill";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SendEvaluationDialog } from "@/components/SendEvaluationDialog";
import {
  ArrowRight,
  ClipboardCheck,
  Layers,
  Mail,
  Plus,
  Star,
} from "lucide-react";

export function EvaluatePage() {
  const { projectId, role } = useProject();
  const { orgSlug } = useParams<{ orgSlug: string }>();
  const [sendDialogOpen, setSendDialogOpen] = useState(false);

  const cycles = useQuery(
    api.reviewCycles.list,
    role !== "evaluator" ? { projectId } : "skip",
  );
  const soloSessions = useQuery(
    api.soloEval.listSessions,
    role !== "evaluator" ? { projectId } : "skip",
  );
  const hasUnrated = useQuery(
    api.soloEval.hasAvailableOutputs,
    role !== "evaluator" ? { projectId } : "skip",
  );

  const isLoading =
    cycles === undefined ||
    soloSessions === undefined ||
    hasUnrated === undefined;

  const basePath = `/orgs/${orgSlug}/projects/${projectId}`;

  // Split cycles into active vs past
  const openCycles = cycles?.filter((c) => c.status === "open") ?? [];
  const draftCycles = cycles?.filter((c) => c.status === "draft") ?? [];
  const closedCycles = cycles?.filter((c) => c.status === "closed") ?? [];
  const completedSessions = soloSessions?.filter(
    (s) => s.status === "completed",
  ) ?? [];

  // Build a merged "past" list sorted by date descending
  const pastItems: Array<
    | { type: "cycle"; id: string; name: string; date: number; closedAction: string | null }
    | { type: "session"; id: string; count: number; date: number }
  > = [
    ...closedCycles.map((c) => ({
      type: "cycle" as const,
      id: c._id,
      name: c.name,
      date: c.closedAt ?? c.createdAt,
      closedAction: c.closedAction,
    })),
    ...completedSessions.map((s) => ({
      type: "session" as const,
      id: s.sessionId,
      count: s.totalCount,
      date: s.completedAt ?? s.createdAt,
    })),
  ].sort((a, b) => b.date - a.date);

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
    hasUnrated ||
    pastItems.length > 0;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Evaluate</h1>
        <div className="flex items-center gap-2">
          {openCycles.length > 0 && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setSendDialogOpen(true)}
            >
              <Mail className="h-3.5 w-3.5 mr-1.5" />
              Send evaluation
            </Button>
          )}
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
          heading="No evaluations yet"
          description="Run your prompt first, then come back here to evaluate outputs blind. You can evaluate solo or invite your team via a Review Cycle."
        />
      ) : (
        <div className="max-w-2xl space-y-6">
          {/* Active items — need attention now */}
          {(openCycles.length > 0 || draftCycles.length > 0 || hasUnrated) && (
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

              {/* Solo eval CTA */}
              {hasUnrated && (
                <Link
                  to={`${basePath}/solo-eval`}
                  className="flex items-center justify-between rounded-lg border border-yellow-300/40 bg-yellow-50/50 dark:border-yellow-800/30 dark:bg-yellow-950/10 px-4 py-3 hover:bg-yellow-50 dark:hover:bg-yellow-950/20 transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <Star className="h-4 w-4 text-yellow-600 dark:text-yellow-400 shrink-0" />
                      <span className="text-sm font-medium">
                        Unrated outputs available
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Quick solo evaluation — rate outputs blind
                    </p>
                  </div>
                  <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />
                </Link>
              )}
            </section>
          )}

          {/* Past evaluations */}
          {pastItems.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                Past evaluations
              </h2>
              {pastItems.map((item) =>
                item.type === "cycle" ? (
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
                ) : (
                  <Link
                    key={`session-${item.id}`}
                    to={`${basePath}/solo-eval/${item.id}/results`}
                    className="flex items-center justify-between rounded-lg border px-4 py-3 hover:bg-muted/50 transition-colors"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <Star className="h-4 w-4 text-muted-foreground shrink-0" />
                        <span className="text-sm font-medium">
                          Solo evaluation ({item.count} outputs)
                        </span>
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {formatDate(item.date)}
                      </p>
                    </div>
                    <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />
                  </Link>
                ),
              )}
            </section>
          )}
        </div>
      )}

      <SendEvaluationDialog
        open={sendDialogOpen}
        onOpenChange={setSendDialogOpen}
        projectId={projectId}
        showTargetPicker
      />
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
