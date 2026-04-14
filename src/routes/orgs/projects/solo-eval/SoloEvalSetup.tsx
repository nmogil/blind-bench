import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { useNavigate, useParams, Link } from "react-router-dom";
import { api } from "../../../../../convex/_generated/api";
import { Id } from "../../../../../convex/_generated/dataModel";
import { useProject } from "@/contexts/ProjectContext";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Eye,
  Play,
  Clock,
  AlertCircle,
  ArrowRight,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { friendlyError } from "@/lib/errors";

export function SoloEvalSetup() {
  const { orgSlug } = useParams<{ orgSlug: string }>();
  const { projectId } = useProject();
  const navigate = useNavigate();

  const sessions = useQuery(api.soloEval.listSessions, { projectId });
  const availableRuns = useQuery(api.soloEval.getAvailableRuns, { projectId });
  const createSession = useMutation(api.soloEval.createSession);
  const abandonSession = useMutation(api.soloEval.abandonSession);

  const [selectedRunIds, setSelectedRunIds] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeSession = sessions?.find((s) => s.status === "active");
  const pastSessions = sessions?.filter((s) => s.status !== "active") ?? [];

  const totalOutputs = availableRuns
    ?.filter((r) => selectedRunIds.has(r.runId as string))
    .reduce((sum, r) => sum + r.unratedCount, 0) ?? 0;

  const allSelected =
    availableRuns && availableRuns.length > 0 &&
    availableRuns.every((r) => selectedRunIds.has(r.runId as string));

  function toggleAll() {
    if (allSelected) {
      setSelectedRunIds(new Set());
    } else {
      setSelectedRunIds(
        new Set(availableRuns?.map((r) => r.runId as string) ?? []),
      );
    }
  }

  function toggleRun(runId: string) {
    setSelectedRunIds((prev) => {
      const next = new Set(prev);
      if (next.has(runId)) {
        next.delete(runId);
      } else {
        next.add(runId);
      }
      return next;
    });
  }

  async function handleCreate() {
    setCreating(true);
    setError(null);
    try {
      const runIds = [...selectedRunIds].map(
        (id) => id as Id<"promptRuns">,
      );
      const sessionId = await createSession({
        projectId,
        runIds: runIds.length > 0 ? runIds : undefined,
      });
      navigate(
        `/orgs/${orgSlug}/projects/${projectId}/solo-eval/${sessionId}`,
      );
    } catch (e) {
      setError(friendlyError(e, "Failed to create session."));
    } finally {
      setCreating(false);
    }
  }

  async function handleAbandon(sessionId: Id<"soloEvalSessions">) {
    try {
      await abandonSession({ sessionId });
    } catch {
      // Ignore — session may already be completed
    }
  }

  if (sessions === undefined || availableRuns === undefined) {
    return (
      <div className="p-6 max-w-2xl space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  return (
    <div className="p-6 max-w-2xl">
      <h2 className="text-xl font-bold">Solo Blind Evaluation</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Rate your own outputs without knowing which version produced them.
        Outputs are shuffled across runs and presented one at a time.
      </p>

      {/* Active session banner */}
      {activeSession && (
        <div className="mt-6 rounded-lg border border-primary/30 bg-primary/5 p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">
                You have an active evaluation session
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {activeSession.ratedCount} of {activeSession.totalCount} outputs
                rated
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => handleAbandon(activeSession.sessionId)}
              >
                <Trash2 className="h-3.5 w-3.5 mr-1" />
                Abandon
              </Button>
              <Button
                size="sm"
                onClick={() =>
                  navigate(
                    `/orgs/${orgSlug}/projects/${projectId}/solo-eval/${activeSession.sessionId}`,
                  )
                }
              >
                Continue
                <ArrowRight className="h-3.5 w-3.5 ml-1" />
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Available runs */}
      <div className="mt-6">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Available runs</h3>
          {availableRuns.length > 0 && (
            <button
              type="button"
              onClick={toggleAll}
              className="text-xs text-primary hover:underline"
            >
              {allSelected ? "Deselect all" : "Select all"}
            </button>
          )}
        </div>

        {availableRuns.length === 0 ? (
          <div className="mt-3 rounded-lg border border-dashed p-6 text-center">
            <Eye className="mx-auto h-8 w-8 text-muted-foreground/40" />
            <p className="mt-2 text-sm font-medium text-muted-foreground">
              No unrated outputs available
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Run your prompt versions against test cases to generate outputs,
              then come back here to evaluate them blind.
            </p>
          </div>
        ) : (
          <div className="mt-3 space-y-1.5">
            {availableRuns.map((run) => (
              <label
                key={run.runId}
                className={cn(
                  "flex items-center gap-3 rounded-lg border px-4 py-3 cursor-pointer transition-colors",
                  selectedRunIds.has(run.runId as string)
                    ? "border-primary/30 bg-primary/5"
                    : "hover:bg-muted/50",
                )}
              >
                <Checkbox
                  checked={selectedRunIds.has(run.runId as string)}
                  onCheckedChange={() => toggleRun(run.runId as string)}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">
                      v{run.versionNumber}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {run.testCaseName}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {run.model}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-xs text-muted-foreground">
                      {run.unratedCount} unrated output
                      {run.unratedCount === 1 ? "" : "s"}
                    </span>
                    <span className="text-xs text-muted-foreground/60">
                      <Clock className="inline h-3 w-3 mr-0.5" />
                      {formatRelative(run.completedAt)}
                    </span>
                  </div>
                </div>
              </label>
            ))}
          </div>
        )}
      </div>

      {/* Create session */}
      {availableRuns.length > 0 && !activeSession && (
        <div className="mt-6">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              {selectedRunIds.size > 0
                ? `${totalOutputs} output${totalOutputs === 1 ? "" : "s"} from ${selectedRunIds.size} run${selectedRunIds.size === 1 ? "" : "s"} selected`
                : "Select runs above, or start to include all"}
            </p>
          </div>
          {totalOutputs > 0 && totalOutputs < 6 && (
            <div className="mt-2 flex items-start gap-2 text-xs text-amber-600 dark:text-amber-400">
              <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span>
                Need at least 6 outputs for effective blind evaluation. Select
                more runs or run additional test cases.
              </span>
            </div>
          )}
          {error && (
            <div className="mt-2 flex items-start gap-2 text-xs text-red-600 dark:text-red-400">
              <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
          <Button
            className="mt-3 w-full"
            onClick={handleCreate}
            disabled={creating || (selectedRunIds.size > 0 && totalOutputs < 6)}
          >
            <Play className="h-4 w-4 mr-2" />
            {creating ? "Creating session..." : "Start Blind Evaluation"}
          </Button>
        </div>
      )}

      {/* Past sessions */}
      {pastSessions.length > 0 && (
        <div className="mt-8">
          <h3 className="text-sm font-semibold">Past sessions</h3>
          <div className="mt-3 space-y-1.5">
            {pastSessions.map((session) => (
              <Link
                key={session.sessionId}
                to={
                  session.status === "completed"
                    ? `/orgs/${orgSlug}/projects/${projectId}/solo-eval/${session.sessionId}/results`
                    : `/orgs/${orgSlug}/projects/${projectId}/solo-eval/${session.sessionId}`
                }
                className="flex items-center justify-between rounded-lg border px-4 py-3 hover:bg-muted/50 transition-colors"
              >
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">
                      {session.ratedCount} of {session.totalCount} rated
                    </span>
                    <Badge
                      variant={
                        session.status === "completed"
                          ? "default"
                          : "secondary"
                      }
                      className="text-[10px]"
                    >
                      {session.status}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {formatRelative(session.createdAt)}
                    {session.skippedCount > 0 &&
                      ` · ${session.skippedCount} skipped`}
                  </p>
                </div>
                <ArrowRight className="h-4 w-4 text-muted-foreground" />
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function formatRelative(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
