import { useQuery } from "convex/react";
import { NavLink } from "react-router-dom";
import { api } from "../../convex/_generated/api";
import { useOrg } from "@/contexts/OrgContext";
import { cn } from "@/lib/utils";
import { FolderOpen, Key, Settings, Users, Plus } from "lucide-react";

interface SideNavContentProps {
  /** Called when the "+" button is clicked. */
  onNewProject: () => void;
  /** Called after any NavLink is clicked — used by mobile drawer to close itself. */
  onNavigate?: () => void;
}

/**
 * The shared inner body of the side nav — used by both the desktop `SideNav`
 * wrapper and the mobile `MobileNavDrawer`.
 *
 * Renders its own content only; the caller supplies the surrounding container
 * (desktop sidebar frame vs. Sheet popup).
 */
export function SideNavContent({
  onNewProject,
  onNavigate,
}: SideNavContentProps) {
  const { org, orgId, role } = useOrg();
  const projects = useQuery(api.projects.list, { orgId });

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    cn(
      "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
      isActive
        ? "bg-accent text-accent-foreground font-medium"
        : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
    );

  return (
    <>
      <div className="flex items-center justify-between px-2 pb-1">
        <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Prompts
        </span>
        <button
          type="button"
          onClick={() => {
            onNewProject();
            onNavigate?.();
          }}
          aria-label="New prompt"
          className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>

      {projects === undefined ? (
        <div className="space-y-1 px-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-7 animate-pulse rounded bg-muted" />
          ))}
        </div>
      ) : projects.length === 0 ? (
        <p className="px-2 text-xs text-muted-foreground">No prompts yet</p>
      ) : (
        projects.map((p) => (
          <NavLink
            key={p._id}
            to={`/orgs/${org.slug}/projects/${p._id}`}
            className={linkClass}
            onClick={onNavigate}
          >
            <FolderOpen className="h-4 w-4 shrink-0" />
            <span className="truncate">{p.name}</span>
          </NavLink>
        ))
      )}

      {role === "owner" && (
        <>
          <div className="mt-4 px-2 pb-1">
            <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Settings
            </span>
          </div>
          <NavLink
            to={`/orgs/${org.slug}/settings`}
            end
            className={linkClass}
            onClick={onNavigate}
          >
            <Settings className="h-4 w-4 shrink-0" />
            General
          </NavLink>
          <NavLink
            to={`/orgs/${org.slug}/settings/members`}
            className={linkClass}
            onClick={onNavigate}
          >
            <Users className="h-4 w-4 shrink-0" />
            Members
          </NavLink>
          <NavLink
            to={`/orgs/${org.slug}/settings/openrouter-key`}
            className={linkClass}
            onClick={onNavigate}
          >
            <Key className="h-4 w-4 shrink-0" />
            OpenRouter Key
          </NavLink>
        </>
      )}
    </>
  );
}
