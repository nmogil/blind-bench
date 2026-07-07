/**
 * #267 (M31.4): step-level review of a single agent trajectory for owners and
 * editors, nested under ProjectLayout. The actual review surface lives in the
 * shared TraceReviewBody (#271) so blind reviewers reach an identical view via
 * /eval/traces/:agentTraceId. This wrapper only supplies the project-scoped
 * back link.
 */
import { useParams } from "react-router-dom";
import type { Id } from "../../../convex/_generated/dataModel";
import { useProject } from "@/contexts/ProjectContext";
import { TraceReviewBody } from "./TraceReviewBody";

export function TraceViewer() {
  const { projectId } = useProject();
  const { orgSlug, agentTraceId } = useParams<{
    orgSlug: string;
    agentTraceId: string;
  }>();
  const traceId = agentTraceId as Id<"agentTraces">;

  const projectBase = `/orgs/${orgSlug}/projects/${projectId}`;

  return (
    <TraceReviewBody
      agentTraceId={traceId}
      backTo={`${projectBase}/traces`}
      backLabel="Trajectories"
    />
  );
}
