import { NavLink, useParams, useLocation } from "react-router-dom";
import { useProject } from "@/contexts/ProjectContext";
import { cn } from "@/lib/utils";
import { Settings } from "lucide-react";

const tabs = [
  { label: "Editor", path: "versions" },
  { label: "Run", path: "run" },
  { label: "Evaluate", path: "evaluate" },
  { label: "History", path: "history" },
];

export function ProjectTabs() {
  const { orgSlug } = useParams<{ orgSlug: string }>();
  const { projectId, role } = useProject();
  const location = useLocation();
  const basePath = `/orgs/${orgSlug}/projects/${projectId}`;

  return (
    <nav
      aria-label="Project sections"
      className="flex items-center border-b px-4"
    >
      <div className="flex items-center gap-1 flex-1 overflow-x-auto">
        {tabs.map((tab) => {
          // Evaluators: hide Run and Editor tabs
          if (role === "evaluator" && (tab.label === "Run" || tab.label === "Editor"))
            return null;
          // Evaluate tab: visible to owner + editor only
          if (tab.label === "Evaluate" && role === "evaluator")
            return null;

          const to = `${basePath}/${tab.path}`;

          // Editor tab: match both /versions and /versions/:versionId
          const isActive =
            tab.path === "versions"
              ? location.pathname.startsWith(`${basePath}/versions`)
              : location.pathname.startsWith(to);

          return (
            <NavLink
              key={tab.label}
              to={to}
              aria-current={isActive ? "page" : undefined}
              className={() =>
                cn(
                  "inline-flex min-h-11 items-center px-3 py-2.5 text-sm transition-colors border-b-2 sm:min-h-0",
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
      {role === "owner" && (
        <NavLink
          to={`${basePath}/settings`}
          className={({ isActive }) =>
            cn(
              "ml-2 inline-flex h-11 w-11 items-center justify-center rounded-md transition-colors sm:h-auto sm:w-auto sm:p-1.5",
              isActive
                ? "text-foreground bg-accent"
                : "text-muted-foreground hover:text-foreground hover:bg-accent",
            )
          }
          title="Settings"
          aria-label="Project settings"
        >
          <Settings className="h-5 w-5 sm:h-4 sm:w-4" />
        </NavLink>
      )}
    </nav>
  );
}
