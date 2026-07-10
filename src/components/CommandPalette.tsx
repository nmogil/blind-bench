import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
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
  BarChart3,
  ClipboardCheck,
  DatabaseZap,
  FileInput,
  FolderOpen,
  Route,
  Settings,
  Wrench,
} from "lucide-react";

/** Keyboard navigation centered on the Runs → Reviews → Results workflow. */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const { orgSlug, projectId } = useParams<{
    orgSlug: string;
    projectId: string;
  }>();
  const { orgId } = useOrg();
  const projects = useQuery(api.projects.list, { orgId });
  const projectInfo = useQuery(
    api.projects.get,
    projectId ? { projectId: projectId as Id<"projects"> } : "skip",
  );
  const canBrowseProject =
    projectInfo?.role === "owner" || projectInfo?.role === "editor";

  useEffect(
    () => onToggleCommandPalette(() => setOpen((current) => !current)),
    [],
  );

  useEffect(() => {
    function handler(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key === "k") {
        event.preventDefault();
        setOpen((current) => !current);
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
  const projectPath = projectId ? `${basePath}/projects/${projectId}` : null;

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Search projects and review actions…" />
      <CommandList>
        <CommandEmpty>
          <div className="py-6 text-center text-sm">
            <p className="text-muted-foreground">No matching project or action.</p>
            <p className="mt-1 text-xs text-muted-foreground/80">
              Try a shorter query, or press <kbd className="rounded border bg-muted px-1 py-0.5 font-mono text-[10px]">Esc</kbd> to close.
            </p>
          </div>
        </CommandEmpty>

        <CommandGroup heading="Review workflow">
          <CommandItem onSelect={() => go(basePath)}>
            <FolderOpen aria-hidden="true" className="mr-2 h-4 w-4" />
            Go to projects
            <CommandShortcut>G P</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={() => go("/eval")}>
            <ClipboardCheck aria-hidden="true" className="mr-2 h-4 w-4" />
            Reviews for me
          </CommandItem>
          {projectPath && canBrowseProject && (
            <>
              <CommandItem onSelect={() => go(`${projectPath}/traces`)}>
                <Route aria-hidden="true" className="mr-2 h-4 w-4" />
                Runs
                <CommandShortcut>G R</CommandShortcut>
              </CommandItem>
              <CommandItem onSelect={() => go(`${projectPath}/import`)}>
                <FileInput aria-hidden="true" className="mr-2 h-4 w-4" />
                Add runs
              </CommandItem>
              <CommandItem onSelect={() => go(`${projectPath}/evaluate`)}>
                <ClipboardCheck aria-hidden="true" className="mr-2 h-4 w-4" />
                Reviews
              </CommandItem>
              <CommandItem onSelect={() => go(`${projectPath}/results`)}>
                <BarChart3 aria-hidden="true" className="mr-2 h-4 w-4" />
                Results
              </CommandItem>
            </>
          )}
        </CommandGroup>

        {projectPath && canBrowseProject && (
          <CommandGroup heading="Tools">
            <CommandItem onSelect={() => go(`${projectPath}/settings/sources`)}>
              <DatabaseZap aria-hidden="true" className="mr-2 h-4 w-4" />
              Data sources
            </CommandItem>
            <CommandItem onSelect={() => go(`${projectPath}/versions`)}>
              <Wrench aria-hidden="true" className="mr-2 h-4 w-4" />
              Prompt playground
            </CommandItem>
          </CommandGroup>
        )}

        <CommandGroup heading="Projects">
          {projects?.map((project) => (
            <CommandItem
              key={project._id}
              onSelect={() => go(`${basePath}/projects/${project._id}`)}
            >
              <FolderOpen aria-hidden="true" className="mr-2 h-4 w-4" />
              {project.name}
            </CommandItem>
          ))}
          <CommandItem onSelect={() => go(`${basePath}/settings`)}>
            <Settings aria-hidden="true" className="mr-2 h-4 w-4" />
            Workspace settings
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
