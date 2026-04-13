import { NavLink, useParams } from "react-router-dom";
import { useProject } from "@/contexts/ProjectContext";
import { cn } from "@/lib/utils";
import { Settings, Users } from "lucide-react";

const links = [
  { label: "General", path: "", icon: Settings, end: true },
  { label: "Collaborators", path: "collaborators", icon: Users, end: false },
];

export function ProjectSettingsNav() {
  const { orgSlug } = useParams<{ orgSlug: string }>();
  const { projectId } = useProject();
  const base = `/orgs/${orgSlug}/projects/${projectId}/settings`;

  return (
    <nav className="w-48 border-r p-3 space-y-1">
      <h3 className="text-xs font-medium uppercase text-muted-foreground mb-2">
        Project Settings
      </h3>
      {links.map((link) => (
        <NavLink
          key={link.path}
          to={link.path ? `${base}/${link.path}` : base}
          end={link.end}
          className={({ isActive }) =>
            cn(
              "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
              isActive
                ? "bg-muted font-medium"
                : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
            )
          }
        >
          <link.icon className="h-4 w-4" />
          {link.label}
        </NavLink>
      ))}
    </nav>
  );
}
