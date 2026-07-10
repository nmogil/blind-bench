import { NavLink, useLocation, useParams } from "react-router-dom";
import { useProject } from "@/contexts/ProjectContext";
import { cn } from "@/lib/utils";
import {
  Activity,
  DatabaseZap,
  FileInput,
  FlaskConical,
  MoreHorizontal,
  Play,
  Settings,
  Wrench,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const primaryTabs = [
  { label: "Runs", path: "traces" },
  { label: "Reviews", path: "evaluate" },
  { label: "Results", path: "results" },
] as const;

const secondaryItems = [
  { label: "Add runs", path: "import", icon: FileInput },
  { label: "Data sources", path: "settings/sources", icon: DatabaseZap },
  { label: "Prompt playground", path: "versions", icon: Wrench },
  { label: "Generate outputs", path: "run", icon: Play },
  { label: "Playground test cases", path: "test-cases", icon: FlaskConical },
  { label: "Activity", path: "history", icon: Activity },
] as const;

/** Primary project navigation for the ingestion-first Runs → Reviews → Results loop. */
export function ProjectTabs() {
  const { orgSlug } = useParams<{ orgSlug: string }>();
  const { projectId, role } = useProject();
  const location = useLocation();
  const basePath = `/orgs/${orgSlug}/projects/${projectId}`;
  const secondaryActive = secondaryItems.some((item) =>
    location.pathname.startsWith(`${basePath}/${item.path}`),
  );

  return (
    <nav aria-label="Project sections" className="flex items-center border-b px-4">
      <div className="flex flex-1 items-center gap-1 overflow-x-auto">
        {primaryTabs.map((tab) => {
          if (role === "evaluator") return null;
          const to = `${basePath}/${tab.path}`;
          const isActive = location.pathname.startsWith(to);
          return (
            <NavLink
              key={tab.label}
              to={to}
              aria-current={isActive ? "page" : undefined}
              className={() =>
                cn(
                  "inline-flex min-h-11 items-center border-b-2 px-3 py-2.5 text-sm transition-colors sm:min-h-0",
                  isActive
                    ? "border-primary font-medium text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )
              }
            >
              {tab.label}
            </NavLink>
          );
        })}

        {role !== "evaluator" && (
          <DropdownMenu>
            <DropdownMenuTrigger
              className={cn(
                "inline-flex min-h-11 items-center gap-1 border-b-2 px-3 py-2.5 text-sm transition-colors sm:min-h-0",
                secondaryActive
                  ? "border-primary font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              Tools
              <MoreHorizontal aria-hidden="true" className="h-4 w-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              <DropdownMenuLabel>Import and sources</DropdownMenuLabel>
              {secondaryItems.slice(0, 2).map((item) => (
                <DropdownMenuItem key={item.path} render={<NavLink to={`${basePath}/${item.path}`} />}>
                  <item.icon aria-hidden="true" className="mr-2 h-4 w-4" />
                  {item.label}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Prompt playground</DropdownMenuLabel>
              {secondaryItems.slice(2, 5).map((item) => (
                <DropdownMenuItem key={item.path} render={<NavLink to={`${basePath}/${item.path}`} />}>
                  <item.icon aria-hidden="true" className="mr-2 h-4 w-4" />
                  {item.label}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem render={<NavLink to={`${basePath}/${secondaryItems[5].path}`} />}>
                <Activity aria-hidden="true" className="mr-2 h-4 w-4" />
                Activity
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {role === "owner" && (
        <NavLink
          to={`${basePath}/settings`}
          className={({ isActive }) =>
            cn(
              "ml-2 inline-flex h-11 w-11 items-center justify-center rounded-md transition-colors sm:h-auto sm:w-auto sm:p-1.5",
              isActive
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )
          }
          title="Project settings"
          aria-label="Project settings"
        >
          <Settings aria-hidden="true" className="h-5 w-5 sm:h-4 sm:w-4" />
        </NavLink>
      )}
    </nav>
  );
}
