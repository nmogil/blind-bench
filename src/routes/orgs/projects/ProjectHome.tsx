import { useQuery } from "convex/react";
import { Link, useParams } from "react-router-dom";
import { api } from "../../../../convex/_generated/api";
import { useProject } from "@/contexts/ProjectContext";
import { EmptyState } from "@/components/EmptyState";
import { RoleBadge } from "@/components/RoleBadge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { FileText } from "lucide-react";

export function ProjectHome() {
  const { orgSlug } = useParams<{ orgSlug: string }>();
  const { project, projectId, role } = useProject();
  const collaborators = useQuery(api.projects.listCollaborators, { projectId });

  return (
    <div className="flex">
      <div className="flex-1 p-6">
        <h1 className="text-2xl font-bold">{project.name}</h1>
        {project.description && (
          <p className="mt-1 text-sm text-muted-foreground">
            {project.description}
          </p>
        )}

        <div className="mt-8">
          <EmptyState
            icon={FileText}
            heading="Get started"
            description="Draft your first prompt to get started."
            action={{
              label: "Open editor",
              onClick: () => {},
              disabled: true,
              disabledReason: "Create a version first on the Versions tab",
            }}
          />
        </div>
      </div>

      <div className="w-64 shrink-0 border-l p-4">
        <h3 className="text-sm font-semibold">Collaborators</h3>
        <Separator className="my-2" />
        {collaborators === undefined ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        ) : (
          <div className="space-y-2">
            {collaborators.map((c) => (
              <div key={c._id} className="flex items-center gap-2">
                <Avatar className="h-6 w-6">
                  <AvatarImage src={c.image ?? undefined} />
                  <AvatarFallback className="text-[10px]">
                    {c.name?.[0]?.toUpperCase() ?? "?"}
                  </AvatarFallback>
                </Avatar>
                <span className="text-sm truncate flex-1">
                  {c.name ?? c.email}
                </span>
                <RoleBadge role={c.role} />
              </div>
            ))}
          </div>
        )}
        {role === "owner" && (
          <Link
            to={`/orgs/${orgSlug}/projects/${projectId}/settings/collaborators`}
            className="mt-3 block text-xs text-primary hover:underline"
          >
            Manage collaborators
          </Link>
        )}
      </div>
    </div>
  );
}
