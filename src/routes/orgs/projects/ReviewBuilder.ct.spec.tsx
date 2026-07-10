import { expect, test } from "@playwright/experimental-ct-react";
import { MemoryRouter } from "react-router-dom";
import type { Id } from "../../../../convex/_generated/dataModel";
import { ProjectProvider } from "@/contexts/ProjectContext";
import { ReviewBuilder } from "./ReviewBuilder";

const projectId = "project-review-builder" as Id<"projects">;

/** Owners can configure either review mode without learning backend concepts. */
test("review builder selects imported runs and previews the blind reviewer view", async ({ mount }) => {
  const component = await mount(
    <MemoryRouter initialEntries={[`/orgs/demo/projects/${projectId}/reviews/new`]}>
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
        <ReviewBuilder />
      </ProjectProvider>
    </MemoryRouter>,
  );

  await expect(component.getByRole("heading", { name: "Create blind review" })).toBeVisible();
  await expect(component).toContainText("Score runs");
  await expect(component).toContainText("Compare attempts");
  await expect(component).toContainText("2 selected");
  await expect(component.getByText("Reviewer view preview", { exact: true })).toBeVisible();
  await expect(component).toContainText("Model, provider, harness, source IDs");
  await expect(component.getByRole("button", { name: "Create review" })).toBeDisabled();

  await component.getByLabel("Review name").fill("Support review");
  await expect(component.getByRole("button", { name: "Create review" })).toBeEnabled();
});
