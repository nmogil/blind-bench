import { createContext, useContext, useState } from "react";
import { useQuery } from "convex/react";
import { Navigate, Outlet, useParams } from "react-router-dom";
import { api } from "../../../convex/_generated/api";
import { OrgProvider } from "@/contexts/OrgContext";

interface OrgLayoutContextValue {
  openNewProjectDialog: () => void;
}

const OrgLayoutCtx = createContext<OrgLayoutContextValue>({
  openNewProjectDialog: () => {},
});

export function useOrgLayout() {
  return useContext(OrgLayoutCtx);
}
import { TopBar } from "@/components/TopBar";
import { SideNav } from "@/components/SideNav";
import { NewProjectDialog } from "@/components/NewProjectDialog";
import { CommandPalette } from "@/components/CommandPalette";
import { ShortcutCheatSheet } from "@/components/ShortcutCheatSheet";
import { PostHogOrgGroupBridge } from "@/components/PostHogOrgGroupBridge";
import { CopilotPanel } from "@/components/CopilotPanel";
import { Skeleton } from "@/components/ui/skeleton";

export function OrgLayout() {
  const { orgSlug } = useParams<{ orgSlug: string }>();
  const result = useQuery(
    api.organizations.getOrgBySlug,
    orgSlug ? { slug: orgSlug } : "skip",
  );
  const [showNewProject, setShowNewProject] = useState(false);

  if (result === undefined) {
    return (
      <div
        className="flex min-h-screen flex-col"
        role="status"
        aria-live="polite"
        aria-label="Loading workspace"
      >
        <div className="flex h-14 items-center border-b px-4">
          <Skeleton className="h-5 w-32" />
        </div>
        <div className="flex flex-1">
          <div className="w-56 border-r p-3 space-y-2">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-7 w-full" />
            <Skeleton className="h-7 w-full" />
          </div>
          <div className="flex-1 p-6">
            <Skeleton className="h-8 w-48 mb-4" />
            <Skeleton className="h-32 w-full" />
          </div>
        </div>
        <span className="sr-only">Loading workspace…</span>
      </div>
    );
  }

  if (result === null) {
    return <Navigate to="/denied" replace />;
  }

  const { org, role } = result;

  return (
    <OrgProvider value={{ org, orgId: org._id, role }}>
      <PostHogOrgGroupBridge />
      <OrgLayoutCtx.Provider
        value={{
          openNewProjectDialog: () => setShowNewProject(true),
        }}
      >
        <div className="flex min-h-screen flex-col">
          <TopBar />
          <div className="flex flex-1">
            <SideNav onNewProject={() => setShowNewProject(true)} />
            <main className="flex-1 overflow-auto">
              <Outlet />
            </main>
            <CopilotPanel />
          </div>
        </div>
        <NewProjectDialog
          open={showNewProject}
          onOpenChange={setShowNewProject}
        />
        <CommandPalette />
        <ShortcutCheatSheet />
      </OrgLayoutCtx.Provider>
    </OrgProvider>
  );
}
