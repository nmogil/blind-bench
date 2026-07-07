/**
 * #267 (M31.4): step-level review of a single agent trajectory. Header metadata
 * + a whole-trajectory verdict + the paginated step list with per-step comments.
 *
 * For blind reviewers the backend strips harness/model/product; when that
 * provenance is absent we show the bias-reduction framing instead. No real ids
 * or provenance attributes are rendered into the DOM.
 */
import { useEffect, useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { Link, useParams } from "react-router-dom";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { useProject } from "@/contexts/ProjectContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { friendlyError } from "@/lib/errors";
import { StepList, StepBody } from "./traceSteps";
import { ArrowLeft, EyeOff, Route } from "lucide-react";

const RATINGS = [
  { value: "best", label: "Best" },
  { value: "acceptable", label: "Acceptable" },
  { value: "weak", label: "Weak" },
] as const;

type Rating = (typeof RATINGS)[number]["value"];

export function TraceViewer() {
  const { projectId } = useProject();
  const { orgSlug, agentTraceId } = useParams<{
    orgSlug: string;
    agentTraceId: string;
  }>();
  const traceId = agentTraceId as Id<"agentTraces">;

  const trace = useQuery(api.agentTraces.getTrace, { agentTraceId: traceId });
  const comments = useQuery(api.agentTraceReview.listComments, {
    agentTraceId: traceId,
  });

  const projectBase = `/orgs/${orgSlug}/projects/${projectId}`;

  if (trace === undefined) {
    return (
      <div className="mx-auto max-w-3xl space-y-4 p-6">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (trace === null) {
    return (
      <div className="mx-auto max-w-3xl space-y-3 p-6">
        <p className="text-sm">
          This trajectory isn’t available. It may have been removed, or you may
          not have access to it.
        </p>
        <Link
          to={`${projectBase}/traces`}
          className={buttonVariants({ size: "sm", variant: "outline" })}
        >
          <ArrowLeft aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
          Back to trajectories
        </Link>
      </div>
    );
  }

  const blind = !trace.harnessName && !trace.product && !trace.model;
  const provenance = [trace.product, trace.harnessName, trace.model].filter(
    Boolean,
  );

  const usageBits: string[] = [];
  if (trace.usage.totalTokens !== undefined) {
    usageBits.push(`${trace.usage.totalTokens.toLocaleString()} tokens`);
  }
  if (trace.usage.costUsd !== undefined) {
    usageBits.push(`$${trace.usage.costUsd.toFixed(4)}`);
  }
  if (trace.usage.durationMs !== undefined) {
    usageBits.push(
      trace.usage.durationMs >= 1000
        ? `${(trace.usage.durationMs / 1000).toFixed(1)}s`
        : `${trace.usage.durationMs}ms`,
    );
  }

  return (
    <div className="mx-auto max-w-3xl p-6">
      <Link
        to={`${projectBase}/traces`}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft aria-hidden="true" className="h-3 w-3" />
        Trajectories
      </Link>

      <header className="mt-3">
        <div className="flex items-center gap-2">
          <Route aria-hidden="true" className="h-5 w-5 text-primary" />
          <h1 className="text-2xl font-bold">
            {provenance.length > 0 ? provenance.join(" · ") : "Trajectory"}
          </h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {trace.stepCount} {trace.stepCount === 1 ? "step" : "steps"}
          {usageBits.length > 0 && <> · {usageBits.join(" · ")}</>}
        </p>
      </header>

      {trace.status === "failed" && (
        <p className="mt-4 text-sm text-destructive" role="alert">
          This import failed while processing. Re-import the session to try
          again.
        </p>
      )}

      {blind && (
        <Card className="mt-4 border-primary/30 bg-primary/5">
          <CardContent className="flex items-start gap-2 pt-0 text-sm text-muted-foreground">
            <EyeOff
              aria-hidden="true"
              className="mt-0.5 h-4 w-4 shrink-0 text-primary"
            />
            <p>
              <span className="font-medium text-foreground">Blind review</span>{" "}
              — provenance hidden. Blinding reduces bias; it is not anonymity.
            </p>
          </CardContent>
        </Card>
      )}

      <VerdictControl agentTraceId={traceId} />

      {trace.hasFinalAnswer && (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="text-base">Final answer</CardTitle>
          </CardHeader>
          <CardContent>
            <StepBody agentTraceId={traceId} field="text" />
          </CardContent>
        </Card>
      )}

      <section className="mt-6">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Steps
        </h2>
        <StepList agentTraceId={traceId} comments={comments} />
      </section>
    </div>
  );
}

function VerdictControl({ agentTraceId }: { agentTraceId: Id<"agentTraces"> }) {
  const verdict = useQuery(api.agentTraceReview.myVerdict, { agentTraceId });
  const setVerdict = useMutation(api.agentTraceReview.setVerdict);

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

  const current = verdict?.rating;

  async function submit(rating: Rating) {
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      await setVerdict({
        agentTraceId,
        rating,
        note: note.trim() ? note.trim() : undefined,
      });
      setSaved(true);
    } catch (err) {
      setError(friendlyError(err, "Couldn’t save your verdict. Try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle className="text-base">Your verdict</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          How did this agent handle the task overall?
        </p>
        <div className="flex flex-wrap gap-2">
          {RATINGS.map((r) => {
            const selected = current === r.value;
            return (
              <Button
                key={r.value}
                type="button"
                variant={selected ? "default" : "outline"}
                size="sm"
                onClick={() => void submit(r.value)}
                disabled={busy}
                className={cn(selected && "ring-2 ring-primary/40")}
              >
                {r.label}
              </Button>
            );
          })}
        </div>

        <Textarea
          value={note}
          onChange={(e) => {
            setNote(e.target.value);
            setSaved(false);
          }}
          placeholder="Optional: why? (saved with your verdict)"
          rows={2}
          className="text-sm"
        />
        {current && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void submit(current)}
            disabled={busy}
          >
            {busy ? "Saving…" : "Save note"}
          </Button>
        )}

        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        {saved && !error && (
          <p className="text-xs text-muted-foreground">Saved.</p>
        )}
      </CardContent>
    </Card>
  );
}
