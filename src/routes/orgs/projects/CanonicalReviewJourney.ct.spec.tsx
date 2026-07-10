import { expect, test } from "@playwright/experimental-ct-react";
import { MemoryRouter } from "react-router-dom";
import type { Id } from "../../../../convex/_generated/dataModel";
import { ProjectProvider } from "@/contexts/ProjectContext";
import { ReviewBuilder } from "./ReviewBuilder";
import { ReviewResults } from "./ReviewResults";
import { VerdictReviewDetail } from "./VerdictReviewDetail";
import { VerdictReview } from "@/routes/review/VerdictReview";

const projectId = "test-project" as Id<"projects">;
const projectValue = {
  project: {
    _id: projectId,
    _creationTime: 1,
    organizationId: "org-1" as Id<"organizations">,
    name: "Synthetic support quality",
    createdById: "owner-1" as Id<"users">,
  },
  projectId,
  role: "owner" as const,
  blindMode: undefined,
};

/** Synthetic browser journey across actual owner and anonymous-review components. */
test("create review, judge blind, inspect result, and reuse evidence", async ({ mount }) => {
  const component = await mount(
    <MemoryRouter initialEntries={[`/orgs/demo/projects/${projectId}/reviews/new`]}>
      <ProjectProvider value={projectValue}><ReviewBuilder /></ProjectProvider>
    </MemoryRouter>,
  );

  await expect(component.getByRole("heading", { name: "Create blind review" })).toBeVisible();
  await expect(component).toContainText("2 selected");
  await component.getByLabel("Review name").fill("Synthetic support review");
  await component.getByRole("button", { name: "Create review" }).click();

  await component.update(
    <MemoryRouter initialEntries={["/review/verdict/opaque-share-token"]}>
      <VerdictReview />
    </MemoryRouter>,
  );
  await component.getByLabel("Your display name").fill("Synthetic reviewer");
  await component.getByRole("button", { name: "Start review" }).click();
  await expect(component.getByRole("heading", { name: "Run", exact: true })).toBeVisible();
  await expect(component).toContainText("Blind review");
  await expect(component).not.toContainText("claude-sonnet");
  await expect(component).not.toContainText("pi ·");
  await component.getByRole("button", { name: "Strong" }).click();
  await expect(component).toContainText("Saved.");

  await component.update(
    <MemoryRouter initialEntries={[`/orgs/demo/projects/${projectId}/reviews/verdict/verdict-review-test`]}>
      <ProjectProvider value={projectValue}><VerdictReviewDetail /></ProjectProvider>
    </MemoryRouter>,
  );
  await expect(component.getByRole("heading", { name: "Synthetic support review" })).toBeVisible();
  await expect(component).toContainText("1 judgments");
  await expect(component).toContainText("support · pi · claude-sonnet");
  await component.getByRole("button", { name: "Add approved runs to regression set" }).click();
  await expect(component).toContainText("1 added to the regression set");

  await component.update(
    <MemoryRouter initialEntries={[`/orgs/demo/projects/${projectId}/results`]}>
      <ProjectProvider value={projectValue}><ReviewResults /></ProjectProvider>
    </MemoryRouter>,
  );
  await expect(component.getByRole("heading", { name: "Results" })).toBeVisible();
  await expect(component).toContainText("Closed and reusable");
  await expect(component).toContainText("3/3 runs reviewed");
});
