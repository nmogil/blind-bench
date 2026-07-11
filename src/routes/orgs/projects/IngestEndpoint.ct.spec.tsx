import { expect, test } from "@playwright/experimental-ct-react";
import { MemoryRouter } from "react-router-dom";
import type { Id } from "../../../../convex/_generated/dataModel";
import { ProjectProvider } from "@/contexts/ProjectContext";
import { IngestEndpoint } from "./IngestEndpoint";

const projectId = "project-automation-api" as Id<"projects">;

test("data sources exposes least-privilege automation tokens and customer API guidance", async ({ mount }) => {
  const component = await mount(
    <MemoryRouter initialEntries={[`/orgs/example/projects/${projectId}/ingest`]}>
      <ProjectProvider
        value={{
          project: {
            _id: projectId,
            _creationTime: 1,
            organizationId: "org-1" as Id<"organizations">,
            name: "Evaluation workspace",
            createdById: "user-1" as Id<"users">,
          },
          projectId,
          role: "owner",
          blindMode: undefined,
        }}
      >
        <IngestEndpoint />
      </ProjectProvider>
    </MemoryRouter>,
  );

  await expect(component.getByRole("heading", { name: "Continuous ingest" })).toBeVisible();
  await expect(component.getByLabel("Access preset")).toHaveValue("ingest");
  await component.getByLabel("Access preset").selectOption("automation");
  await expect(component).toContainText("Scopes: traces:write, reviews:write, reviews:read.");
  await expect(component.getByText("Automate blind review cycles", { exact: true })).toBeVisible();
  await expect(component).toContainText("POST /api/v1/reviews — create and open");
  await expect(component).toContainText("native-case-123");
});
