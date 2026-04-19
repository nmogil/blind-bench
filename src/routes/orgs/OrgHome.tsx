import { useQuery } from "convex/react";
import { useNavigate } from "react-router-dom";
import { api } from "../../../convex/_generated/api";
import { useOrg } from "@/contexts/OrgContext";
import { useOrgLayout } from "@/components/layouts/OrgLayout";
import { EmptyState } from "@/components/EmptyState";
import { OnboardingChecklist } from "@/components/OnboardingChecklist";
import { Skeleton } from "@/components/ui/skeleton";
import { FolderOpen, ChevronRight } from "lucide-react";

export function OrgHome() {
  const { org, orgId } = useOrg();
  const { openNewProjectDialog } = useOrgLayout();
  const projects = useQuery(api.projects.list, { orgId });
  const navigate = useNavigate();

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold">{org.name}</h1>
      <p className="mt-1 text-sm text-muted-foreground">Your prompts</p>

      <div className="mt-4">
        <OnboardingChecklist variant="inline" />
      </div>

      <div className="mt-6">
        {projects === undefined ? (
          <div
            className="space-y-2"
            role="status"
            aria-live="polite"
            aria-label="Loading prompts"
          >
            {[1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
            <span className="sr-only">Loading prompts…</span>
          </div>
        ) : projects.length === 0 ? (
          <EmptyState
            icon={FolderOpen}
            heading="No prompts yet"
            description="A prompt holds all its versions, test cases, and run history. Create one to get started."
            action={{
              label: "Create prompt",
              onClick: openNewProjectDialog,
            }}
          />
        ) : (
          <div className="divide-y rounded-lg border">
            {projects.map((project) => (
              <button
                key={project._id}
                onClick={() =>
                  navigate(`/orgs/${org.slug}/projects/${project._id}`)
                }
                className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-accent transition-colors"
              >
                <div className="flex items-center gap-3">
                  <FolderOpen className="h-4 w-4 text-muted-foreground" />
                  <div>
                    <p className="text-sm font-medium">{project.name}</p>
                    {project.description && (
                      <p className="text-xs text-muted-foreground">
                        {project.description}
                      </p>
                    )}
                  </div>
                </div>
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
