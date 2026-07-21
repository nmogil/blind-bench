/**
 * #271 (M31): blind reviewer's step-level pairwise-preference page. Rendered
 * under EvalLayout at /eval/matchups/:handle — no org/project context. #310:
 * the URL carries an opaque review token, resolved server-side to the matchup
 * id; the matchup surface is the shared TraceMatchupBody. This wrapper also
 * sets the blind-eval document title (Rule 3).
 */
import { useEffect } from "react";
import { useQuery } from "convex/react";
import { Link, useParams } from "react-router-dom";
import { api } from "../../../convex/_generated/api";
import { buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft } from "lucide-react";
import { TraceMatchupBody } from "./TraceMatchupBody";

export function TraceMatchupReview() {
  const { handle } = useParams<{ handle: string }>();
  const resolved = useQuery(
    api.agentTraceReview.resolveMatchupHandle,
    handle ? { handle } : "skip",
  );
  const matchupId = resolved?.matchupId;

  const matchup = useQuery(
    api.agentTraceReview.getMatchup,
    matchupId ? { matchupId } : "skip",
  );

  // Rule 3: evaluators see "Evaluation — {project name}" and nothing else.
  useEffect(() => {
    if (!matchup) return;
    const previous = document.title;
    document.title = matchup.projectName
      ? `Evaluation — ${matchup.projectName}`
      : "Evaluation";
    return () => {
      document.title = previous;
    };
  }, [matchup]);

  if (resolved === undefined) {
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

  if (resolved === null || !matchupId) {
    return (
      <div className="mx-auto max-w-3xl space-y-3 p-6">
        <p className="text-sm">
          This matchup isn’t available. It may have been removed, or you may not
          have access to it.
        </p>
        <Link
          to="/eval/traces"
          className={buttonVariants({ size: "sm", variant: "outline" })}
        >
          <ArrowLeft aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
          Back to trajectories to review
        </Link>
      </div>
    );
  }

  return (
    <TraceMatchupBody
      matchupId={matchupId}
      backTo="/eval/traces"
      backLabel="Trajectories to review"
    />
  );
}
