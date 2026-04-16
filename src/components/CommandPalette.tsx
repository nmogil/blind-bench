import { useState, useEffect } from "react";
import { useQuery } from "convex/react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../../convex/_generated/api";
import { useOrg } from "@/contexts/OrgContext";
import { onToggleCommandPalette } from "@/lib/commandPaletteState";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import {
  FolderOpen,
  GitBranch,
  FlaskConical,
  Play,
  Plus,
  Settings,
} from "lucide-react";

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const { orgSlug, projectId } = useParams<{
    orgSlug: string;
    projectId: string;
  }>();
  const { orgId } = useOrg();

  // Always query projects for the current org
  const projects = useQuery(api.projects.list, { orgId });

  // Check project role to avoid querying data the user can't access (e.g. evaluators)
  const projectInfo = useQuery(
    api.projects.get,
    projectId ? { projectId: projectId as any } : "skip",
  );
  const canBrowseProject =
    projectInfo?.role === "owner" || projectInfo?.role === "editor";

  // Only query project-scoped data when inside a project and user has sufficient role
  const versions = useQuery(
    api.versions.list,
    projectId && canBrowseProject ? { projectId: projectId as any } : "skip",
  );
  const testCases = useQuery(
    api.testCases.list,
    projectId && canBrowseProject ? { projectId: projectId as any } : "skip",
  );

  // Subscribe to external toggle events (e.g. TopBar button)
  useEffect(
    () => onToggleCommandPalette(() => setOpen((prev) => !prev)),
    [],
  );

  // Register Cmd+K globally
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  function go(path: string) {
    navigate(path);
    setOpen(false);
  }

  const basePath = `/orgs/${orgSlug}`;
  const projectPath = projectId
    ? `${basePath}/projects/${projectId}`
    : null;

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Search prompts, versions, actions..." />
      <CommandList>
        <CommandEmpty>
          <div className="py-6 text-center text-sm">
            <p className="text-muted-foreground">
              No matches in this {projectPath ? "prompt" : "workspace"}.
            </p>
            <p className="mt-1 text-xs text-muted-foreground/80">
              Try a shorter query, or press{" "}
              <kbd className="rounded border bg-muted px-1 py-0.5 font-mono text-[10px]">
                Esc
              </kbd>{" "}
              to close.
            </p>
          </div>
        </CommandEmpty>

        {/* Actions */}
        <CommandGroup heading="Actions">
          <CommandItem onSelect={() => go(basePath)}>
            <FolderOpen className="mr-2 h-4 w-4" />
            Go to prompts
            <CommandShortcut>G P</CommandShortcut>
          </CommandItem>
          {projectPath && canBrowseProject && (
            <>
              <CommandItem
                onSelect={() => go(`${projectPath}/versions`)}
              >
                <GitBranch className="mr-2 h-4 w-4" />
                Go to versions
                <CommandShortcut>G V</CommandShortcut>
              </CommandItem>
              <CommandItem
                onSelect={() => go(`${projectPath}/test-cases`)}
              >
                <FlaskConical className="mr-2 h-4 w-4" />
                Go to test cases
                <CommandShortcut>G T</CommandShortcut>
              </CommandItem>
              <CommandItem
                onSelect={() => go(`${projectPath}/run`)}
              >
                <Play className="mr-2 h-4 w-4" />
                New run
                <CommandShortcut>G N</CommandShortcut>
              </CommandItem>
              <CommandItem
                onSelect={() => go(`${projectPath}/runs`)}
              >
                <Play className="mr-2 h-4 w-4" />
                Go to runs
                <CommandShortcut>G R</CommandShortcut>
              </CommandItem>
              <CommandItem
                onSelect={() => go(`${projectPath}/variables`)}
              >
                <Plus className="mr-2 h-4 w-4" />
                Variables
              </CommandItem>
            </>
          )}
          <CommandItem
            onSelect={() => go(`${basePath}/settings`)}
          >
            <Settings className="mr-2 h-4 w-4" />
            Org settings
          </CommandItem>
        </CommandGroup>

        {/* Projects */}
        {projects && projects.length > 0 && (
          <CommandGroup heading="Prompts">
            {projects.map((p) => (
              <CommandItem
                key={p._id}
                onSelect={() =>
                  go(`${basePath}/projects/${p._id}`)
                }
              >
                <FolderOpen className="mr-2 h-4 w-4" />
                {p.name}
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {/* Versions (project-scoped) */}
        {versions && versions.length > 0 && projectPath && (
          <CommandGroup heading="Versions">
            {versions.slice(0, 10).map((v) => (
              <CommandItem
                key={v._id}
                onSelect={() =>
                  go(`${projectPath}/versions/${v._id}`)
                }
              >
                <GitBranch className="mr-2 h-4 w-4" />
                v{v.versionNumber}{" "}
                <span className="text-muted-foreground capitalize">
                  {v.status}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {/* Test cases (project-scoped) */}
        {testCases && testCases.length > 0 && projectPath && (
          <CommandGroup heading="Test Cases">
            {testCases.map((tc) => (
              <CommandItem
                key={tc._id}
                onSelect={() =>
                  go(`${projectPath}/test-cases/${tc._id}`)
                }
              >
                <FlaskConical className="mr-2 h-4 w-4" />
                {tc.name}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}
