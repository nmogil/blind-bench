import { NavLink, useParams } from "react-router-dom";
import { useProject } from "@/contexts/ProjectContext";
import { cn } from "@/lib/utils";

const tabs = [
  { label: "Home", path: "", end: true, primary: true },
  { label: "Versions", path: "versions", primary: true },
  { label: "Test Cases", path: "test-cases", primary: true },
  { label: "Variables", path: "variables", primary: true },
  { label: "Runs", path: "runs", primary: false },
  { label: "Compare", path: "compare", primary: false },
  { label: "Meta Context", path: "meta-context", primary: false },
  { label: "Settings", path: "settings", end: false, primary: false },
];

export function ProjectTabs() {
  const { orgSlug } = useParams<{ orgSlug: string }>();
  const { projectId, role } = useProject();
  const basePath = `/orgs/${orgSlug}/projects/${projectId}`;

  return (
    <div className="flex items-center gap-1 border-b px-4 overflow-x-auto">
      {tabs.map((tab) => {
        // Owner-only tabs
        if (
          (tab.label === "Settings" || tab.label === "Meta Context") &&
          role !== "owner"
        )
          return null;

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
                  : tab.primary
                    ? "border-transparent text-muted-foreground hover:text-foreground"
                    : "border-transparent text-muted-foreground/60 hover:text-muted-foreground",
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
