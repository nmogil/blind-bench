import { expect, test } from "@playwright/experimental-ct-react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { WelcomeFirstRun } from "./WelcomeFirstRun";

test("first run leads with import and keeps the playground secondary", async ({ mount }) => {
  const component = await mount(
    <MemoryRouter initialEntries={["/welcome"]}>
      <Routes>
        <Route path="/welcome" element={<WelcomeFirstRun />} />
        <Route path="/orgs/:orgSlug/projects/:projectId/import" element={<p>Import route reached</p>} />
      </Routes>
    </MemoryRouter>,
  );

  await expect(component.getByRole("heading", { name: "Bring in completed AI runs" })).toBeVisible();
  await expect(component).toContainText("CSV");
  await expect(component).toContainText("OpenTelemetry");
  await expect(component).toContainText("Pi");
  await expect(component).toContainText("Claude Code");
  await expect(component.getByRole("tab", { name: "Prompt playground" })).toBeVisible();

  await component.getByRole("button", { name: "Import completed runs" }).click();
  await expect(component).toContainText("Import route reached");
});
