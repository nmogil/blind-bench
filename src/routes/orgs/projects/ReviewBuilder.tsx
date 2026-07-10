import { useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { useProject } from "@/contexts/ProjectContext";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { friendlyError } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { ArrowLeft, CheckCircle2, EyeOff, GitCompareArrows, ListChecks } from "lucide-react";

/** One owner-facing setup surface for scoring runs or comparing attempts. */
export function ReviewBuilder() {
  const { projectId } = useProject();
  const { orgSlug } = useParams<{ orgSlug: string }>();
  const navigate = useNavigate();
  const traces = useQuery(api.agentTraces.listTraces, { projectId });
  const createReview = useMutation(api.verdictReviewCampaigns.create);
  const base = `/orgs/${orgSlug}/projects/${projectId}`;
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState(
    "Check whether the run completed the task correctly. Note the step where quality broke down.",
  );
  const [selected, setSelected] = useState<ReadonlySet<Id<"agentTraces">>>(new Set());
  const [initialized, setInitialized] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (initialized || !traces || traces.length === 0) return;
    setSelected(new Set(traces.slice(0, 10).map((trace) => trace._id)));
    setInitialized(true);
  }, [initialized, traces]);

  function toggle(traceId: Id<"agentTraces">) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(traceId)) next.delete(traceId);
      else next.add(traceId);
      return next;
    });
  }

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim() || selected.size === 0 || busy) return;
    setBusy(true);
    setError("");
    try {
      const campaignId = await createReview({
        projectId,
        name: name.trim(),
        instructions: instructions.trim() || undefined,
        traceIds: [...selected],
      });
      navigate(`${base}/reviews/verdict/${campaignId}`);
    } catch (cause: unknown) {
      setError(friendlyError(cause, "Could not create this review."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-5xl p-6">
      <Link to={`${base}/evaluate`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" /> Reviews
      </Link>
      <header className="mt-3">
        <h1 className="text-2xl font-bold">Create blind review</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Select completed runs, set the review question, and preview what reviewers can see.
        </p>
      </header>

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <Card className="border-primary bg-primary/5">
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><ListChecks className="h-4 w-4 text-primary" /> Score runs</CardTitle></CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Review one or more runs independently with an overall verdict and step-level comments.
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><GitCompareArrows className="h-4 w-4" /> Compare attempts</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            <p>Choose between two attempts that share the same task or conversation prefix.</p>
            <Link to={`${base}/import?source=paired`} className={cn(buttonVariants({ size: "sm", variant: "outline" }))}>
              Import paired attempts
            </Link>
          </CardContent>
        </Card>
      </div>

      <form onSubmit={handleCreate} className="mt-6 grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="space-y-5">
          <Card>
            <CardHeader><CardTitle className="text-base">Review details</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="review-name">Review name</Label>
                <Input id="review-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="July support-agent quality check" maxLength={120} autoFocus />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="review-instructions">Question for reviewers</Label>
                <Textarea id="review-instructions" value={instructions} onChange={(event) => setInstructions(event.target.value)} rows={4} maxLength={2_000} />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center justify-between gap-3 text-base">
                <span>Select runs</span>
                <span className="text-xs font-normal text-muted-foreground">{selected.size} selected · 50 maximum</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {traces === undefined ? (
                <div className="space-y-2">{[1, 2, 3].map((key) => <Skeleton key={key} className="h-14 w-full" />)}</div>
              ) : traces.length === 0 ? (
                <div className="space-y-3 text-sm text-muted-foreground">
                  <p>Add completed runs before creating a review.</p>
                  <Link to={`${base}/import`} className={buttonVariants({ size: "sm" })}>Add runs</Link>
                </div>
              ) : (
                <div className="max-h-[440px] divide-y overflow-y-auto rounded-md border">
                  {traces.map((trace) => {
                    const traceId = trace._id;
                    const checked = selected.has(traceId);
                    const source = [trace.product, trace.harnessName, trace.model].filter(Boolean).join(" · ") || "Imported run";
                    return (
                      <label key={trace._id} className="flex cursor-pointer items-start gap-3 px-3 py-3 hover:bg-muted/40">
                        <input type="checkbox" checked={checked} onChange={() => toggle(traceId)} className="mt-0.5 h-4 w-4 accent-primary" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{source}</span>
                          <span className="text-xs text-muted-foreground">{trace.stepCount} {trace.stepCount === 1 ? "step" : "steps"} · {new Date(trace.createdAt).toLocaleString()}</span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
          <Button type="submit" disabled={busy || !name.trim() || selected.size === 0}>
            {busy ? "Creating…" : "Create review"}
          </Button>
        </div>

        <ReviewerPreview instructions={instructions} selectedCount={selected.size} />
      </form>
    </div>
  );
}

function ReviewerPreview({ instructions, selectedCount }: { readonly instructions: string; readonly selectedCount: number }) {
  return (
    <Card className="h-fit lg:sticky lg:top-4">
      <CardHeader><CardTitle className="flex items-center gap-2 text-base"><EyeOff className="h-4 w-4 text-primary" /> Reviewer view preview</CardTitle></CardHeader>
      <CardContent className="space-y-4 text-sm">
        <p className="rounded-md bg-muted/40 p-3 text-muted-foreground">{instructions.trim() || "Your review question appears here."}</p>
        {["Task and context", "Final outcome", "Ordered steps and tool calls", "Verdict and optional note"].map((label) => (
          <div key={label} className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4 text-primary" /><span>{label}</span></div>
        ))}
        <div className="rounded-md border border-primary/30 bg-primary/5 p-3 text-xs text-muted-foreground">
          Model, provider, harness, source IDs, token counts, cost, and timing stay hidden. For multi-step runs, blinding reduces bias but is not anonymity.
        </div>
        <p className="text-xs text-muted-foreground">Reviewers receive {selectedCount || "the selected"} run{selectedCount === 1 ? "" : "s"} in a stable randomized order.</p>
      </CardContent>
    </Card>
  );
}
