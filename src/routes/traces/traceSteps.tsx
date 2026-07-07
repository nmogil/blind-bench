/**
 * #267 (M31.4): shared trajectory-step rendering for the trace review surface.
 *
 * Used by both TraceViewer (single trajectory, comments enabled) and
 * TraceMatchup (two columns, read-only). Steps page in via the paginated
 * `listSteps` query; each step's heavy body is fetched lazily on first expand
 * (never up front) via the authenticated `getStepBody` action, so a 300+ step
 * trace stays responsive. No real ids or provenance attributes reach the DOM.
 */
import { Fragment, useEffect, useState } from "react";
import { usePaginatedQuery, useMutation, useAction } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { friendlyError } from "@/lib/errors";
import {
  ChevronDown,
  ChevronRight,
  MessageSquare,
  Wrench,
  CornerDownRight,
  Boxes,
  ShieldCheck,
  Trash2,
} from "lucide-react";

type StepsResult = FunctionReturnType<typeof api.agentTraces.listSteps>;
export type TraceStep = StepsResult["page"][number];

type CommentsResult = FunctionReturnType<typeof api.agentTraceReview.listComments>;
export type TraceComment = CommentsResult[number];
export type CommentLabel = TraceComment["label"];
export type CommentTag = TraceComment["tags"][number];

export const COMMENT_LABELS = [
  "suggestion",
  "issue",
  "praise",
  "question",
  "nitpick",
  "thought",
] as const;

export const COMMENT_TAGS = [
  "accuracy",
  "tone",
  "length",
  "relevance",
  "safety",
  "format",
  "clarity",
  "other",
] as const;

// --- body rendering ---------------------------------------------------------

const BODY_FIELD: Partial<Record<TraceStep["kind"], string>> = {
  message: "content",
  tool_call: "args",
  tool_result: "result",
  state: "snapshot",
};

/**
 * Lazy-loads a step body (or, with no stepIndex, the trace's final answer) via
 * the authenticated `getStepBody` action. Mounted only once the user first
 * expands the step, so bodies are never fetched up front. The action returns the
 * blind-selected body server-side — no raw storage URL, no cross-origin fetch.
 */
