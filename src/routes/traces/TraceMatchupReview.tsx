/** Blind matchup route. The URL carries only a stored opaque review token. */
import { useEffect } from "react";
import { useQuery } from "convex/react";
import { useParams } from "react-router-dom";
import { api } from "../../../convex/_generated/api";
import { TraceTokenMatchupBody } from "./TraceTokenMatchupBody";

export function TraceMatchupReview() {
  const { reviewToken = "" } = useParams<{ reviewToken: string }>();
  const matchup = useQuery(
    api.agentTraceReviewSessions.getMatchup,
    reviewToken ? { token: reviewToken } : "skip",
  );

  useEffect(() => {
    document.title = matchup?.projectName
      ? `Evaluation — ${matchup.projectName}`
      : "Evaluation — Blind Bench";
    return () => { document.title = "Blind Bench"; };
  }, [matchup?.projectName]);

  if (!reviewToken) return null;
  return <TraceTokenMatchupBody token={reviewToken} />;
}
