/**
 * #271 (M31): blind reviewer's single-trajectory review page. Rendered under
 * EvalLayout at /eval/traces/:agentTraceId — no org/project context. The review
 * surface itself is the shared TraceReviewBody; this wrapper only reads the
 * :agentTraceId param and sets the blind-eval document title (Rule 3).
 */
import { useEffect } from "react";
import { useQuery } from "convex/react";
import { useParams } from "react-router-dom";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { TraceReviewBody } from "./TraceReviewBody";

export function TraceReview() {
  const { agentTraceId } = useParams<{ agentTraceId: string }>();
  const traceId = agentTraceId as Id<"agentTraces">;

  const trace = useQuery(api.agentTraces.getTrace, { agentTraceId: traceId });

  // Rule 3: evaluators see "Evaluation — {project name}" and nothing else.
  useEffect(() => {
    if (!trace) return;
    const previous = document.title;
    document.title = trace.projectName
      ? `Evaluation — ${trace.projectName}`
      : "Evaluation";
    return () => {
      document.title = previous;
    };
  }, [trace]);

  return (
    <TraceReviewBody
      agentTraceId={traceId}
      backTo="/eval/traces"
      backLabel="Trajectories to review"
    />
  );
}
