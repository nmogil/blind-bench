import { test, expect } from "@playwright/experimental-ct-react";
import type { Id } from "../../../convex/_generated/dataModel";
import { StepList } from "./traceSteps";

const traceId = "trace_smoke" as Id<"agentTraces">;

// Render smoke for the trace viewer's core: does the paginated step list render
// heterogeneous steps, and does expanding a step lazy-load its body? Guards the
// #267 render path + the getStepBody-backed StepBody, with Convex mocked.
test("renders heterogeneous steps in order", async ({ mount }) => {
  const cmp = await mount(<StepList agentTraceId={traceId} />);
  await expect(cmp).toContainText("Assistant"); // message step role
  await expect(cmp).toContainText("run_command"); // tool_call + tool_result label
  await expect(cmp).toContainText("system"); // policy_event one-liner
  await expect(cmp).toContainText("local_command");
});

test("expanding a tool call lazy-loads its body", async ({ mount }) => {
  const cmp = await mount(<StepList agentTraceId={traceId} />);
  // Body is not fetched until expand.
  await expect(cmp).not.toContainText("run_the_command");
  await cmp.getByRole("button", { name: /run_command/ }).first().click();
  await expect(cmp).toContainText("run_the_command"); // args.command from the fetched body
});
