import { test, expect } from "@playwright/experimental-ct-react";
import { MemoryRouter } from "react-router-dom";
import { TraceTokenMatchupBody } from "./TraceTokenMatchupBody";
import { TraceTokenReviewBody } from "./TraceTokenReviewBody";

// Reviewer smoke uses the opaque-token API surface, not a raw agentTraceId.
test("blind token review: no provenance, bias framing, verdict, and steps render", async ({
  mount,
}) => {
  const component = await mount(
    <MemoryRouter>
      <TraceTokenReviewBody token="opaque-review-token" />
    </MemoryRouter>,
  );
  await expect(component).toContainText("Trajectory");
  await expect(component).toContainText("Blinding reduces bias; it is not anonymity");
  await expect(component).toContainText("Your verdict");
  await expect(component).toContainText("Acceptable");
  await expect(component).toContainText("run_command");
  await expect(component.locator("[data-trace-id], [data-step-id]")).toHaveCount(0);
});

test("blind matchup uses session-scoped A/B order without provenance IDs", async ({ mount }) => {
  const component = await mount(
    <MemoryRouter>
      <TraceTokenMatchupBody token="opaque-matchup-token" />
    </MemoryRouter>,
  );
  await expect(component.getByRole("heading", { name: "Which next move is better?" })).toBeVisible();
  await expect(component.getByRole("heading", { name: "A", exact: true })).toBeVisible();
  await expect(component.getByRole("heading", { name: "B", exact: true })).toBeVisible();
  await expect(component.getByRole("button", { name: "A better" })).toBeVisible();
  await expect(component.getByRole("button", { name: "B better" })).toBeVisible();
  await expect(component.locator("[data-trace-id], [data-step-id], [data-matchup-id]")).toHaveCount(0);
  await expect(component).not.toContainText(/Claude|OpenAI|Pi session/i);
});
