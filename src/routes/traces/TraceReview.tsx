/**
 * #271 (M31): blind reviewer's single-trajectory review page. Rendered under
 * EvalLayout at /eval/traces/:handle — no org/project context. #310: the URL
 * carries an opaque review token, resolved server-side to the trace id; the
 * review surface itself is the shared TraceReviewBody. This wrapper also sets
 * the blind-eval document title (Rule 3).
 */
import { useEffect } from "react";
import { useQuery } from "convex/react";
import { Link, useParams } from "react-router-dom";
import { api } from "../../../convex/_generated/api";
import { buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft } from "lucide-react";
import { TraceReviewBody } from "./TraceReviewBody";

export function TraceReview() {
  const { handle } = useParams<{ handle: string }>();
  const resolved = useQuery(
    api.agentTraces.resolveReviewHandle,
    handle ? { handle } : "skip",
  );
  const traceId = resolved?.agentTraceId;

  const trace = useQuery(
    api.agentTraces.getTrace,
    traceId ? { agentTraceId: traceId } : "skip",
  );

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

  if (resolved === undefined) {
    return (
      <div className="mx-auto max-w-3xl space-y-4 p-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (resolved === null || !traceId) {
    return (
      <div className="mx-auto max-w-3xl space-y-3 p-6">
        <p className="text-sm">
          This trajectory isn’t available. It may have been removed, or you may
          not have access to it.
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
    <TraceReviewBody
      agentTraceId={traceId}
      backTo="/eval/traces"
      backLabel="Trajectories to review"
    />
  );
}
