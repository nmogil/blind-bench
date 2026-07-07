/**
 * #271 (M31): blind reviewer's step-level pairwise-preference page. Rendered
 * under EvalLayout at /eval/matchups/:matchupId — no org/project context. The
 * matchup surface is the shared TraceMatchupBody; this wrapper only reads the
 * :matchupId param and sets the blind-eval document title (Rule 3).
 */
import { useEffect } from "react";
import { useQuery } from "convex/react";
import { useParams } from "react-router-dom";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { TraceMatchupBody } from "./TraceMatchupBody";

export function TraceMatchupReview() {
  const { matchupId } = useParams<{ matchupId: string }>();
  const id = matchupId as Id<"agentTraceMatchups">;

  const matchup = useQuery(api.agentTraceReview.getMatchup, { matchupId: id });

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

  return (
    <TraceMatchupBody
      matchupId={id}
      backTo="/eval/traces"
      backLabel="Trajectories to review"
    />
  );
}
