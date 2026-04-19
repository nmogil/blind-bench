import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { api } from "../../../../../convex/_generated/api";
import { Id } from "../../../../../convex/_generated/dataModel";
import { useProject } from "@/contexts/ProjectContext";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { CycleStatusPill } from "@/components/CycleStatusPill";
import { BlindLabelBadge } from "@/components/BlindLabelBadge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ArrowLeft,
  StopCircle,
  Play,
  Wand2,
  Plus,
  X,
  Bell,
  Mail,
  ChevronDown,
  ChevronRight,
  MessageSquare,
  Sparkles,
} from "lucide-react";
import { InviteDialog } from "@/components/InviteDialog";
import { FeedbackItem } from "@/components/FeedbackItem";
import { cn } from "@/lib/utils";
import { friendlyError } from "@/lib/errors";
import { toast } from "sonner";

export function CycleDetail() {
  const { orgSlug, cycleId } = useParams<{
    orgSlug: string;
    cycleId: string;
  }>();
  const { projectId } = useProject();
  const navigate = useNavigate();

  const cycle = useQuery(
    api.reviewCycles.get,
    cycleId ? { cycleId: cycleId as Id<"reviewCycles"> } : "skip",
  );
  const evaluatorProgress = useQuery(
    api.reviewCycles.getEvaluatorProgress,
    cycleId ? { cycleId: cycleId as Id<"reviewCycles"> } : "skip",
  );
  const cycleFeedback = useQuery(
    api.reviewCycles.listCycleFeedback,
    cycleId ? { cycleId: cycleId as Id<"reviewCycles"> } : "skip",
  );
  const matchupStats = useQuery(
    api.reviewSessions.getCycleMatchupStats,
    cycleId ? { cycleId: cycleId as Id<"reviewCycles"> } : "skip",
  );

  const closeCycle = useMutation(api.reviewCycles.close);
  const setClosedAction = useMutation(api.reviewCycles.setClosedAction);
  const startCycle = useMutation(api.reviewCycles.start);
  const sendReminder = useMutation(api.reviewCycles.sendReminder);
  const sendReminderAll = useMutation(api.reviewCycles.sendReminderAll);
  const toggleSoloEval = useMutation(api.reviewCycles.toggleSoloEval);

  const [closing, setClosing] = useState(false);
  const [sendDialogOpen, setSendDialogOpen] = useState(false);
  const [sendingReminderId, setSendingReminderId] = useState<string | null>(
    null,
  );
  const [sendingAll, setSendingAll] = useState(false);
  const [confirmRemindAll, setConfirmRemindAll] = useState(false);
  const [togglingsolo, setTogglingSolo] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (cycle === undefined || evaluatorProgress === undefined) {
    return (
      <div className="p-6 max-w-4xl space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-60 w-full" />
      </div>
    );
  }

  if (cycle === null) {
    return (
      <div className="p-6">
        <p className="text-sm text-muted-foreground">Cycle not found.</p>
        <Link
          to={`/orgs/${orgSlug}/projects/${projectId}/cycles`}
          className="text-sm text-primary hover:underline mt-2 block"
        >
          Back to cycles
        </Link>
      </div>
    );
  }

  async function handleClose() {
    setClosing(true);
    setError(null);
    try {
      await closeCycle({ cycleId: cycleId as Id<"reviewCycles"> });
      toast.success("Cycle closed");
    } catch (e) {
      setError(friendlyError(e, "Failed to close cycle."));
    } finally {
      setClosing(false);
    }
  }

  async function handleStart() {
    setError(null);
    try {
      await startCycle({ cycleId: cycleId as Id<"reviewCycles"> });
      toast.success("Cycle started");
    } catch (e) {
      setError(friendlyError(e, "Failed to start cycle."));
    }
  }

  async function handleClosedAction(
    action: "new_version_manual" | "optimizer_requested" | "no_action",
  ) {
    try {
      const result = await setClosedAction({
        cycleId: cycleId as Id<"reviewCycles">,
        action,
      });
      if (action === "new_version_manual") {
        navigate(
          `/orgs/${orgSlug}/projects/${projectId}/versions?parentVersionId=${cycle!.primaryVersionId}`,
        );
      } else if (action === "optimizer_requested") {
        toast.success("Optimizer triggered from cycle feedback");
        if (result?.optimizationRequestId) {
          navigate(
            `/orgs/${orgSlug}/projects/${projectId}/optimizations/${result.optimizationRequestId}`,
          );
        }
      } else {
        toast.info("No action taken");
      }
    } catch (e) {
      toast.error(friendlyError(e, "Failed to set action."));
    }
  }

  const REMINDER_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hours
  const MAX_REMINDERS = 3;

  function isReminderDisabled(evaluator: {
    lastReminderSentAt: number | null;
    reminderCount: number;
    status: string;
  }) {
    if (evaluator.status === "completed") return true;
    if (evaluator.reminderCount >= MAX_REMINDERS) return true;
    if (
      evaluator.lastReminderSentAt &&
      Date.now() - evaluator.lastReminderSentAt < REMINDER_COOLDOWN_MS
    )
      return true;
    return false;
  }

  function reminderTooltip(evaluator: {
    lastReminderSentAt: number | null;
    reminderCount: number;
    status: string;
  }) {
    if (evaluator.status === "completed") return "Already completed";
    if (evaluator.reminderCount >= MAX_REMINDERS)
      return "Maximum reminders sent";
    if (
      evaluator.lastReminderSentAt &&
      Date.now() - evaluator.lastReminderSentAt < REMINDER_COOLDOWN_MS
    ) {
      const readyAt = new Date(
        evaluator.lastReminderSentAt + REMINDER_COOLDOWN_MS,
      );
      return `Cooldown until ${readyAt.toLocaleTimeString()}`;
    }
    return null;
  }

  async function handleSendReminder(evaluatorId: string) {
    setSendingReminderId(evaluatorId);
    try {
      await sendReminder({
        cycleId: cycleId as Id<"reviewCycles">,
        evaluatorId: evaluatorId as Id<"users">,
      });
      toast.success("Reminder sent");
    } catch (e) {
      toast.error(friendlyError(e, "Failed to send reminder."));
    } finally {
      setSendingReminderId(null);
    }
  }

  async function handleSendReminderAll() {
    setConfirmRemindAll(false);
    setSendingAll(true);
    try {
      await sendReminderAll({
        cycleId: cycleId as Id<"reviewCycles">,
      });
      toast.success("Reminders sent to pending evaluators");
    } catch (e) {
      toast.error(friendlyError(e, "Failed to send reminders."));
    } finally {
      setSendingAll(false);
    }
  }

  async function handleToggleSoloEval() {
    if (!cycle) return;
    setTogglingSolo(true);
    try {
      await toggleSoloEval({
        cycleId: cycleId as Id<"reviewCycles">,
        includeSoloEval: !cycle.includeSoloEval,
      });
      toast.success(
        cycle.includeSoloEval
          ? "Solo evaluation data removed"
          : "Solo evaluation data imported",
      );
    } catch (e) {
      toast.error(friendlyError(e, "Failed to toggle solo eval."));
    } finally {
      setTogglingSolo(false);
    }
  }

  const completedCount =
    evaluatorProgress?.filter((e) => e.status === "completed").length ?? 0;
  const totalEvaluators = evaluatorProgress?.length ?? 0;

  return (
    <div className="p-6 max-w-4xl">
      {/* Header */}
      <Link
        to={`/orgs/${orgSlug}/projects/${projectId}/cycles`}
        className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to cycles
      </Link>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h2 className="text-xl font-bold">{cycle.name}</h2>
          <CycleStatusPill status={cycle.status} />
        </div>
        <div className="flex items-center gap-2">
          {cycle.status === "draft" && (
            <Button size="sm" onClick={handleStart}>
              <Play className="h-3.5 w-3.5 mr-1.5" />
              Start Cycle
            </Button>
          )}
          {cycle.status === "open" && (
            <>
              <Link
                to={`/review/start/cycle/${cycleId}`}
                className={buttonVariants({ size: "sm", variant: "outline" })}
              >
                <Sparkles className="h-3.5 w-3.5 mr-1.5" />
                Review this cycle
              </Link>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setSendDialogOpen(true)}
              >
                <Mail className="h-3.5 w-3.5 mr-1.5" />
                Invite reviewers
              </Button>
              <Button
                size="sm"
                variant="destructive"
                onClick={handleClose}
                disabled={closing}
              >
                <StopCircle className="h-3.5 w-3.5 mr-1.5" />
                {closing ? "Closing..." : "Close Cycle"}
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Metadata */}
      <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
        <Link
          to={`/orgs/${orgSlug}/projects/${projectId}/versions/${cycle.primaryVersionId}?tab=feedback`}
          className="hover:text-foreground hover:underline transition-colors"
        >
          v{cycle.primaryVersionNumber}
          {cycle.controlVersionNumber
            ? ` vs v${cycle.controlVersionNumber}`
            : ""}
        </Link>
        <span>{cycle.outputs.length} outputs</span>
        {cycle.openedAt && (
          <span>
            Opened {new Date(cycle.openedAt).toLocaleDateString()}
          </span>
        )}
        {cycle.closedAt && (
          <span>
            Closed {new Date(cycle.closedAt).toLocaleDateString()}
          </span>
        )}
      </div>

      {error && (
        <div className="mt-3 text-sm text-destructive">{error}</div>
      )}

      {/* Section 1: Evaluator Progress */}
      {(cycle.status === "open" || cycle.status === "closed") &&
        evaluatorProgress &&
        evaluatorProgress.length > 0 && (
          <div className="mt-8">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold">
                Evaluator Progress{" "}
                <span className="font-normal text-muted-foreground">
                  — {completedCount} of {totalEvaluators} complete
                </span>
              </h3>
              {cycle.status === "open" && (
                <>
                  {confirmRemindAll ? (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">
                        Send reminders to all pending?
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={handleSendReminderAll}
                        disabled={sendingAll}
                      >
                        {sendingAll ? "Sending..." : "Confirm"}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setConfirmRemindAll(false)}
                      >
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setConfirmRemindAll(true)}
                      disabled={sendingAll}
                    >
                      <Bell className="h-3.5 w-3.5 mr-1.5" />
                      Remind All Pending
                    </Button>
                  )}
                </>
              )}
            </div>
            <div className="rounded-lg border divide-y">
              {evaluatorProgress.map((evaluator) => {
                const disabled = isReminderDisabled(evaluator);
                const tooltip = reminderTooltip(evaluator);
                return (
                  <div
                    key={evaluator.userId}
                    className="flex items-center justify-between px-4 py-3"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">
                          {evaluator.userName ?? "Unknown"}
                        </p>
                        {evaluator.userEmail && (
                          <p className="text-xs text-muted-foreground truncate">
                            {evaluator.userEmail}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      {/* Progress bar */}
                      <div className="w-24 flex items-center gap-2">
                        <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                          <div
                            className="h-full bg-primary transition-all"
                            style={{
                              width: `${evaluator.totalCount > 0 ? (evaluator.ratedCount / evaluator.totalCount) * 100 : 0}%`,
                            }}
                          />
                        </div>
                        <span className="text-xs text-muted-foreground whitespace-nowrap">
                          {evaluator.ratedCount}/{evaluator.totalCount}
                        </span>
                      </div>
                      <Badge
                        variant="secondary"
                        className={cn(
                          "text-[10px]",
                          evaluator.status === "completed" &&
                            "bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300",
                          evaluator.status === "in_progress" &&
                            "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
                        )}
                      >
                        {evaluator.status.replace("_", " ")}
                      </Badge>
                      {cycle.status === "open" &&
                        evaluator.status !== "completed" && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-xs"
                            disabled={disabled || sendingReminderId === evaluator.userId}
                            title={tooltip ?? "Send reminder email"}
                            onClick={() =>
                              handleSendReminder(evaluator.userId)
                            }
                          >
                            <Bell className="h-3 w-3 mr-1" />
                            {sendingReminderId === evaluator.userId
                              ? "..."
                              : `(${evaluator.reminderCount}/${MAX_REMINDERS})`}
                          </Button>
                        )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

      {/* Solo Eval Toggle */}
      {(cycle.status === "draft" || cycle.status === "open") && (
        <div className="mt-6">
          <div className="flex items-center justify-between rounded-lg border p-4">
            <div>
              <p className="text-sm font-medium">
                Include Solo Evaluation Data
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Import your blind self-evaluation ratings into this cycle.
              </p>
            </div>
            <Checkbox
              checked={cycle.includeSoloEval}
              disabled={togglingsolo}
              onCheckedChange={handleToggleSoloEval}
            />
          </div>
        </div>
      )}
      {cycle.status === "closed" && cycle.includeSoloEval && (
        <div className="mt-6 rounded-lg border p-4 bg-muted/30">
          <p className="text-xs text-muted-foreground">
            Solo evaluation data was included in this cycle.
          </p>
        </div>
      )}

      {/* Section 2: Output Results (version reveal for author) */}
      <div className="mt-8">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold">Output Results</h3>
          {cycleFeedback && cycleFeedback.totalCount > 0 && (
            <a
              href="#reviewer-comments"
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <MessageSquare className="h-3 w-3" />
              {cycleFeedback.totalCount} comment
              {cycleFeedback.totalCount !== 1 ? "s" : ""}
            </a>
          )}
        </div>
        <div className="rounded-lg border divide-y">
          {cycle.outputs.map((output) => (
            <div
              key={output._id}
              className="px-4 py-3"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <BlindLabelBadge label={output.cycleBlindLabel} />
                  <Badge
                    variant="outline"
                    className="text-[10px]"
                  >
                    v{output.sourceVersionNumber}
                    {output.isPrimaryVersion
                      ? " (primary)"
                      : " (control)"}
                  </Badge>
                  {output.sourceModel && (
                    <span className="text-xs text-muted-foreground">
                      {output.sourceModel}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-sky-700 dark:text-sky-300">
                    {output.ratings.best} best
                  </span>
                  <span className="text-muted-foreground">
                    {output.ratings.acceptable} ok
                  </span>
                  <span className="text-amber-600 dark:text-amber-400">
                    {output.ratings.weak} weak
                  </span>
                </div>
              </div>
              <p className="mt-2 text-sm text-muted-foreground line-clamp-2">
                {output.outputContentSnapshot.slice(0, 200)}
                {output.outputContentSnapshot.length > 200 ? "..." : ""}
              </p>
            </div>
          ))}
        </div>
      </div>

      {/* Phase 2 Battle Results */}
      <BattleResultsSection stats={matchupStats} />

      {/* Reviewer Comments */}
      <ReviewerCommentsSection feedback={cycleFeedback} />

      {/* Section 3: End-of-Cycle Actions */}
      {cycle.status === "closed" && !cycle.closedAction && (
        <div className="mt-8">
          <h3 className="text-sm font-semibold mb-3">
            What would you like to do next?
          </h3>
          <div className="grid grid-cols-3 gap-3">
            <button
              type="button"
              onClick={() => handleClosedAction("new_version_manual")}
              className="rounded-lg border p-4 text-left hover:bg-muted/50 transition-colors"
            >
              <Plus className="h-5 w-5 text-primary mb-2" />
              <p className="text-sm font-medium">Create New Version</p>
              <p className="text-xs text-muted-foreground mt-1">
                Manually iterate based on feedback
              </p>
            </button>
            <button
              type="button"
              onClick={() => handleClosedAction("optimizer_requested")}
              className="rounded-lg border p-4 text-left hover:bg-muted/50 transition-colors"
            >
              <Wand2 className="h-5 w-5 text-primary mb-2" />
              <p className="text-sm font-medium">Run Optimizer</p>
              <p className="text-xs text-muted-foreground mt-1">
                AI-generate improvements from feedback
              </p>
            </button>
            <button
              type="button"
              onClick={() => handleClosedAction("no_action")}
              className="rounded-lg border p-4 text-left hover:bg-muted/50 transition-colors"
            >
              <X className="h-5 w-5 text-muted-foreground mb-2" />
              <p className="text-sm font-medium">No Action</p>
              <p className="text-xs text-muted-foreground mt-1">
                Close without further steps
              </p>
            </button>
          </div>
        </div>
      )}

      {cycle.status === "closed" && cycle.closedAction && (
        <div className="mt-8 rounded-lg border p-4 bg-muted/30">
          <p className="text-sm text-muted-foreground">
            Action taken:{" "}
            <span className="font-medium text-foreground">
              {cycle.closedAction === "optimizer_requested"
                ? "Optimizer requested"
                : cycle.closedAction === "new_version_manual"
                  ? "New version created"
                  : "No action"}
            </span>
          </p>
        </div>
      )}

      <InviteDialog
        open={sendDialogOpen}
        onOpenChange={setSendDialogOpen}
        scope="cycle"
        scopeId={cycleId as string}
        allowShareable
      />
    </div>
  );
}

type CycleFeedback = {
  totalCount: number;
  outputCount: number;
  outputs: Array<{
    cycleOutputId: string;
    cycleBlindLabel: string;
    sourceVersionNumber: number | null;
    isPrimaryVersion: boolean;
    comments: Array<{
      _id: string;
      authorLabel: string;
      source: "evaluator" | "anonymous" | "invited" | "solo" | "author";
      rating: "best" | "acceptable" | "weak" | null;
      highlightedText: string;
      comment: string;
      tags: string[];
      targetKind: "inline" | "overall";
      createdAt: number;
    }>;
  }>;
};

function ReviewerCommentsSection({
  feedback,
}: {
  feedback: CycleFeedback | undefined;
}) {
  if (feedback === undefined) {
    return (
      <div className="mt-8">
        <h3 className="text-sm font-semibold mb-3">Reviewer Comments</h3>
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  return (
    <div className="mt-8 scroll-mt-6" id="reviewer-comments">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold">
          Reviewer Comments{" "}
          {feedback.totalCount > 0 && (
            <span className="font-normal text-muted-foreground">
              — {feedback.totalCount} across {feedback.outputCount} output
              {feedback.outputCount !== 1 ? "s" : ""}
            </span>
          )}
        </h3>
      </div>
      {feedback.totalCount === 0 ? (
        <div className="rounded-lg border border-dashed p-6 text-center">
          <p className="text-sm text-muted-foreground">
            No written comments yet. Reviewers can highlight text while
            rating to leave inline feedback.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {feedback.outputs
            .filter((o) => o.comments.length > 0)
            .map((output) => (
              <OutputCommentGroup
                key={output.cycleOutputId}
                output={output}
                defaultOpen={feedback.totalCount <= 20}
              />
            ))}
        </div>
      )}
    </div>
  );
}

function OutputCommentGroup({
  output,
  defaultOpen,
}: {
  output: CycleFeedback["outputs"][number];
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="rounded-lg border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-muted/50 transition-colors rounded-lg"
      >
        <div className="flex items-center gap-3">
          {open ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
          <BlindLabelBadge label={output.cycleBlindLabel} />
          {output.sourceVersionNumber !== null && (
            <Badge variant="outline" className="text-[10px]">
              v{output.sourceVersionNumber}
              {output.isPrimaryVersion ? " (primary)" : " (control)"}
            </Badge>
          )}
        </div>
        <span className="text-xs text-muted-foreground">
          {output.comments.length} comment
          {output.comments.length !== 1 ? "s" : ""}
        </span>
      </button>
      {open && (
        <div className="border-t px-4 py-3 space-y-2">
          {output.comments.map((c) => {
            const sourceBase = sourceHintFor(c.source);
            const hint =
              c.targetKind === "overall"
                ? sourceBase
                  ? `${sourceBase} · overall note`
                  : "overall note"
                : sourceBase;
            return (
              <FeedbackItem
                key={c._id}
                authorLabel={c.authorLabel}
                highlightedText={
                  c.targetKind === "overall" ? "" : c.highlightedText
                }
                comment={c.comment}
                createdAt={c.createdAt}
                rating={c.rating}
                tags={c.tags}
                sourceHint={hint}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

type MatchupStats = {
  totalSessions: number;
  phase2Sessions: number;
  decidedCount: number;
  skipCount: number;
  outputs: Array<{
    cycleOutputId: string;
    cycleBlindLabel: string;
    wins: number;
    losses: number;
    ties: number;
    battles: number;
  }>;
};

function BattleResultsSection({ stats }: { stats: MatchupStats | undefined }) {
  if (stats === undefined) return null;
  if (stats.phase2Sessions === 0) return null;

  return (
    <div className="mt-8">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold">
          Battle Results{" "}
          <span className="font-normal text-muted-foreground">
            — {stats.decidedCount} decided across {stats.phase2Sessions}{" "}
            session{stats.phase2Sessions !== 1 ? "s" : ""}
            {stats.skipCount > 0 && ` (${stats.skipCount} skipped)`}
          </span>
        </h3>
      </div>
      {stats.outputs.length === 0 ? (
        <div className="rounded-lg border border-dashed p-6 text-center">
          <p className="text-sm text-muted-foreground">
            Battle rounds haven't produced decided matchups yet.
          </p>
        </div>
      ) : (
        <div className="rounded-lg border divide-y">
          {stats.outputs.map((row) => {
            const total = row.battles || 1;
            const winPct = Math.round((row.wins / total) * 100);
            return (
              <div
                key={row.cycleOutputId}
                className="flex items-center justify-between px-4 py-3"
              >
                <div className="flex items-center gap-3">
                  <BlindLabelBadge label={row.cycleBlindLabel} />
                  <span className="text-xs text-muted-foreground">
                    {row.battles} battle{row.battles !== 1 ? "s" : ""}
                  </span>
                </div>
                <div className="flex items-center gap-4 text-xs">
                  <span className="text-sky-700 dark:text-sky-300">
                    {row.wins}W
                  </span>
                  <span className="text-muted-foreground">{row.ties}T</span>
                  <span className="text-amber-600 dark:text-amber-400">
                    {row.losses}L
                  </span>
                  <span className="text-muted-foreground tabular-nums w-10 text-right">
                    {winPct}%
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function sourceHintFor(
  source: "evaluator" | "anonymous" | "invited" | "solo" | "author",
): string | null {
  switch (source) {
    case "anonymous":
      return "via shareable link";
    case "invited":
      return "via email invite";
    case "solo":
      return "solo eval";
    case "author":
      return "author";
    default:
      return null;
  }
}
