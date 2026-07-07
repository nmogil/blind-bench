/**
 * #267 (M31.4): step-level pairwise preference for owners and editors, nested
 * under ProjectLayout. The matchup surface lives in the shared TraceMatchupBody
 * (#271) so blind reviewers reach an identical view via /eval/matchups/:matchupId.
 * This wrapper only supplies the project-scoped back link.
 */
import { useParams } from "react-router-dom";
import type { Id } from "../../../convex/_generated/dataModel";
import { useProject } from "@/contexts/ProjectContext";
import { TraceMatchupBody } from "./TraceMatchupBody";

export function TraceMatchup() {
  const { projectId } = useProject();
  const { orgSlug, matchupId } = useParams<{
    orgSlug: string;
    matchupId: string;
  }>();
  const id = matchupId as Id<"agentTraceMatchups">;

  const projectBase = `/orgs/${orgSlug}/projects/${projectId}`;

  return (
    <TraceMatchupBody
      matchupId={id}
      backTo={`${projectBase}/traces`}
      backLabel="Trajectories"
    />
  );
}
