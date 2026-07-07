/**
 * #271 (M31): shared step-level pairwise-preference body. Extracted from
 * TraceMatchup so both the owner/editor route (under ProjectLayout) and the
 * blind-reviewer route (under EvalLayout) render an identical matchup surface.
 * Reads `getMatchup` by `matchupId` — no org/project context. Two blind-labelled
 * trajectories share the same task up to a divergence point; the reviewer picks
 * whose NEXT move is better. No provenance reaches the DOM.
 */
import { useEffect, useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { Link } from "react-router-dom";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { friendlyError } from "@/lib/errors";
import { StepList, COMMENT_TAGS, type CommentTag } from "./traceSteps";
import { ArrowLeft } from "lucide-react";

const WINNERS = [
  { value: "left", label: "◀ Left better" },
  { value: "right", label: "Right better ▶" },
  { value: "tie", label: "Tie" },
  { value: "skip", label: "Skip" },
] as const;

type Winner = (typeof WINNERS)[number]["value"];

export function TraceMatchupBody({
  matchupId,
  backTo,
  backLabel,
}: {
  matchupId: Id<"agentTraceMatchups">;
  backTo: string;
  backLabel: string;
}) {
  const matchup = useQuery(api.agentTraceReview.getMatchup, { matchupId });
  const decide = useMutation(api.agentTraceReview.decideMatchup);

  const [tags, setTags] = useState<CommentTag[]>([]);
  const [tagsInit, setTagsInit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!tagsInit && matchup) {
      setTags(matchup.reasonTags as CommentTag[]);
      setTagsInit(true);
    }
  }, [matchup, tagsInit]);

  if (matchup === undefined) {
    return (
      <div className="mx-auto max-w-5xl space-y-4 p-6">
        <Skeleton className="h-8 w-64" />
        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-96 w-full" />
          <Skeleton className="h-96 w-full" />
        </div>
      </div>
    );
  }

  if (matchup === null) {
    return (
      <div className="mx-auto max-w-3xl space-y-3 p-6">
        <p className="text-sm">
          This matchup isn’t available. It may have been removed, or you may not
          have access to it.
        </p>
        <Link
          to={backTo}
          className={buttonVariants({ size: "sm", variant: "outline" })}
        >
          <ArrowLeft aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
          Back to {backLabel.toLowerCase()}
        </Link>
      </div>
    );
  }

  const resolved = matchup;

  function toggleTag(tag: CommentTag) {
    setTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag],
    );
  }

  async function submit(winner: Winner) {
    setBusy(true);
    setError("");
    try {
      await decide({ matchupId, winner, reasonTags: tags });
    } catch (err) {
      setError(friendlyError(err, "Couldn’t record your pick. Try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-5xl p-6">
      <Link
        to={backTo}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft aria-hidden="true" className="h-3 w-3" />
        {backLabel}
      </Link>

      <header className="mt-3">
        <h1 className="text-2xl font-bold">Which next move is better?</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Given the same task up to this point, which agent’s next move is
          better?
        </p>
      </header>

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <MatchupColumn
          heading={resolved.leftBlindLabel}
          agentTraceId={resolved.leftTraceId}
          divergenceStepIndex={resolved.divergenceStepIndex}
        />
        <MatchupColumn
          heading={resolved.rightBlindLabel}
          agentTraceId={resolved.rightTraceId}
          divergenceStepIndex={resolved.divergenceStepIndex}
        />
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">Your pick</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {WINNERS.map((w) => {
              const selected = resolved.winner === w.value;
              return (
                <Button
                  key={w.value}
                  type="button"
                  variant={selected ? "default" : "outline"}
                  size="sm"
                  onClick={() => void submit(w.value)}
                  disabled={busy}
                  className={cn(selected && "ring-2 ring-primary/40")}
                >
                  {w.label}
                </Button>
              );
            })}
          </div>

          <div>
            <p className="mb-1.5 text-xs text-muted-foreground">
              Reasons (optional)
            </p>
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
          </div>

          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function MatchupColumn({
  heading,
  agentTraceId,
  divergenceStepIndex,
}: {
  heading: string;
  agentTraceId: Id<"agentTraces">;
  divergenceStepIndex: number;
}) {
  return (
    <div className="min-w-0">
      <h2 className="mb-3 text-sm font-semibold">{heading}</h2>
      <StepList
        agentTraceId={agentTraceId}
        divergenceStepIndex={divergenceStepIndex}
      />
    </div>
  );
}
