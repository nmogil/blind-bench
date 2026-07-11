import { expect, test } from "@playwright/experimental-ct-react";
import type { HarborReviewerProjection } from "@/lib/evals/harborEvidence";
import { FullSpanReviewEvidence } from "./FullSpanReviewEvidence";

const evidence: HarborReviewerProjection = {
  taskPrompt: "Fix the parser.",
  timing: { startedAt: "2026-07-11T10:00:00Z", completedAt: "2026-07-11T10:00:03Z", durationMs: 3_000 },
  events: [
    { sequence: 0, kind: "user_message", role: "user", content: "Fix it." },
    { sequence: 1, kind: "tool_call", callId: "call-1", toolName: "run_command", arguments: { command: "npm test" } },
    { sequence: 2, kind: "tool_error", callId: "call-1", status: "error", error: "failed once" },
    { sequence: 3, kind: "assistant_message", role: "assistant", content: "I will recover." },
    { sequence: 4, kind: "final_output", content: "Fixed." },
    { sequence: 5, kind: "termination", reason: "agent_finished" },
  ],
  finalOutput: "Fixed.",
  termination: { status: "completed", reason: "agent_finished" },
  outcomes: { process: { status: "completed" }, verifier: { status: "passed" }, infrastructure: { status: "healthy" } },
  runQualification: "quality_eligible",
  evidenceCompleteness: "complete",
  canJudgeTaskSuccess: true,
  changedFiles: [{ path: "src/parser.ts", status: "modified" }],
  patch: "diff --git a/src/parser.ts b/src/parser.ts\n+fixed",
  patchTruncated: false,
  verifierEvidence: { commandSummary: "unit tests", exitCode: 0, timedOut: false, stdout: "1 passed", stdoutTruncated: false, stderrTruncated: false },
  integrity: { status: "verified", checksums: ["sha256:abc"] },
};

test("renders full chronology and expandable reviewer-safe coding evidence", async ({ mount }) => {
  const component = await mount(<FullSpanReviewEvidence evidence={evidence} />);
  await expect(component).toContainText("Chronology");
  await expect(component).toContainText("user message");
  await expect(component).toContainText("tool call");
  await expect(component).toContainText("tool error");
  await expect(component).toContainText("Final output");
  await expect(component).toContainText("src/parser.ts");
  await expect(component).toContainText("unit tests");
  await component.getByText("Show sanitized detail").first().click();
  await expect(component).toContainText("npm test");
  await component.getByText("Show bounded patch").click();
  await expect(component).toContainText("+fixed");
});

test("uses failure verifier presentation for timeout or nonzero evidence", async ({ mount }) => {
  const component = await mount(<FullSpanReviewEvidence evidence={{
    ...evidence,
    runQualification: "insufficient",
    evidenceCompleteness: "insufficient",
    canJudgeTaskSuccess: false,
    evidenceWarning: "Verifier failed.",
    outcomes: { ...evidence.outcomes, verifier: { status: "failed" } },
    verifierEvidence: { ...evidence.verifierEvidence!, exitCode: 1, timedOut: true },
  }} />);
  await expect(component).toContainText("Timed out");
  await expect(component.locator(".text-amber-600")).toHaveCount(2);
});

test("shows the explicit limitation state for insufficient evidence", async ({ mount }) => {
  const component = await mount(<FullSpanReviewEvidence evidence={{
    ...evidence,
    runQualification: "insufficient",
    evidenceCompleteness: "insufficient",
    canJudgeTaskSuccess: false,
    evidenceWarning: "Qualitative feedback is allowed, but this run cannot receive a task-success verdict.",
    patch: undefined,
    verifierEvidence: undefined,
  }} />);
  await expect(component).toContainText("Evidence incomplete");
  await expect(component).toContainText("cannot receive a task-success verdict");
  await expect(component).toContainText("did not include verifier evidence");
});
