import { Navigate, useParams } from "react-router-dom";

import { useProject } from "@/contexts/ProjectContext";

/** Preserve old campaign-creation links while keeping Import as the front door. */
export function ComparisonCampaignNew() {
  const { projectId } = useProject();
  const { orgSlug } = useParams<{ orgSlug: string }>();

  return (
    <Navigate
      to={`/orgs/${orgSlug}/projects/${projectId}/import?source=paired`}
      replace
    />
  );
}
