import { expect, test } from "@playwright/experimental-ct-react";
import { MemoryRouter } from "react-router-dom";
import type { Id } from "../../../../convex/_generated/dataModel";
import { ProjectProvider } from "@/contexts/ProjectContext";
import { ReviewResults } from "./ReviewResults";

const projectId = "project-results" as Id<"projects">;

/** Collecting and reusable evidence share one Results model across review modes. */
test("results groups collecting and closed verdict/comparison reviews", async ({ mount }) => {
  const component = await mount(
    <MemoryRouter initialEntries={[`/orgs/demo/projects/${projectId}/results`]}>
      <ProjectProvider
        value={{
          project: {
            _id: projectId,
            _creationTime: 1,
            organizationId: "org-1" as Id<"organizations">,
            name: "Support quality",
            createdById: "user-1" as Id<"users">,
          },
          projectId,
          role: "owner",
          blindMode: undefined,
        }}
      >
        <ReviewResults />
      </ProjectProvider>
    </MemoryRouter>,
  );

  await expect(component.getByRole("heading", { name: "Results" })).toBeVisible();
  await expect(component).toContainText("Collecting");
  await expect(component).toContainText("Closed and reusable");
  await expect(component).toContainText("2/5 runs reviewed");
  await expect(component).toContainText("3/3 runs reviewed");
  await expect(component).toContainText("10 judgments across 5 pairs");
});
