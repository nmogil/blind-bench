import { NavLink, useParams } from "react-router-dom";
import { useProject } from "@/contexts/ProjectContext";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const tabs = [
  { label: "Home", path: "", end: true, enabled: true },
  { label: "Editor", path: "editor", enabled: false },
  { label: "Versions", path: "versions", enabled: false },
  { label: "Runs", path: "runs", enabled: false },
  { label: "Test Cases", path: "test-cases", enabled: false },
  { label: "Variables", path: "variables", enabled: false },
  { label: "Meta Context", path: "meta-context", enabled: false },
  { label: "Compare", path: "compare", enabled: false },
  { label: "Settings", path: "settings", end: false, enabled: true },
];

export function ProjectTabs() {
  const { orgSlug } = useParams<{ orgSlug: string }>();
  const { projectId, role } = useProject();
  const basePath = `/orgs/${orgSlug}/projects/${projectId}`;

  return (
    <div className="flex items-center gap-1 border-b px-4 overflow-x-auto">
      {tabs.map((tab) => {
        // Settings only visible to owners
        if (tab.label === "Settings" && role !== "owner") return null;

        if (!tab.enabled) {
          return (
            <Tooltip key={tab.label}>
              <TooltipTrigger className="inline-flex items-center px-3 py-2.5 text-sm text-muted-foreground/50 cursor-not-allowed">
                {tab.label}
              </TooltipTrigger>
              <TooltipContent>Coming soon</TooltipContent>
            </Tooltip>
          );
        }

        return (
          <NavLink
            key={tab.label}
            to={tab.path ? `${basePath}/${tab.path}` : basePath}
            end={tab.end}
            className={({ isActive }) =>
              cn(
                "inline-flex items-center px-3 py-2.5 text-sm transition-colors border-b-2",
                isActive
                  ? "border-primary text-foreground font-medium"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )
            }
          >
            {tab.label}
          </NavLink>
        );
      })}
    </div>
  );
}
