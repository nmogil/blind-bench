import { expect, test } from "@playwright/experimental-ct-react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { Doc, Id } from "../../../../convex/_generated/dataModel";
import { ProjectProvider } from "@/contexts/ProjectContext";
import { ImportRuns } from "./ImportRuns";

const projectId = "project_import_test" as Id<"projects">;
const project = {
  _id: projectId,
  _creationTime: 1,
  organizationId: "org_import_test",
  name: "Imported runs",
  createdById: "user_import_test",
} as Doc<"projects">;

test("import surface exposes paired comparisons alongside completed-run sources", async ({ mount }) => {
  const component = await mount(
    <MemoryRouter>
      <ProjectProvider value={{ project, projectId, role: "owner" }}>
        <ImportRuns />
      </ProjectProvider>
    </MemoryRouter>,
  );

  await expect(component.getByRole("heading", { name: "Import runs and comparisons" })).toBeVisible();
  for (const source of ["Paired comparison", "CSV", "OpenTelemetry", "Pi session", "Claude Code"]) {
    await expect(component.getByRole("listitem").filter({ hasText: source })).toBeVisible();
  }
  await expect(component).toContainText("does not execute your harness");
});

test("paired comparison source can be opened directly from Review", async ({ mount }) => {
  const component = await mount(
    <MemoryRouter initialEntries={["/orgs/org/projects/project/import?source=paired"]}>
      <ProjectProvider value={{ project, projectId, role: "owner" }}>
        <ImportRuns />
      </ProjectProvider>
    </MemoryRouter>,
  );

  await expect(component.getByRole("listitem").filter({ hasText: "Paired comparison" }))
    .toHaveAttribute("aria-pressed", "true");
  await expect(component.getByLabel("Comparison name")).toBeVisible();
  await expect(component.getByRole("button", { name: "Create comparison" })).toBeDisabled();
});

test("paired CSV upload is auto-detected and opens the new comparison", async ({ mount }) => {
  const component = await mount(
    <MemoryRouter initialEntries={["/orgs/org/projects/project_import_test/import"]}>
      <ProjectProvider value={{ project, projectId, role: "owner" }}>
        <Routes>
          <Route path="/orgs/:orgSlug/projects/:projectId/import" element={<ImportRuns />} />
          <Route
            path="/orgs/:orgSlug/projects/:projectId/comparisons/:campaignId"
            element={<p>Comparison opened</p>}
          />
        </Routes>
      </ProjectProvider>
    </MemoryRouter>,
  );

  await component.locator("#run-import-file").setInputFiles({
    name: "alpha-vs-beta.csv",
    mimeType: "text/csv",
    buffer: Buffer.from([
      "case_id,context,candidate_a,candidate_b,candidate_a_model,candidate_b_model",
      "case-1,shared prompt,first answer,second answer,alpha,beta",
    ].join("\\n")),
  });

  await expect(component.getByRole("listitem").filter({ hasText: "Paired comparison" }))
    .toHaveAttribute("aria-pressed", "true");
  await expect(component.getByLabel("Comparison name")).toHaveValue("alpha-vs-beta");
  await expect(component.getByRole("button", { name: "Create comparison" })).toBeEnabled();
  await expect(component).not.toContainText("Map CSV columns");
  await component.getByRole("button", { name: "Create comparison" }).click();
  await expect(component.getByText("Comparison opened")).toBeVisible();
});

test("flat CSV upload discovers headers and requires input/output mapping", async ({ mount }) => {
  const component = await mount(
    <MemoryRouter>
      <ProjectProvider value={{ project, projectId, role: "owner" }}>
        <ImportRuns />
      </ProjectProvider>
    </MemoryRouter>,
  );

  await component.locator("#run-import-file").setInputFiles({
    name: "runs.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("trace_id,prompt,response,model\nr-1,hello,world,gpt-4.1"),
  });

  await expect(component).toContainText("1 data rows · 4 columns");
  await expect(component.locator("#csv-inputColumn")).toHaveValue("prompt");
  await expect(component.locator("#csv-outputColumn")).toHaveValue("response");
  await expect(component.locator("#csv-idColumn")).toHaveValue("trace_id");
  await expect(component).not.toContainText("hello");
  await expect(component).not.toContainText("world");
});
