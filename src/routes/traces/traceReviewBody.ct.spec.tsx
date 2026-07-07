import { test, expect } from "@playwright/experimental-ct-react";
import { MemoryRouter } from "react-router-dom";
import type { Id } from "../../../convex/_generated/dataModel";
import { TraceReviewBody } from "./TraceReviewBody";

// #271 render smoke for the BLIND reviewer's review page: the getTrace payload
// has provenance stripped, so the surface must show "Trajectory" (no harness/
// model), the bias-reduction framing, the verdict control, and the steps.
test("blind review page: no provenance, bias framing, verdict, and steps render", async ({
  mount,
}) => {
  const cmp = await mount(
    <MemoryRouter>
      <TraceReviewBody
        agentTraceId={"t" as Id<"agentTraces">}
        backTo="/eval/traces"
        backLabel="Trajectories to review"
      />
    </MemoryRouter>,
  );
  await expect(cmp).toContainText("Trajectory"); // header, no provenance
  await expect(cmp).toContainText("Blinding reduces bias; it is not anonymity");
  await expect(cmp).toContainText("Your verdict");
  await expect(cmp).toContainText("Acceptable");
  await expect(cmp).toContainText("run_command"); // steps render via StepList
});
