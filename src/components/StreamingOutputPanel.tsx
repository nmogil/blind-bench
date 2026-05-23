import { useEffect, useRef } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Doc, Id } from "../../convex/_generated/dataModel";
import { BlindLabelBadge } from "./BlindLabelBadge";
import { RunStatusPill } from "./RunStatusPill";
import { AnnotatedEditor } from "./tiptap/AnnotatedEditor";
import type { EditorFormat } from "./tiptap/PromptEditor";
import { useTypewriter } from "@/hooks/useTypewriter";
import { cn } from "@/lib/utils";

// User must scroll within this many px of the bottom for sticky-follow to engage.
// Generous enough that small layout shifts don't count as "scrolled up".
const STICKY_THRESHOLD_PX = 40;

interface StreamingOutputPanelProps {
  output: Doc<"runOutputs">;
  runStatus: string;
  canAnnotate?: boolean;
  resolvedModel?: string;
  resolvedTemperature?: number;
  /** Rendering format for completed output text. Defaults to plain. */
  outputFormat?: EditorFormat;
}

function formatTokens(n: number | undefined): string {
  if (n === undefined) return "—";
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function formatLatency(ms: number | undefined): string {
  if (ms === undefined) return "—";
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

export function StreamingOutputPanel({
  output,
  runStatus,
  canAnnotate = false,
  resolvedModel,
  resolvedTemperature,
  outputFormat = "plain",
}: StreamingOutputPanelProps) {
  const isStreaming = runStatus === "running";
  const isFailed = runStatus === "failed";
  const isCompleted = runStatus === "completed";

  // Smooth out the backend's 80ms-batched chunks into per-frame character
  // reveal. When the run ends, snap to the full text so the final byte lands
  // immediately (no animation tail blocking annotations).
  const displayed = useTypewriter(output.outputContent ?? "", {
    active: isStreaming,
  });

  // Sticky auto-scroll: follow new text while the user is parked near the
  // bottom; if they scroll up to read earlier text, leave them be until they
  // return to the bottom on their own.
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickyRef = useRef(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      stickyRef.current = distanceFromBottom <= STICKY_THRESHOLD_PX;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!isStreaming) return;
    const el = scrollRef.current;
    if (!el) return;
    if (stickyRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [displayed, isStreaming]);

  // Feedback queries/mutations — only active when completed
  const feedback = useQuery(
    api.feedback.listOutputFeedback,
    isCompleted ? { outputId: output._id } : "skip",
  );
  const addFeedback = useMutation(api.feedback.addOutputFeedback);
  const updateFeedback = useMutation(api.feedback.updateOutputFeedback);
  const deleteFeedback = useMutation(api.feedback.deleteOutputFeedback);

  // Overall notes (targetKind="overall") have empty from/to/highlightedText;
  // feeding them into the tiptap annotation layer would register a zero-width
  // mark and confuse the reader. Filter to inline only.
  const annotations = (feedback ?? [])
    .filter((fb) => fb.targetKind !== "overall")
    .map((fb) => ({
      _id: fb._id as string,
      from: fb.annotationData.from,
      to: fb.annotationData.to,
      highlightedText: fb.annotationData.highlightedText,
      comment: fb.annotationData.comment,
      authorName: fb.authorName ?? undefined,
      isOwn: fb.isOwn,
      label: fb.label,
    }));

  return (
    <div
      className="flex flex-col rounded-lg border bg-card h-full"
      role="status"
      aria-busy={isStreaming}
      aria-label={`Output ${output.blindLabel} — ${runStatus}`}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 border-b h-[var(--panel-header-h)]">
        <div className="flex items-center gap-2">
          <BlindLabelBadge label={output.blindLabel} />
          {resolvedModel && (
            <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <span className="font-mono truncate max-w-[120px]">
                {resolvedModel.split("/").pop()}
              </span>
              {resolvedTemperature !== undefined && (
                <span>T={resolvedTemperature}</span>
              )}
            </div>
          )}
          {isCompleted && feedback && feedback.length > 0 && (
            <span className="text-xs text-muted-foreground">
              {feedback.length} comment{feedback.length !== 1 ? "s" : ""}
            </span>
          )}
        </div>
        <RunStatusPill status={runStatus} />
      </div>

      {/* Output body — annotatable when completed */}
      {isCompleted && output.outputContent ? (
        <div className="flex-1 overflow-y-auto min-h-[200px]">
          <AnnotatedEditor
            content={output.outputContent}
            format={outputFormat}
            annotations={annotations}
            canAnnotate={canAnnotate}
            onCreateAnnotation={(from, to, highlightedText, comment, label) => {
              addFeedback({
                outputId: output._id,
                annotationData: { from, to, highlightedText, comment },
                label,
              });
            }}
            onUpdateAnnotation={(id, comment) => {
              updateFeedback({
                feedbackId: id as Id<"outputFeedback">,
                comment,
              });
            }}
            onDeleteAnnotation={(id) => {
              deleteFeedback({
                feedbackId: id as Id<"outputFeedback">,
              });
            }}
          />
        </div>
      ) : (
        <div
          ref={scrollRef}
          className={cn(
            "flex-1 overflow-y-auto p-3 text-sm whitespace-pre-wrap font-mono leading-relaxed min-h-[200px]",
            !displayed && !isStreaming && "text-muted-foreground italic",
          )}
          aria-live="polite"
          data-ph-mask
        >
          {displayed ||
            (isStreaming
              ? ""
              : isCompleted
                ? "This output failed to generate. The model may have been unavailable or returned an error."
                : "Waiting...")}
          {isStreaming && (
            <span className="inline-block w-[2px] h-[1em] bg-foreground align-text-bottom animate-pulse ml-0.5">
              &#x258b;
            </span>
          )}
        </div>
      )}

      {/* Footer — token counts + latency */}
      {isCompleted && (output.totalTokens !== undefined || output.latencyMs !== undefined) && (
        <div className="flex items-center gap-3 px-3 py-2 border-t text-xs text-muted-foreground">
          {output.promptTokens !== undefined && (
            <span>Prompt: {formatTokens(output.promptTokens)}</span>
          )}
          {output.completionTokens !== undefined && (
            <span>Completion: {formatTokens(output.completionTokens)}</span>
          )}
          {output.latencyMs !== undefined && (
            <span>{formatLatency(output.latencyMs)}</span>
          )}
        </div>
      )}

      {/* Error state */}
      {isFailed && (
        <div className="px-3 py-2 border-t">
          <p className="text-xs text-destructive">
            Output failed. See run details for error.
          </p>
        </div>
      )}
    </div>
  );
}
