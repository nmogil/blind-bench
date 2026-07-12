import { expect, test } from "@playwright/experimental-ct-react";
import type { Id } from "../../../../convex/_generated/dataModel";
import { ProjectProvider } from "@/contexts/ProjectContext";
import { ExportTraining } from "./ExportTraining";

const projectId = "test-project" as Id<"projects">;
const projectValue = {
  project: { _id: projectId, _creationTime: 1, organizationId: "org-1" as Id<"organizations">, name: "Synthetic", createdById: "owner-1" as Id<"users"> },
  projectId,
  role: "owner" as const,
  blindMode: undefined,
};

test("recent export list marks revoked and legacy-unapproved artifacts unavailable", async ({ mount }) => {
  const component = await mount(<ProjectProvider value={projectValue}><ExportTraining /></ProjectProvider>);
  await expect(component.getByRole("button", { name: "Revoked" })).toBeDisabled();
  await expect(component.getByRole("button", { name: "Unavailable" })).toBeDisabled();
});
