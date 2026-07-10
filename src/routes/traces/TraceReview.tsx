/** Blind trajectory review route. The URL carries only a stored opaque token. */
import { useEffect } from "react";
import { useQuery } from "convex/react";
import { useParams } from "react-router-dom";
import { api } from "../../../convex/_generated/api";
import { TraceTokenReviewBody } from "./TraceTokenReviewBody";

export function TraceReview() {
  const { reviewToken = "" } = useParams<{ reviewToken: string }>();
  const trace = useQuery(
    api.agentTraceReviewSessions.getTrace,
    reviewToken ? { token: reviewToken } : "skip",
  );

  useEffect(() => {
    document.title = trace?.projectName
      ? `Evaluation — ${trace.projectName}`
      : "Evaluation — Blind Bench";
    return () => { document.title = "Blind Bench"; };
  }, [trace?.projectName]);

  if (!reviewToken) return null;
  return <TraceTokenReviewBody token={reviewToken} />;
}
