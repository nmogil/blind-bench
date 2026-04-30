import { useQuery } from "convex/react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../../../convex/_generated/api";
import { useOrg } from "@/contexts/OrgContext";
import { useOrgLayout } from "@/components/layouts/OrgLayout";
import { EmptyState } from "@/components/EmptyState";
import { Skeleton } from "@/components/ui/skeleton";
import { ClipboardCheck, FolderOpen, ChevronRight, Sparkles } from "lucide-react";

export function OrgHome() {
  const { org, orgId } = useOrg();
  const { openNewProjectDialog } = useOrgLayout();
  const projects = useQuery(api.projects.list, { orgId });
  const inFlight = useQuery(api.reviewSessions.listInFlight);
  const navigate = useNavigate();

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold">{org.name}</h1>
      <p className="mt-1 text-sm text-muted-foreground">Your prompts</p>

      {inFlight && inFlight.length > 0 && (
        <div className="mt-4 space-y-2">
          {inFlight.map((s) => (
            <Link
              key={s.id}
              to={`/review/session/${s.id}`}
              className="flex items-center justify-between rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 hover:bg-primary/10 transition-colors"
            >
              <div className="flex items-center gap-3">
                <ClipboardCheck className="h-4 w-4 text-primary shrink-0" />
                <div>
                  <div className="text-sm font-medium">
                    Resume review
                    {s.projectName ? ` — ${s.projectName}` : ""}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {s.phase === "phase1" ? "Phase 1 · Review" : "Phase 2 · Battle"}
                    {" · "}
                    {s.outputCount} outputs
                  </div>
                </div>
              </div>
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            </Link>
          ))}
        </div>
      )}

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
            {[...projects]
              .sort((a, b) => {
                if (a.isSample && !b.isSample) return -1;
                if (!a.isSample && b.isSample) return 1;
                return 0;
              })
              .map((project) => (
                <button
                  key={project._id}
                  onClick={() =>
                    navigate(`/orgs/${org.slug}/projects/${project._id}`)
                  }
                  className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-accent transition-colors"
                >
                  <div className="flex items-center gap-3">
                    {project.isSample ? (
                      <Sparkles className="h-4 w-4 text-info" aria-hidden />
                    ) : (
                      <FolderOpen className="h-4 w-4 text-muted-foreground" />
                    )}
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium">{project.name}</p>
                        {project.isSample && (
                          <span className="rounded-full border border-info/30 bg-info/5 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-info">
                            Example
                          </span>
                        )}
                      </div>
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
