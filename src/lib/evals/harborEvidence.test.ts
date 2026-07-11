import { describe, expect, test } from "vitest";
import fixture from "../../../convex/tests/fixtures/mogil-harbor-evidence-v1.json";
import { parseHarborEvidenceV1 } from "./harborEvidence";

// Static sanitized contract fixture generated through Mogil Bench's authoritative
// HarborEvidence Pydantic model in mogil-bench-trajectory/src/mogil_bench/evidence.py.
const artifact = (): Record<string, unknown> => JSON.parse(JSON.stringify(fixture)) as Record<string, unknown>;
const row = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object expected");
  return value as Record<string, unknown>;
};
const events = (value: Record<string, unknown>): Array<Record<string, unknown>> =>
  row(value.reviewer).events as Array<Record<string, unknown>>;
const evidence = (value: Record<string, unknown>): Record<string, unknown> => row(row(value.reviewer).evidence);
const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(",")}}`;
};
const sha256 = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

describe("authoritative mogil.harbor-evidence v1.0 contract", () => {
  test("parses the Pydantic-generated artifact into ordered blinded review evidence", async () => {
    const parsed = await parseHarborEvidenceV1(artifact());
    expect(parsed.run).toEqual({ stableId: "mogil-producer-fixture-v1", attempt: "attempt-fixture-001", status: "quality_eligible" });
    expect(parsed.projection.events.map((event) => event.sequence)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(parsed.projection.events[parsed.projection.events.length - 1]).toMatchObject({ kind: "termination", reason: "completed" });
    expect(parsed.projection.finalOutput).toBe("Implemented and verified fictional widget arithmetic.");
    expect(parsed.projection.runQualification).toBe("quality_eligible");
    expect(parsed.projection.canJudgeTaskSuccess).toBe(true);
    expect(parsed.projection.changedFiles).toEqual([{ path: "src/widget_math.py", status: "modified" }]);
    expect(parsed.projection.verifierEvidence).toMatchObject({ exitCode: 0, timedOut: false });
    const serialized = JSON.stringify(parsed.projection);
    for (const hidden of ["analysis_metadata", "fictional-provider", "fictional-model", "harbor/pi", "agent/pi.txt", "call-1"]) {
      expect(serialized).not.toContain(hidden);
    }
  });

  test("accepts bounded producer stop reasons only on assistant emissions", async () => {
    const body = artifact();
    events(body)[1]!.stop_reason = "toolUse";
    events(body)[2]!.stop_reason = "toolUse";
    events(body)[5]!.stop_reason = "stop";
    await expect(parseHarborEvidenceV1(body)).resolves.toMatchObject({
      projection: { runQualification: "quality_eligible" },
    });

    const invalid = artifact();
    events(invalid)[0]!.stop_reason = "toolUse";
    await expect(parseHarborEvidenceV1(invalid)).rejects.toThrow(/stop_reason/i);
  });

  test("requires optional event timestamps to be canonical UTC ISO-8601 and chronological", async () => {
    const numeric = artifact();
    events(numeric)[0]!.timestamp = "1";
    await expect(parseHarborEvidenceV1(numeric)).rejects.toThrow(/ISO-8601/i);
    const offset = artifact();
    events(offset)[0]!.timestamp = "2026-07-11T00:00:00Z";
    await expect(parseHarborEvidenceV1(offset)).rejects.toThrow(/canonical UTC/i);
    const reversed = artifact();
    events(reversed)[2]!.timestamp = "2026-07-10T23:59:59+00:00";
    await expect(parseHarborEvidenceV1(reversed)).rejects.toThrow(/chronological/i);
  });

  test.each([
    ["unknown field", (body: Record<string, unknown>) => { body.extra = true; }],
    ["unsupported version", (body: Record<string, unknown>) => { body.version = "2.0"; }],
    ["duplicate event id", (body: Record<string, unknown>) => { events(body)[1]!.id = events(body)[0]!.id; }],
    ["non-contiguous sequence", (body: Record<string, unknown>) => { events(body)[2]!.sequence = 9; }],
    ["missing tool linkage", (body: Record<string, unknown>) => { events(body)[4]!.call_id = "missing"; }],
    ["invalid reference hash", (body: Record<string, unknown>) => { row(evidence(body).patch_reference).sha256 = "bad"; }],
    ["absolute evidence path", (body: Record<string, unknown>) => { row(evidence(body).patch_reference).path = "/tmp/patch.diff"; }],
    ["mismatched patch reviewer hash", (body: Record<string, unknown>) => { evidence(body).patch = "different patch\n"; }],
    ["mismatched changed-files reviewer hash", (body: Record<string, unknown>) => { (evidence(body).changed_files as Array<Record<string, unknown>>)[0]!.status = "deleted"; }],
    ["mismatched stdout reviewer hash", (body: Record<string, unknown>) => { evidence(body).verifier_stdout = "tampered stdout\n"; }],
    ["tampered reviewer_sha256", (body: Record<string, unknown>) => { row(evidence(body).patch_reference).reviewer_sha256 = "0".repeat(64); }],
  ])("rejects %s", async (_name, mutate) => {
    const body = artifact();
    mutate(body);
    await expect(parseHarborEvidenceV1(body)).rejects.toThrow();
  });

  test("keeps fixture_complete inspectable but explicitly fixture-only", async () => {
    const body = artifact();
    row(body.run).status = "fixture_complete";
    const parsed = await parseHarborEvidenceV1(body);
    expect(parsed.projection.evidenceCompleteness).toBe("complete");
    expect(parsed.projection.runQualification).toBe("fixture_only");
    expect(parsed.projection.canJudgeTaskSuccess).toBe(false);
    expect(parsed.projection.evidenceWarning).toMatch(/fixture-only/i);
  });

  test.each([
    ["nonzero verifier", (body: Record<string, unknown>) => { evidence(body).verifier_exit_code = 1; }],
    ["timed-out verifier", (body: Record<string, unknown>) => { evidence(body).verifier_timed_out = true; }],
    ["contradictory reward", (body: Record<string, unknown>) => { row(body.rewards).reward = 0; row(row(body.reviewer).rewards).reward = 0; }],
    ["failed process", (body: Record<string, unknown>) => { row(body.outcomes).process = "failed"; row(row(body.reviewer).outcomes).process = "failed"; }],
    ["failed infrastructure", (body: Record<string, unknown>) => { row(body.outcomes).infrastructure = "failed"; row(row(body.reviewer).outcomes).infrastructure = "failed"; }],
  ])("rejects quality eligibility with %s", async (_name, mutate) => {
    const body = artifact();
    mutate(body);
    await expect(parseHarborEvidenceV1(body)).rejects.toThrow();
  });

  test("enforces serialized projection leakage policy across every reviewer surface", async () => {
    const body = artifact();
    const canary = "HIDDEN_VERIFIER_CANARY_BLOCKING_123";
    const credential = "Authorization: Bearer super-secret-token-value";
    row(row(body.reviewer).task).prompt = `Prompt ${canary} ${credential} /root/private/task`;
    events(body)[0]!.content = `User ${canary} ${credential} /home/user/input`;
    events(body)[1]!.content = `Reasoning fictional-model ${canary} /tmp/reasoning`;
    row(events(body)[3]!.arguments).credential = credential;
    row(events(body)[3]!.arguments).path = "/workspace/private/file";
    events(body)[4]!.kind = "tool_error";
    events(body)[4]!.result = { error: `${canary} fictional-provider /var/log/private` };
    events(body)[5]!.content = `Final fictional-model ${canary} ${credential} /opt/private/output`;
    (evidence(body).changed_files as Array<Record<string, unknown>>)[0]!.path = `src/${canary}.py`;
    evidence(body).patch = `diff --git a/x b/x\n+${canary} ${credential} /srv/private/path\n`;
    evidence(body).patch_truncated = true;
    evidence(body).verifier_command_summary = `Verifier ${canary} fictional-provider /usr/bin/private`;
    evidence(body).verifier_stdout = `${canary} ${credential} /mnt/private/stdout`;
    evidence(body).verifier_stdout_truncated = true;
    evidence(body).verifier_stderr = `${canary} /etc/private/stderr`;
    evidence(body).verifier_stderr_truncated = true;
    row(evidence(body).changed_files_reference).reviewer_sha256 = await sha256(stableStringify(evidence(body).changed_files));
    row(evidence(body).patch_reference).reviewer_sha256 = await sha256(String(evidence(body).patch));
    const references = evidence(body).verifier_references as Array<Record<string, unknown>>;
    row(references.find((item) => item.path === "verifier/stdout.txt")).reviewer_sha256 = await sha256(String(evidence(body).verifier_stdout));
    row(references.find((item) => item.path === "verifier/stderr.txt")).reviewer_sha256 = await sha256(String(evidence(body).verifier_stderr));
    const parsed = await parseHarborEvidenceV1(body);
    const serialized = JSON.stringify(parsed.projection);
    for (const forbidden of [canary, "super-secret-token-value", "fictional-model", "fictional-provider", "/root/", "/home/", "/tmp/", "/workspace/", "/var/", "/opt/", "/srv/", "/usr/", "/mnt/", "/etc/", "call-1"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  test("minimal final output and termination remains insufficient", async () => {
    const body = artifact();
    row(body.run).status = "insufficient";
    row(body.outcomes).evidence_completeness = "incomplete";
    row(body.outcomes).verifier = "not_run";
    row(row(body.reviewer).outcomes).evidence_completeness = "incomplete";
    row(row(body.reviewer).outcomes).verifier = "not_run";
    row(body.rewards).reward = 0;
    row(body.rewards).command_exit = 0;
    row(body.rewards).stdout_assertion = 0;
    row(row(body.reviewer).rewards).reward = 0;
    row(row(body.reviewer).rewards).command_exit = 0;
    row(row(body.reviewer).rewards).stdout_assertion = 0;
    row(body.reviewer).events = events(body).filter((event) => ["final_output", "termination"].includes(String(event.kind))).map((event, sequence) => ({ ...event, sequence }));
    evidence(body).changed_files = [];
    evidence(body).patch = "";
    evidence(body).verifier_exit_code = null;
    evidence(body).verifier_stdout = "";
    row(evidence(body).changed_files_reference).reviewer_sha256 = await sha256(stableStringify(evidence(body).changed_files));
    row(evidence(body).patch_reference).reviewer_sha256 = await sha256("");
    const references = evidence(body).verifier_references as Array<Record<string, unknown>>;
    row(references.find((item) => item.path === "verifier/stdout.txt")).reviewer_sha256 = await sha256("");
    const parsed = await parseHarborEvidenceV1(body);
    expect(parsed.projection.runQualification).toBe("insufficient");
    expect(parsed.projection.canJudgeTaskSuccess).toBe(false);
    expect(parsed.objective.evidence.missing).toContain("meaningful_tool_activity");
  });
});
