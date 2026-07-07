import { test, expect } from "@playwright/experimental-ct-react";
import { MemoryRouter } from "react-router-dom";
import { TraceReviewList } from "./TraceReviewList";

// Render smoke for the blind reviewer's discovery list (#271): does
// listReviewableTraces render a row per trajectory with the project name and
// step count? Convex is mocked; useQuery returns FIXTURE_REVIEWABLE.
test("renders reviewable trajectory rows", async ({ mount }) => {
  const cmp = await mount(
    <MemoryRouter>
      <TraceReviewList />
    </MemoryRouter>,
  );
  await expect(cmp).toContainText("Support Router");
  await expect(cmp).toContainText("Refund Agent");
  await expect(cmp).toContainText("12 steps");
  await expect(cmp).toContainText("3 steps");
});
