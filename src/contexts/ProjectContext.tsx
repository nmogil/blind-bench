import { createContext, useContext } from "react";
import { Doc, Id } from "../../convex/_generated/dataModel";

interface ProjectContextValue {
  project: Doc<"projects">;
  projectId: Id<"projects">;
  role: Doc<"projectCollaborators">["role"];
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

export function ProjectProvider({
  children,
  value,
}: {
  children: React.ReactNode;
  value: ProjectContextValue;
}) {
  return (
    <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>
  );
}

export function useProject(): ProjectContextValue {
  const ctx = useContext(ProjectContext);
  if (!ctx) {
    throw new Error("useProject must be used within a ProjectProvider");
  }
  return ctx;
}
