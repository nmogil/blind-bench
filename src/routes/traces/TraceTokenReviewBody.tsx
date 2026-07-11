import { useEffect, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { Link } from "react-router-dom";
import { api } from "../../../convex/_generated/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { friendlyError } from "@/lib/errors";
import { StepBody, StepList } from "./traceSteps";
import { FullSpanReviewEvidence } from "./FullSpanReviewEvidence";
import type { HarborReviewerProjection } from "@/lib/evals/harborEvidence";
import { ArrowLeft, EyeOff, Route } from "lucide-react";

const RATINGS = [
  { value: "best", label: "Strong" },
  { value: "acceptable", label: "Acceptable" },
  { value: "weak", label: "Weak" },
] as const;
type Rating = (typeof RATINGS)[number]["value"];

/** Blind run-review body that speaks only in opaque session tokens. */
export function TraceTokenReviewBody({
  token,
  backTo = "/eval/traces",
  backLabel = "Runs to review",
  showBackLink = true,
}: {
  readonly token: string;
  readonly backTo?: string;
  readonly backLabel?: string;
  readonly showBackLink?: boolean;
}) {
  const trace = useQuery(api.agentTraceReviewSessions.getTrace, { token });
  const comments = useQuery(api.agentTraceReviewSessions.listComments, { token });
  const loadFullSpan = useAction(api.agentTraceReviewSessions.getFullSpanEvidence);
  const [fullSpanEvidence, setFullSpanEvidence] = useState<HarborReviewerProjection | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    if (!trace?.fullSpan?.hasProjection) {
      setFullSpanEvidence(null);
      return () => { cancelled = true; };
    }
    void loadFullSpan({ token })
      .then((value) => { if (!cancelled) setFullSpanEvidence(value); })
      .catch(() => { if (!cancelled) setFullSpanEvidence(null); });
    return () => { cancelled = true; };
  }, [loadFullSpan, token, trace?.fullSpan?.hasProjection]);

  if (trace === undefined) {
    return (
      <div className="mx-auto max-w-3xl space-y-4 p-6">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const usageBits: string[] = [];
  if (trace.usage.totalTokens !== undefined) usageBits.push(`${trace.usage.totalTokens.toLocaleString()} tokens`);
  if (trace.usage.costUsd !== undefined) usageBits.push(`$${trace.usage.costUsd.toFixed(4)}`);
  if (trace.usage.durationMs !== undefined) {
    usageBits.push(trace.usage.durationMs >= 1000
      ? `${(trace.usage.durationMs / 1000).toFixed(1)}s`
      : `${trace.usage.durationMs}ms`);
  }

  return (
    <div className="mx-auto max-w-3xl p-6">
      {showBackLink && (
        <Link to={backTo} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft aria-hidden="true" className="h-3 w-3" />
          {backLabel}
        </Link>
      )}
      <header className={showBackLink ? "mt-3" : undefined}>
        <div className="flex items-center gap-2">
          <Route aria-hidden="true" className="h-5 w-5 text-primary" />
          <h1 className="text-2xl font-bold">Run</h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {trace.stepCount} {trace.stepCount === 1 ? "step" : "steps"}
          {usageBits.length > 0 && <> · {usageBits.join(" · ")}</>}
        </p>
      </header>

      <Card className="mt-4 border-primary/30 bg-primary/5">
        <CardContent className="flex items-start gap-2 pt-0 text-sm text-muted-foreground">
          <EyeOff aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <p><span className="font-medium text-foreground">Blind review</span> — provenance hidden. Blinding reduces bias; it is not anonymity.</p>
        </CardContent>
      </Card>

      {trace.fullSpan ? (
        <div className="mt-6">
          {fullSpanEvidence === undefined ? (
            <div className="space-y-3"><Skeleton className="h-24 w-full" /><Skeleton className="h-64 w-full" /></div>
          ) : fullSpanEvidence ? (
            <FullSpanReviewEvidence evidence={fullSpanEvidence} />
          ) : (
            <p className="text-sm text-destructive" role="alert">Couldn’t load this run’s reviewer evidence. Refresh the page to try again.</p>
          )}
        </div>
      ) : (
        <>
          {trace.hasFinalAnswer && (
            <Card className="mt-6">
              <CardHeader><CardTitle className="text-base">Final answer</CardTitle></CardHeader>
              <CardContent><StepBody reviewToken={token} field="text" /></CardContent>
            </Card>
          )}
          <section className="mt-6">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">Steps</h2>
            <StepList reviewToken={token} comments={comments} />
          </section>
        </>
      )}

      <TokenVerdict token={token} canJudgeTaskSuccess={trace.fullSpan?.canJudgeTaskSuccess} />
    </div>
  );
}

function TokenVerdict({
  token,
  canJudgeTaskSuccess,
}: {
  readonly token: string;
  readonly canJudgeTaskSuccess?: boolean;
}) {
  const verdict = useQuery(api.agentTraceReviewSessions.myVerdict, { token });
  const setVerdict = useMutation(api.agentTraceReviewSessions.setVerdict);
  const [note, setNote] = useState("");
  const [noteInit, setNoteInit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!noteInit && verdict !== undefined) {
      setNote(verdict?.note ?? "");
      setNoteInit(true);
    }
  }, [verdict, noteInit]);

  async function submit(rating: Rating | "insufficient_evidence") {
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      await setVerdict({ token, rating, note: note.trim() || undefined });
      setSaved(true);
    } catch (cause: unknown) {
      setError(friendlyError(cause, "Couldn’t save your verdict. Try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mt-4">
      <CardHeader><CardTitle className="text-base">Your verdict</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        {canJudgeTaskSuccess === false ? (
          <>
            <p className="text-sm text-muted-foreground">Task success cannot be judged from this upload. You can still leave qualitative feedback and mark the evidence limitation.</p>
            <Button
              type="button"
              variant={verdict?.rating === "insufficient_evidence" ? "default" : "outline"}
              size="sm"
              onClick={() => void submit("insufficient_evidence")}
              disabled={busy}
              className={cn(verdict?.rating === "insufficient_evidence" && "ring-2 ring-primary/40")}
            >
              Mark insufficient evidence
            </Button>
          </>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">How did this agent handle the task overall?</p>
            <div className="flex flex-wrap gap-2">
              {RATINGS.map((rating) => {
                const selected = verdict?.rating === rating.value;
                return (
                  <Button
                    key={rating.value}
                    type="button"
                    variant={selected ? "default" : "outline"}
                    size="sm"
                    onClick={() => void submit(rating.value)}
                    disabled={busy}
                    className={cn(selected && "ring-2 ring-primary/40")}
                  >
                    {rating.label}
                  </Button>
                );
              })}
            </div>
          </>
        )}
        <Textarea
          value={note}
          onChange={(event) => { setNote(event.target.value); setSaved(false); }}
          placeholder="Optional: why? (saved with your verdict)"
          rows={2}
          className="text-sm"
        />
        {verdict?.rating && (
          <Button type="button" variant="ghost" size="sm" onClick={() => void submit(verdict.rating)} disabled={busy}>
            {busy ? "Saving…" : "Save note"}
          </Button>
        )}
        {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
        {saved && !error && <p className="text-xs text-muted-foreground">Saved.</p>}
      </CardContent>
    </Card>
  );
}
