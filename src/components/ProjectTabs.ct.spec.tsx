import { expect, test } from "@playwright/experimental-ct-react";
import { MemoryRouter } from "react-router-dom";
import { ProjectProvider } from "@/contexts/ProjectContext";
import type { Id } from "../../convex/_generated/dataModel";
import { ProjectTabs } from "./ProjectTabs";

const projectId = "project-1" as Id<"projects">;

/** The primary project shell exposes only the ingestion-first workflow. */
test("project navigation leads with Runs, Reviews, and Results", async ({ mount }) => {
  const component = await mount(
    <MemoryRouter initialEntries={[`/orgs/demo/projects/${projectId}/traces`]}>
      <ProjectProvider
        value={{
          project: {
            _id: projectId,
            _creationTime: 1,
            organizationId: "org-1" as Id<"organizations">,
            name: "Agent quality",
            createdById: "user-1" as Id<"users">,
          },
          projectId,
          role: "owner",
          blindMode: undefined,
        }}
      >
        <ProjectTabs />
      </ProjectProvider>
    </MemoryRouter>,
  );

  await expect(component.getByRole("link", { name: "Runs", exact: true })).toBeVisible();
  await expect(component.getByRole("link", { name: "Reviews", exact: true })).toBeVisible();
  await expect(component.getByRole("link", { name: "Results", exact: true })).toBeVisible();
  await expect(component.getByRole("link", { name: "Run prompt", exact: true })).toHaveCount(0);
  await expect(component.getByRole("link", { name: "Export", exact: true })).toHaveCount(0);

  await expect(component.getByRole("button", { name: /tools/i })).toBeVisible();
});