export function StepBody({
  agentTraceId,
  stepIndex,
  field,
}: {
  agentTraceId: Id<"agentTraces">;
  stepIndex?: number;
  field?: string;
}) {
  const getBody = useAction(api.agentTraces.getStepBody);
  const [state, setState] = useState<{
    status: "loading" | "done" | "error";
    data?: unknown;
  }>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    getBody({ agentTraceId, stepIndex })
      .then((data) => {
        if (!cancelled) setState({ status: "done", data });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [agentTraceId, stepIndex, getBody]);

  if (state.status === "loading") {
    return <Skeleton className="h-16 w-full" />;
  }
  if (state.status === "error") {
    return (
      <p className="text-xs text-destructive" role="alert">
        Couldn’t load this step’s detail. Refresh the page to try again.
      </p>
    );
  }
  if (state.data == null) {
    return (
      <p className="text-xs text-muted-foreground">No detail for this step.</p>
    );
  }

  const picked =
    field && state.data && typeof state.data === "object" && field in (state.data as object)
      ? (state.data as Record<string, unknown>)[field]
      : state.data;

  const text =
    typeof picked === "string" ? picked : JSON.stringify(picked, null, 2);

  return (
    <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-3 font-mono text-xs">
      {text}
    </pre>
  );
}

// --- per-step card ----------------------------------------------------------

const KIND_META: Record<
  TraceStep["kind"],
  { icon: typeof MessageSquare; label: string }
> = {
  message: { icon: MessageSquare, label: "Message" },
  tool_call: { icon: Wrench, label: "Tool call" },
  tool_result: { icon: CornerDownRight, label: "Tool result" },
  state: { icon: Boxes, label: "State" },
  policy_event: { icon: ShieldCheck, label: "Policy" },
};

function roleLabel(role?: string): string {
  if (!role) return "Message";
  if (role === "thinking") return "Reasoning";
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function metaBits(step: TraceStep): string[] {
  const bits: string[] = [];
  const tokens = (step.inputTokens ?? 0) + (step.outputTokens ?? 0);
  if (tokens > 0) bits.push(`${tokens.toLocaleString()} tokens`);
  if (step.durationMs !== undefined) {
    bits.push(
      step.durationMs >= 1000
        ? `${(step.durationMs / 1000).toFixed(1)}s`
        : `${step.durationMs}ms`,
    );
  }
  return bits;
}

function StepCard({
  step,
  agentTraceId,
  comments,
}: {
  step: TraceStep;
  agentTraceId: Id<"agentTraces">;
  /** When provided, comment affordances render. Undefined = read-only. */
  comments?: TraceComment[];
}) {
  const [expanded, setExpanded] = useState(false);
  const [everExpanded, setEverExpanded] = useState(false);

  const { icon: Icon, label: kindLabel } =
    KIND_META[step.kind] ?? { icon: MessageSquare, label: "Step" };
  const bits = metaBits(step);

  // Policy events are a compact, non-expandable one-liner.
  if (step.kind === "policy_event") {
    return (
      <li className="rounded-lg border bg-muted/20 px-3 py-2">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <ShieldCheck aria-hidden="true" className="h-3.5 w-3.5" />
          <span className="font-mono">
            {step.policy ?? "policy"}
            {step.action ? ` · ${step.action}` : ""}
          </span>
          {step.reason && (
            <span className="truncate italic">— {step.reason}</span>
          )}
        </div>
      </li>
    );
  }

  const isThinking = step.kind === "message" && step.role === "thinking";
  const headerLabel =
    step.kind === "message"
      ? roleLabel(step.role)
      : step.kind === "tool_call" || step.kind === "tool_result"
        ? step.toolName ?? kindLabel
        : step.label ?? kindLabel;

  function toggle() {
    setEverExpanded(true);
    setExpanded((e) => !e);
  }

  return (
    <li className="rounded-lg border bg-card">
      <button
        type="button"
        onClick={toggle}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        {expanded ? (
          <ChevronDown aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <Icon aria-hidden="true" className="h-4 w-4 shrink-0 text-primary" />
        <span
          className={cn(
            "text-sm font-medium",
            isThinking && "italic text-muted-foreground",
            (step.kind === "tool_call" || step.kind === "tool_result") &&
              "font-mono text-[0.8rem]",
          )}
        >
          {headerLabel}
        </span>
        {bits.length > 0 && (
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">
            {bits.join(" · ")}
          </span>
        )}
      </button>

      {everExpanded && (
        <div className={cn("px-3 pb-3", !expanded && "hidden")}>
          <StepBody
            agentTraceId={agentTraceId}
            stepIndex={step.stepIndex}
            field={BODY_FIELD[step.kind]}
          />
        </div>
      )}

      {comments !== undefined && (
        <StepComments
          agentTraceId={agentTraceId}
          step={step}
          comments={comments}
        />
      )}
    </li>
  );
}

// --- per-step comments ------------------------------------------------------

const LABEL_TONE: Record<string, string> = {
  issue: "border-primary/40 bg-primary/10 text-primary",
  suggestion: "border-primary/30 bg-primary/5 text-primary",
  praise: "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300",
  question: "border-border bg-muted text-foreground",
  nitpick: "border-border bg-muted text-muted-foreground",
  thought: "border-border bg-muted text-muted-foreground",
};

function StepComments({
  agentTraceId,
  step,
  comments,
}: {
  agentTraceId: Id<"agentTraces">;
  step: TraceStep;
  comments: TraceComment[];
}) {
  const addComment = useMutation(api.agentTraceReview.addComment);
  const deleteComment = useMutation(api.agentTraceReview.deleteComment);

  const [composing, setComposing] = useState(false);
  const [body, setBody] = useState("");
  const [label, setLabel] = useState<CommentLabel>("suggestion");
  const [tags, setTags] = useState<CommentTag[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function toggleTag(tag: CommentTag) {
    setTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag],
    );
  }

  async function save() {
    if (!body.trim()) return;
    setBusy(true);
    setError("");
    try {
      await addComment({
        agentTraceId,
        target:
          step.kind === "tool_call"
            ? { kind: "tool_call", stepIndex: step.stepIndex }
            : { kind: "step", stepIndex: step.stepIndex },
        comment: body,
        label,
        tags: tags.length ? tags : undefined,
      });
      setBody("");
      setTags([]);
      setComposing(false);
    } catch (err) {
      setError(friendlyError(err, "Couldn’t save your comment. Try again."));
    } finally {
      setBusy(false);
    }
  }

  async function remove(commentId: TraceComment["_id"]) {
    try {
      await deleteComment({ commentId });
    } catch {
      // A failed delete is non-blocking; the row simply stays.
    }
  }

  return (
    <div className="border-t px-3 py-2">
      {comments.length > 0 && (
        <ul className="space-y-1.5">
          {comments.map((c) => (
            <li
              key={c._id}
              className="flex items-start gap-2 rounded-md bg-muted/30 px-2.5 py-1.5 text-sm"
            >
              <span
                className={cn(
                  "mt-0.5 shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium",
                  LABEL_TONE[c.label] ?? "border-border bg-muted",
                )}
              >
                {c.label}
              </span>
              <div className="min-w-0 flex-1">
                <p className="break-words">{c.comment}</p>
                {c.tags.length > 0 && (
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {c.tags.join(" · ")}
                  </p>
                )}
              </div>
              {c.mine && (
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  onClick={() => void remove(c._id)}
                  aria-label="Delete your comment"
                >
                  <Trash2 aria-hidden="true" className="h-3 w-3" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {composing ? (
        <div className="mt-2 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Label htmlFor={`label-${step.stepIndex}`} className="text-xs">
              Type
            </Label>
            <select
              id={`label-${step.stepIndex}`}
              value={label}
              onChange={(e) => setLabel(e.target.value as CommentLabel)}
              className="h-7 rounded-md border border-input bg-transparent px-2 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              {COMMENT_LABELS.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {COMMENT_TAGS.map((tag) => {
              const on = tags.includes(tag);
              return (
                <button
                  key={tag}
                  type="button"
                  onClick={() => toggleTag(tag)}
                  className={cn(
                    "rounded-full border px-2 py-0.5 text-xs transition-colors",
                    on
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:text-foreground",
                  )}
                >
                  {tag}
                </button>
              );
            })}
          </div>

          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="What should the agent have done here?"
            rows={3}
            className="text-sm"
          />

          {error && (
            <p className="text-xs text-destructive" role="alert">
              {error}
            </p>
          )}

          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              onClick={() => void save()}
              disabled={busy || !body.trim()}
            >
              {busy ? "Saving…" : "Save comment"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setComposing(false);
                setBody("");
                setError("");
              }}
              disabled={busy}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="mt-1"
          onClick={() => setComposing(true)}
        >
          <MessageSquare aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
          Comment
        </Button>
      )}
    </div>
  );
}

// --- step list (paginated) --------------------------------------------------

export function StepList({
  agentTraceId,
  comments,
  divergenceStepIndex,
}: {
  agentTraceId: Id<"agentTraces">;
  /** When provided, per-step comment affordances render. */
  comments?: TraceComment[];
  /** Draws a "paths diverge here" marker before this step (matchup view). */
  divergenceStepIndex?: number;
}) {
  const { results, status, loadMore } = usePaginatedQuery(
    api.agentTraces.listSteps,
    { agentTraceId },
    { initialNumItems: 50 },
  );

  if (status === "LoadingFirstPage") {
    return (
      <div className="space-y-2">
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-11 w-full" />
        ))}
      </div>
    );
  }

  if (results.length === 0) {
    return (
      <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
        No steps to show yet. If this trajectory was just imported, it may still
        be processing — refresh in a moment.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <ol className="space-y-2">
        {results.map((step) => (
          <Fragment key={step.stepIndex}>
            {divergenceStepIndex === step.stepIndex && <DivergenceMarker />}
            <StepCard
              step={step}
              agentTraceId={agentTraceId}
              comments={
                comments === undefined
                  ? undefined
                  : comments.filter(
                      (c) =>
                        c.target.kind !== "trace" &&
                        c.target.stepIndex === step.stepIndex,
                    )
              }
            />
          </Fragment>
        ))}
      </ol>

      {status === "CanLoadMore" && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => loadMore(50)}
        >
          Load more steps
        </Button>
      )}
      {status === "LoadingMore" && <Skeleton className="h-11 w-full" />}
    </div>
  );
}

function DivergenceMarker() {
  return (
    <li className="flex items-center gap-2 py-1" aria-label="Paths diverge here">
      <span className="h-px flex-1 bg-primary/40" />
      <span className="text-xs font-medium uppercase tracking-wide text-primary">
        Paths diverge here
      </span>
      <span className="h-px flex-1 bg-primary/40" />
    </li>
  );
}
