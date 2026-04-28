import { useQuery } from "convex/react";
import { Navigate, Outlet, useParams } from "react-router-dom";
import { api } from "../../../convex/_generated/api";
import { ProjectProvider } from "@/contexts/ProjectContext";
import { ProjectTabs } from "@/components/ProjectTabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Id } from "../../../convex/_generated/dataModel";
import { useGoToSequence } from "@/hooks/useGoToSequence";

export function ProjectLayout() {
  const { orgSlug, projectId } = useParams<{
    orgSlug: string;
    projectId: string;
  }>();
  useGoToSequence(`/orgs/${orgSlug}/projects/${projectId}`);
  const result = useQuery(
    api.projects.get,
    projectId ? { projectId: projectId as Id<"projects"> } : "skip",
  );

  if (result === undefined) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-px w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (result === null) {
    return <Navigate to={`/orgs/${orgSlug}`} replace />;
  }

  const { project, role, blindMode } = result;

  // M26: blind evaluators must not see any project content. Non-blind
  // reviewers fall through to the standard layout so deep links (run views,
  // version pages) still work — their primary entry point is /review/:projectId.
  if (role === "evaluator" && blindMode !== false) {
    return <Navigate to="/eval" replace />;
  }

  return (
    <ProjectProvider value={{ project, projectId: project._id, role }}>
      <div className="flex flex-col">
        <ProjectTabs />
        <div className="flex-1 overflow-auto">
          <Outlet />
        </div>
      </div>
    </ProjectProvider>
  );
}
