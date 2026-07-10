import { expect, test } from "@playwright/experimental-ct-react";
import { MemoryRouter } from "react-router-dom";
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

test("ingestion-first surface exposes CSV, OTLP, Pi, and Claude Code", async ({ mount }) => {
  const component = await mount(
    <MemoryRouter>
      <ProjectProvider value={{ project, projectId, role: "owner" }}>
        <ImportRuns />
      </ProjectProvider>
    </MemoryRouter>,
  );

  await expect(component.getByRole("heading", { name: "Import completed runs" })).toBeVisible();
  for (const source of ["CSV", "OpenTelemetry", "Pi session", "Claude Code"]) {
    await expect(component.getByRole("listitem").filter({ hasText: source })).toBeVisible();
  }
  await expect(component).toContainText("does not execute your harness");
});

test("CSV upload discovers headers and requires input/output mapping", async ({ mount }) => {
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
