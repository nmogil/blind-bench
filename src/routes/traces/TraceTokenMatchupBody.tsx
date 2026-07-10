import { useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Link } from "react-router-dom";
import { api } from "../../../convex/_generated/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { friendlyError } from "@/lib/errors";
import { COMMENT_TAGS, StepList, type CommentTag } from "./traceSteps";
import { ArrowLeft, EyeOff } from "lucide-react";

type Winner = "left" | "right" | "tie" | "skip";

/** Blind matchup body that uses one opaque token for both hidden trajectories. */
export function TraceTokenMatchupBody({ token }: { readonly token: string }) {
  const matchup = useQuery(api.agentTraceReviewSessions.getMatchup, { token });
  const decide = useMutation(api.agentTraceReviewSessions.decideMatchup);
  const [tags, setTags] = useState<CommentTag[]>([]);
  const [tagsInit, setTagsInit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!tagsInit && matchup !== undefined) {
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

  const orderedSides: ReadonlyArray<{ side: "left" | "right"; label: string }> =
    matchup.firstSide === "left"
      ? [{ side: "left", label: matchup.leftBlindLabel }, { side: "right", label: matchup.rightBlindLabel }]
      : [{ side: "right", label: matchup.rightBlindLabel }, { side: "left", label: matchup.leftBlindLabel }];
  const winnerOptions: ReadonlyArray<{ value: Winner; label: string }> = [
    ...orderedSides.map((side) => ({ value: side.side, label: `${side.label} better` })),
    { value: "tie", label: "Tie" },
    { value: "skip", label: "Skip" },
  ];

  async function submit(winner: Winner) {
    setBusy(true);
    setError("");
    try {
      await decide({ token, winner, reasonTags: tags });
    } catch (cause: unknown) {
      setError(friendlyError(cause, "Couldn’t record your pick. Try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-5xl p-6">
      <Link to="/eval/traces" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft aria-hidden="true" className="h-3 w-3" />
        Reviews
      </Link>
      <header className="mt-3">
        <h1 className="text-2xl font-bold">Which next move is better?</h1>
        <p className="mt-1 text-sm text-muted-foreground">Given the same verified prefix, which agent’s next move is better?</p>
      </header>
      <Card className="mt-4 border-primary/30 bg-primary/5">
        <CardContent className="flex items-start gap-2 pt-0 text-sm text-muted-foreground">
          <EyeOff aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <p><span className="font-medium text-foreground">Blind review</span> — model and harness provenance remain hidden until the owner’s reveal.</p>
        </CardContent>
      </Card>

      {!matchup.comparable ? (
        <p className="mt-6 rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          This pair cannot be reviewed because its trajectory prefixes differ.
        </p>
      ) : (
        <>
          <div className="mt-6 grid gap-4 md:grid-cols-2">
            {orderedSides.map((side) => (
              <div className="min-w-0" key={side.side}>
                <h2 className="mb-3 text-sm font-semibold">{side.label}</h2>
                <StepList reviewToken={token} matchupSide={side.side} divergenceStepIndex={matchup.divergenceStepIndex} />
              </div>
            ))}
          </div>

          <Card className="mt-6">
            <CardHeader><CardTitle className="text-base">Your pick</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap gap-2">
                {winnerOptions.map((winner) => {
                  const selected = matchup.winner === winner.value;
                  return (
                    <Button
                      key={winner.value}
                      type="button"
                      variant={selected ? "default" : "outline"}
                      size="sm"
                      onClick={() => void submit(winner.value)}
                      disabled={busy}
                      className={cn(selected && "ring-2 ring-primary/40")}
                    >
                      {winner.label}
                    </Button>
                  );
                })}
              </div>
              <div>
                <p className="mb-1.5 text-xs text-muted-foreground">Reasons (optional)</p>
                <div className="flex flex-wrap gap-1.5">
                  {COMMENT_TAGS.map((tag) => {
                    const selected = tags.includes(tag);
                    return (
                      <button
                        key={tag}
                        type="button"
                        onClick={() => setTags((current) => selected
                          ? current.filter((item) => item !== tag)
                          : [...current, tag])}
                        className={cn(
                          "rounded-full border px-2 py-0.5 text-xs transition-colors",
                          selected
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
              {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
