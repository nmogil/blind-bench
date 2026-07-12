/// <reference types="vite/client" />
import { readFileSync } from "node:fs";
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import isolatedSandboxFixture from "./fixtures/daytona-reviewer-contract.json";
import { TRAINING_EXPORT_LIMITS, verifyApprovedExportArtifact } from "../lib/trainingExport";
import { deriveTrainingTaskHash } from "../lib/harborEvidence";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/mogil-harbor-evidence-v1.json", import.meta.url), "utf8")) as unknown;
const headers = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

async function setup(artifact: unknown = fixture) {
  const t = convexTest(schema);
  const ids = await t.run(async (ctx) => {
    const ownerId = await ctx.db.insert("users", { name: "Owner", email: "owner@test.invalid" });
    const guestId = await ctx.db.insert("users", { name: "Reviewer", email: "reviewer@test.invalid" });
    const orgId = await ctx.db.insert("organizations", { name: "Synthetic", slug: "synthetic", createdById: ownerId });
    await ctx.db.insert("organizationMembers", { organizationId: orgId, userId: ownerId, role: "owner" });
    const projectId = await ctx.db.insert("projects", { organizationId: orgId, name: "Synthetic", createdById: ownerId });
    await ctx.db.insert("projectCollaborators", { projectId, userId: ownerId, role: "owner", invitedById: ownerId, invitedAt: 1 });
    return { ownerId, guestId, projectId };
  });
  const owner = t.withIdentity({ subject: `${ids.ownerId}|s`, tokenIdentifier: `test|${ids.ownerId}` });
  const guest = t.withIdentity({ subject: `${ids.guestId}|s`, tokenIdentifier: `test|${ids.guestId}` });
  const issued = await owner.mutation(api.ingestTokens.issueIngestToken, {
    projectId: ids.projectId,
    label: "synthetic",
    scopes: ["traces:write"],
  });
  const response = await t.fetch("/ingest/v1/eval-runs", {
    method: "POST",
    headers: headers(issued.token),
    body: JSON.stringify({ runs: [artifact] }),
  });
  expect(response.status).toBe(200);
  const traceId = await t.run(async (ctx) => {
    const row = await ctx.db.query("fullSpanEvalRuns").unique();
    if (!row?.agentTraceId) throw new Error("fixture trace missing");
    return row.agentTraceId;
  });
  const campaignId = await owner.mutation(api.verdictReviewCampaigns.create, {
    projectId: ids.projectId,
    name: "Synthetic full-span review",
    traceIds: [traceId],
  });
  const campaign = await owner.query(api.verdictReviewCampaigns.getOwnerCampaign, { campaignId });
  await owner.mutation(api.verdictReviewCampaigns.openCampaign, { campaignId });
  const joined = await guest.mutation(api.verdictReviewCampaigns.joinCampaign, {
    shareToken: campaign.shareToken,
    displayName: "Synthetic reviewer",
  });
  const runStatus = (artifact as { readonly run?: { readonly status?: unknown } }).run?.status;
  await guest.mutation(api.agentTraceReviewSessions.setVerdict, {
    token: joined.sessionToken,
    rating: runStatus === "quality_eligible" ? "best" : "insufficient_evidence",
  });
  await owner.mutation(api.verdictReviewCampaigns.closeCampaign, { campaignId });
  return { t, ids, owner, guest, campaignId };
}

async function exportText(t: ReturnType<typeof convexTest>, exportId: Id<"trainingExports">) {
  return await t.run(async (ctx) => {
    const row = await ctx.db.get(exportId);
    if (!row) throw new Error("export missing");
    const blob = await ctx.storage.get(row.storageId);
    return blob ? await blob.text() : "";
  });
}

describe("#287 approved full-span training export", () => {
  test("legacy rows without a task hash remain readable but approval fails closed before backfill", async () => {
    const { t, owner, campaignId } = await setup();
    const legacy = await t.run(async (ctx) => {
      const span = await ctx.db.query("fullSpanEvalRuns").unique();
      if (!span) throw new Error("span missing");
      await ctx.db.patch(span._id, { trainingTaskHash: undefined });
      return await ctx.db.get(span._id);
    });
    expect(legacy?.trainingTaskHash).toBeUndefined();
    await expect(owner.action(api.trainingApprovals.approveVerdictCampaign, { campaignId })).rejects.toThrow(/no quality-eligible/i);
  });

  test("owner backfill is dry-runnable, exact, bounded, and idempotent", async () => {
    const { t, owner, guest, ids } = await setup();
    await t.run(async (ctx) => {
      const span = await ctx.db.query("fullSpanEvalRuns").unique();
      if (!span) throw new Error("span missing");
      await ctx.db.patch(span._id, { trainingTaskHash: undefined });
    });
    const dryRun = await owner.action(api.migrations.backfillFullSpanTrainingTaskHash.backfillProjectBatch, {
      projectId: ids.projectId, dryRun: true, batchSize: 1,
    });
    expect(dryRun).toMatchObject({ scanned: 1, patched: 0, wouldPatch: 1, alreadyValid: 0, issues: [], isDone: true, dryRun: true });
    expect((await t.run(async (ctx) => await ctx.db.query("fullSpanEvalRuns").unique()))?.trainingTaskHash).toBeUndefined();

    const applied = await owner.action(api.migrations.backfillFullSpanTrainingTaskHash.backfillProjectBatch, {
      projectId: ids.projectId, dryRun: false, batchSize: 1,
    });
    expect(applied).toMatchObject({ scanned: 1, patched: 1, wouldPatch: 0, alreadyValid: 0, issues: [], isDone: true, dryRun: false });
    const expected = await deriveTrainingTaskHash("Fix fictional widget arithmetic.", "1");
    expect((await t.run(async (ctx) => await ctx.db.query("fullSpanEvalRuns").unique()))?.trainingTaskHash).toBe(expected);

    const replay = await owner.action(api.migrations.backfillFullSpanTrainingTaskHash.backfillProjectBatch, {
      projectId: ids.projectId, dryRun: false, batchSize: 1,
    });
    expect(replay).toMatchObject({ scanned: 1, patched: 0, wouldPatch: 0, alreadyValid: 1, issues: [], isDone: true });
    await expect(t.action(internal.migrations.backfillFullSpanTrainingTaskHash.backfillProjectBatchInternal, {
      projectId: ids.projectId, dryRun: true, batchSize: 1,
    })).resolves.toMatchObject({ scanned: 1, alreadyValid: 1, issues: [], isDone: true });
    await expect(owner.action(api.migrations.backfillFullSpanTrainingTaskHash.backfillProjectBatch, {
      projectId: ids.projectId, dryRun: true, batchSize: 101,
    })).rejects.toThrow(/1 to 100/i);
    await expect(guest.action(api.migrations.backfillFullSpanTrainingTaskHash.backfillProjectBatch, {
      projectId: ids.projectId, dryRun: true, batchSize: 1,
    })).rejects.toThrow(/permission denied/i);
  });

  test.each([
    ["missing projection", "missing_projection"],
    ["missing blob", "projection_unavailable"],
    ["malformed projection", "malformed_projection"],
    ["legacy projection without revision", "missing_task_revision"],
    ["invalid existing hash", "invalid_existing_hash"],
  ] as const)("backfill reports %s without patching", async (scenario, reason) => {
    const { t, owner, ids } = await setup();
    await t.run(async (ctx) => {
      const span = await ctx.db.query("fullSpanEvalRuns").unique();
      if (!span) throw new Error("span missing");
      if (scenario === "missing projection") {
        await ctx.db.patch(span._id, { trainingTaskHash: undefined, reviewerProjectionStorageId: undefined });
        return;
      }
      if (scenario === "missing blob") {
        const storageId = span.reviewerProjectionStorageId;
        if (!storageId) throw new Error("projection missing");
        await ctx.storage.delete(storageId);
        await ctx.db.patch(span._id, { trainingTaskHash: undefined });
        return;
      }
      if (scenario === "malformed projection") {
        const storageId = await ctx.storage.store(new Blob(["not-json"]));
        await ctx.db.patch(span._id, { trainingTaskHash: undefined, reviewerProjectionStorageId: storageId });
        return;
      }
      if (scenario === "invalid existing hash") {
        await ctx.db.patch(span._id, { trainingTaskHash: "0".repeat(64) });
        return;
      }
      const prior = span.reviewerProjectionStorageId ? await ctx.storage.get(span.reviewerProjectionStorageId) : null;
      if (!prior) throw new Error("projection missing");
      const projection = JSON.parse(await prior.text()) as Record<string, unknown>;
      delete projection.taskRevision;
      const storageId = await ctx.storage.store(new Blob([JSON.stringify(projection)]));
      await ctx.db.patch(span._id, { trainingTaskHash: undefined, reviewerProjectionStorageId: storageId });
    });
    const report = await owner.action(api.migrations.backfillFullSpanTrainingTaskHash.backfillProjectBatch, {
      projectId: ids.projectId, dryRun: false, batchSize: 1,
    });
    expect(report).toMatchObject({ scanned: 1, patched: 0, wouldPatch: 0, alreadyValid: 0, issues: [{ reason }] });
  });

  test("quality eligibility and a positive verdict remain denied until owner approval; revocation denies later export", async () => {
    const { owner, guest, ids, campaignId } = await setup();
    await expect(guest.action(api.trainingApprovals.approveVerdictCampaign, { campaignId })).rejects.toThrow(/Permission denied/);
    await expect(owner.action(api.exports.generateExport, {
      projectId: ids.projectId,
      verdictCampaignId: campaignId,
      source: "trajectory",
      format: "sft",
    })).rejects.toThrow(/training approval/i);

    const approval = await owner.action(api.trainingApprovals.approveVerdictCampaign, { campaignId });
    const generated = await owner.action(api.exports.generateExport, {
      projectId: ids.projectId,
      verdictCampaignId: campaignId,
      trainingApprovalId: approval.approvalId,
      source: "trajectory",
      format: "sft",
    });
    expect(generated.rowCount).toBe(1);

    await owner.mutation(api.trainingApprovals.revoke, { approvalId: approval.approvalId });
    await expect(owner.action(api.exports.generateExport, {
      projectId: ids.projectId,
      verdictCampaignId: campaignId,
      trainingApprovalId: approval.approvalId,
      source: "trajectory",
      format: "sft",
    })).rejects.toThrow(/revoked|active/i);
  });

  test("fixture-only full-span evidence cannot receive training approval", async () => {
    const artifact = JSON.parse(JSON.stringify(fixture)) as { run: { status: string } };
    artifact.run.status = "fixture_complete";
    const { owner, campaignId } = await setup(artifact);
    await expect(owner.action(api.trainingApprovals.approveVerdictCampaign, { campaignId })).rejects.toThrow(/no quality-eligible/i);
  });

  test("private full-span evidence remains ineligible even after a positive verdict", async () => {
    const artifact = JSON.parse(JSON.stringify(fixture)) as { reviewer: { task: { privacy_class: string } } };
    artifact.reviewer.task.privacy_class = "confidential";
    const { owner, campaignId } = await setup(artifact);
    await expect(owner.action(api.trainingApprovals.approveVerdictCampaign, { campaignId })).rejects.toThrow(/no quality-eligible/i);
  });

  test("approved same-task shared-prefix full spans produce a reviewer-safe DPO pair", async () => {
    const { t, owner, ids } = await setup();
    const second = JSON.parse(JSON.stringify(fixture)) as { run: { id: string; attempt: string }; reviewer: { events: Array<{ kind: string; tool_name?: string }> } };
    second.run.id = "mogil-producer-fixture-v1-alternative";
    second.run.attempt = "attempt-fixture-alternative";
    for (const event of second.reviewer.events) {
      if (event.kind === "tool_call" || event.kind === "tool_result") event.tool_name = "bash";
    }
    const issued = await owner.mutation(api.ingestTokens.issueIngestToken, { projectId: ids.projectId, label: "alternative", scopes: ["traces:write"] });
    const response = await t.fetch("/ingest/v1/eval-runs", { method: "POST", headers: headers(issued.token), body: JSON.stringify({ runs: [second] }) });
    expect(response.status).toBe(200);
    const traces = await t.run(async (ctx) => (await ctx.db.query("fullSpanEvalRuns").collect()).map((row) => row.agentTraceId).filter((id): id is Id<"agentTraces"> => id !== undefined));
    const leftTraceId = traces[0];
    const rightTraceId = traces[1];
    if (!leftTraceId || !rightTraceId) throw new Error("two traces required");
    const campaignId = await t.run(async (ctx) => await ctx.db.insert("comparisonCampaigns", { projectId: ids.projectId, name: "Synthetic pair", status: "closed", shareToken: "opaque-pair", importKey: "safe-pair", caseCount: 1, judgmentCount: 1, createdById: ids.ownerId, createdAt: 1, closedAt: 2 }));
    const matchupId = await owner.mutation(api.agentTraceReview.createMatchup, { leftTraceId, rightTraceId, divergenceStepIndex: 3, leftBlindLabel: "A", rightBlindLabel: "B", campaignId, caseKey: "same-task" });
    await owner.mutation(api.agentTraceReview.decideMatchup, { matchupId, winner: "left", reasonTags: ["accuracy"] });
    const approval = await owner.action(api.trainingApprovals.approveComparisonCampaign, { campaignId });
    await t.run(async (ctx) => { await ctx.db.patch(matchupId, { divergenceStepIndex: 0, prefixHash: "mutated-after-approval" }); });
    const generated = await owner.action(api.exports.generateExport, { projectId: ids.projectId, campaignId, trainingApprovalId: approval.approvalId, source: "trajectory", format: "dpo" });
    const jsonl = await exportText(t, generated.exportId);
    const row = JSON.parse(jsonl) as { prompt: string; chosen: string; rejected: string };
    expect(row.chosen).not.toBe(row.rejected);
    expect(row.prompt).toContain("Fix fictional widget arithmetic.");
    expect(row.prompt).toContain("I will edit.");
    expect(`${row.chosen}\n${row.rejected}`).toMatch(/change_file|run_command/);
    expect(JSON.stringify(row)).not.toMatch(/assistant_reasoning|objective_outcomes|verifier|infrastructure|reward|workspace_change|policy_event|termination|fictional-provider|fictional-model|harbor\/pi|call-1/);
    await expect(verifyApprovedExportArtifact(jsonl, generated.manifest)).resolves.toEqual({ ready: true, reasons: [] });
  });

  test("approved comparable but degenerate DPO produces an explicit verified zero-row artifact", async () => {
    const { t, owner, ids } = await setup();
    const second = JSON.parse(JSON.stringify(fixture)) as { run: { id: string; attempt: string } };
    second.run.id = "mogil-producer-fixture-v1-second";
    second.run.attempt = "attempt-fixture-002";
    const issued = await owner.mutation(api.ingestTokens.issueIngestToken, { projectId: ids.projectId, label: "second", scopes: ["traces:write"] });
    const response = await t.fetch("/ingest/v1/eval-runs", { method: "POST", headers: headers(issued.token), body: JSON.stringify({ runs: [second] }) });
    expect(response.status).toBe(200);
    const traces = await t.run(async (ctx) => (await ctx.db.query("fullSpanEvalRuns").collect()).map((row) => row.agentTraceId).filter((id): id is Id<"agentTraces"> => id !== undefined));
    expect(traces).toHaveLength(2);
    const campaignId = await t.run(async (ctx) => await ctx.db.insert("comparisonCampaigns", {
      projectId: ids.projectId, name: "Degenerate synthetic pair", status: "closed", shareToken: "opaque-comparison", importKey: "degenerate-pair", caseCount: 1, judgmentCount: 1, createdById: ids.ownerId, createdAt: 1, closedAt: 2,
    }));
    const leftTraceId = traces[0];
    const rightTraceId = traces[1];
    if (!leftTraceId || !rightTraceId) throw new Error("two traces required");
    const matchupId = await owner.mutation(api.agentTraceReview.createMatchup, {
      leftTraceId, rightTraceId, divergenceStepIndex: 3, leftBlindLabel: "A", rightBlindLabel: "B", campaignId, caseKey: "synthetic-case",
    });
    await owner.mutation(api.agentTraceReview.decideMatchup, { matchupId, winner: "left", reasonTags: ["accuracy"] });
    const approval = await owner.action(api.trainingApprovals.approveComparisonCampaign, { campaignId });
    const generated = await owner.action(api.exports.generateExport, {
      projectId: ids.projectId, campaignId, trainingApprovalId: approval.approvalId, source: "trajectory", format: "dpo",
    });
    const jsonl = await exportText(t, generated.exportId);
    expect(jsonl).toBe("");
    expect(generated.manifest.excluded_by_reason.degenerate).toBe(1);
    expect(generated.manifest.notes.some((note) => note.includes("No comparable preference pairs"))).toBe(true);
    await expect(verifyApprovedExportArtifact(jsonl, generated.manifest)).resolves.toEqual({ ready: true, reasons: [] });
  });

  test.each([0, 3])("rejects different reviewer-safe tasks independently of prefix at divergence %i", async (divergenceStepIndex) => {
    const { t, owner, ids } = await setup();
    const second = JSON.parse(JSON.stringify(fixture)) as { run: { id: string; attempt: string }; reviewer: { task: { prompt: string } } };
    second.run.id = `different-task-${divergenceStepIndex}`;
    second.run.attempt = `different-task-attempt-${divergenceStepIndex}`;
    second.reviewer.task.prompt = "A different reviewer-safe task.";
    const issued = await owner.mutation(api.ingestTokens.issueIngestToken, { projectId: ids.projectId, label: `different-${divergenceStepIndex}`, scopes: ["traces:write"] });
    expect((await t.fetch("/ingest/v1/eval-runs", { method: "POST", headers: headers(issued.token), body: JSON.stringify({ runs: [second] }) })).status).toBe(200);
    const traces = await t.run(async (ctx) => (await ctx.db.query("fullSpanEvalRuns").collect()).flatMap((row) => row.agentTraceId ? [row.agentTraceId] : []));
    const leftTraceId = traces[0], rightTraceId = traces[1];
    if (!leftTraceId || !rightTraceId) throw new Error("two traces required");
    const campaignId = await t.run(async (ctx) => await ctx.db.insert("comparisonCampaigns", { projectId: ids.projectId, name: "Different tasks", status: "closed", shareToken: `different-${divergenceStepIndex}`, importKey: `different-${divergenceStepIndex}`, caseCount: 1, judgmentCount: 1, createdById: ids.ownerId, createdAt: 1, closedAt: 2 }));
    const matchupId = await owner.mutation(api.agentTraceReview.createMatchup, { leftTraceId, rightTraceId, divergenceStepIndex, leftBlindLabel: "A", rightBlindLabel: "B", campaignId, caseKey: "different-task" });
    expect((await t.run(async (ctx) => ctx.db.get(matchupId)))?.comparabilityStatus).toBe("valid");
    await owner.mutation(api.agentTraceReview.decideMatchup, { matchupId, winner: "left", reasonTags: [] });
    const prepared = await owner.query(internal.trainingApprovals.prepareComparisonApproval, { campaignId });
    expect(prepared.candidates[0]?.exclusionReason).toBe("task_mismatch");
    await expect(owner.action(api.trainingApprovals.approveComparisonCampaign, { campaignId })).rejects.toThrow(/no quality-eligible/i);
  });

  test("approval snapshots exact projection bytes and ignores later mutable span pointers", async () => {
    const { t, owner, ids, campaignId } = await setup();
    const approval = await owner.action(api.trainingApprovals.approveVerdictCampaign, { campaignId });
    await t.run(async (ctx) => {
      const span = await ctx.db.query("fullSpanEvalRuns").unique();
      if (!span) throw new Error("span missing");
      const replacement = await ctx.storage.store(new Blob([JSON.stringify({ poisoned: true })]));
      await ctx.db.patch(span._id, { reviewerProjectionStorageId: replacement, trainingTaskHash: "mutated-task" });
    });
    const generated = await owner.action(api.exports.generateExport, { projectId: ids.projectId, verdictCampaignId: campaignId, trainingApprovalId: approval.approvalId, source: "trajectory", format: "sft" });
    expect(await exportText(t, generated.exportId)).toContain("Fix fictional widget arithmetic.");
  });

  test("generation fails closed when immutable projection bytes do not match the approval hash", async () => {
    const { t, owner, ids, campaignId } = await setup();
    const approval = await owner.action(api.trainingApprovals.approveVerdictCampaign, { campaignId });
    await t.run(async (ctx) => {
      const item = await ctx.db.query("trainingApprovalItems").withIndex("by_approval_and_order", (q) => q.eq("approvalId", approval.approvalId)).unique();
      if (!item) throw new Error("approval item missing");
      await ctx.db.patch(item._id, { projectionSha256: "0".repeat(64) });
    });
    await expect(owner.action(api.exports.generateExport, { projectId: ids.projectId, verdictCampaignId: campaignId, trainingApprovalId: approval.approvalId, source: "trajectory", format: "sft" })).rejects.toThrow(/hash mismatch/i);
  });

  test.each([undefined, "0".repeat(64)])("generation rejects approval snapshots with a missing or unvalidated task hash", async (taskHash) => {
    const { t, owner, ids, campaignId } = await setup();
    const approval = await owner.action(api.trainingApprovals.approveVerdictCampaign, { campaignId });
    await t.run(async (ctx) => {
      const item = await ctx.db.query("trainingApprovalItems").withIndex("by_approval_and_order", (q) => q.eq("approvalId", approval.approvalId)).unique();
      if (!item) throw new Error("approval item missing");
      await ctx.db.patch(item._id, { taskHash });
    });
    await expect(owner.action(api.exports.generateExport, {
      projectId: ids.projectId, verdictCampaignId: campaignId, trainingApprovalId: approval.approvalId, source: "trajectory", format: "sft",
    })).rejects.toThrow(/snapshot is invalid|task hash mismatch/i);
  });

  test("record mutation atomically rejects active approvals with the wrong campaign binding", async () => {
    const { t, owner, ids, campaignId } = await setup();
    const approval = await owner.action(api.trainingApprovals.approveVerdictCampaign, { campaignId });
    const blobs = await t.run(async (ctx) => ({ jsonl: await ctx.storage.store(new Blob(["row"])), manifest: await ctx.storage.store(new Blob(["{}"])) }));
    await expect(t.mutation(internal.exports.recordExport, { projectId: ids.projectId, source: "trajectory", format: "sft", storageId: blobs.jsonl, manifestStorageId: blobs.manifest, trainingApprovalId: approval.approvalId, rowCount: 1, excludedCount: 0, manifest: "{}", createdById: ids.ownerId, createdAt: 1 })).rejects.toThrow(/campaign binding/i);
    await t.run(async (ctx) => { await ctx.storage.delete(blobs.jsonl); await ctx.storage.delete(blobs.manifest); });
  });

  test("generation racing revocation cannot retain usable export blobs", async () => {
    const { t, owner, ids, campaignId } = await setup();
    const approval = await owner.action(api.trainingApprovals.approveVerdictCampaign, { campaignId });
    const generating = owner.action(api.exports.generateExport, { projectId: ids.projectId, verdictCampaignId: campaignId, trainingApprovalId: approval.approvalId, source: "trajectory", format: "sft" });
    const revoking = owner.mutation(api.trainingApprovals.revoke, { approvalId: approval.approvalId });
    await Promise.allSettled([generating, revoking]);
    const state = await t.run(async (ctx) => {
      const approvalRow = await ctx.db.get(approval.approvalId);
      const exports = await ctx.db.query("trainingExports").withIndex("by_approval", (q) => q.eq("trainingApprovalId", approval.approvalId)).collect();
      return { status: approvalRow?.status, blobs: await Promise.all(exports.flatMap((row) => [ctx.storage.get(row.storageId), ...(row.manifestStorageId ? [ctx.storage.get(row.manifestStorageId)] : [])])) };
    });
    expect(state.status).toBe("revoked");
    expect(state.blobs.every((blob) => blob === null)).toBe(true);
    const orphanAttempt = await t.run(async (ctx) => ({ jsonl: await ctx.storage.store(new Blob(["race"])), manifest: await ctx.storage.store(new Blob(["{}"])) }));
    await expect(t.mutation(internal.exports.recordExport, {
      projectId: ids.projectId, source: "trajectory", format: "sft", storageId: orphanAttempt.jsonl, manifestStorageId: orphanAttempt.manifest,
      trainingApprovalId: approval.approvalId, verdictCampaignId: campaignId, rowCount: 1, excludedCount: 0, manifest: "{}", createdById: ids.ownerId, createdAt: Date.now(),
    })).rejects.toThrow(/no longer active/i);
    await t.run(async (ctx) => { await ctx.storage.delete(orphanAttempt.jsonl); await ctx.storage.delete(orphanAttempt.manifest); });
  });

  test("record rejection after storage cleans both newly-created blobs", async () => {
    const { t, owner, ids, campaignId } = await setup();
    const approval = await owner.action(api.trainingApprovals.approveVerdictCampaign, { campaignId });
    await t.run(async (ctx) => {
      const storageId = await ctx.storage.store(new Blob(["existing"]));
      const manifestStorageId = await ctx.storage.store(new Blob(["{}"]));
      for (let index = 0; index < TRAINING_EXPORT_LIMITS.maxExportsPerApproval; index++) {
        await ctx.db.insert("trainingExports", { projectId: ids.projectId, source: "trajectory", format: "sft", storageId, manifestStorageId, trainingApprovalId: approval.approvalId, rowCount: 1, excludedCount: 0, manifest: "{}", createdById: ids.ownerId, createdAt: index });
      }
    });
    const before = await t.run(async (ctx) => (await ctx.db.system.query("_storage").collect()).length);
    await expect(owner.action(api.exports.generateExport, { projectId: ids.projectId, verdictCampaignId: campaignId, trainingApprovalId: approval.approvalId, source: "trajectory", format: "sft" })).rejects.toThrow(/export limit/i);
    const after = await t.run(async (ctx) => (await ctx.db.system.query("_storage").collect()).length);
    expect(after).toBe(before);
  });

  test("revocation invalidates pre-issued URLs and list marks new and legacy rows unavailable", async () => {
    const { t, owner, ids, campaignId } = await setup();
    const approval = await owner.action(api.trainingApprovals.approveVerdictCampaign, { campaignId });
    const generated = await owner.action(api.exports.generateExport, { projectId: ids.projectId, verdictCampaignId: campaignId, trainingApprovalId: approval.approvalId, source: "trajectory", format: "sft" });
    const issued = await owner.action(api.exports.downloadExport, { exportId: generated.exportId });
    const legacyId = await t.run(async (ctx) => {
      const storageId = await ctx.storage.store(new Blob(["legacy"]));
      return await ctx.db.insert("trainingExports", { projectId: ids.projectId, source: "trajectory", format: "sft", storageId, rowCount: 1, excludedCount: 0, createdById: ids.ownerId, createdAt: Date.now() });
    });
    await owner.mutation(api.trainingApprovals.revoke, { approvalId: approval.approvalId });
    await expect(owner.action(api.exports.downloadExport, { exportId: generated.exportId })).rejects.toThrow(/revoked|unavailable/i);
    const rows = await owner.query(api.exports.listExports, { projectId: ids.projectId });
    expect(rows.find((row) => row._id === generated.exportId)?.availability).toBe("revoked");
    expect(rows.find((row) => row._id === legacyId)?.availability).toBe("legacy_unapproved");
    const deleted = await t.run(async (ctx) => {
      const row = await ctx.db.get(generated.exportId);
      return row ? [await ctx.storage.get(row.storageId), row.manifestStorageId ? await ctx.storage.get(row.manifestStorageId) : null] : [];
    });
    expect(deleted).toEqual([null, null]);
    expect(issued.url).toBeTruthy();
    expect(issued.manifestUrl).toBeTruthy();
    expect((await t.fetch(new URL(issued.url).pathname)).status).not.toBe(200);
    expect((await t.fetch(new URL(issued.manifestUrl).pathname)).status).not.toBe(200);
  });

  test("approval projection cap accepts exact bytes and rejects one byte above", async () => {
    for (const [size, allowed] of [[TRAINING_EXPORT_LIMITS.maxProjectionBytes, true], [TRAINING_EXPORT_LIMITS.maxProjectionBytes + 1, false]] as const) {
      const state = await setup();
      await state.t.run(async (ctx) => {
        const span = await ctx.db.query("fullSpanEvalRuns").unique();
        if (!span?.reviewerProjectionStorageId) throw new Error("span projection missing");
        let text: string;
        if (!allowed) {
          text = "x".repeat(size);
        } else {
          const prior = await ctx.storage.get(span.reviewerProjectionStorageId);
          if (!prior) throw new Error("projection blob missing");
          const projection = JSON.parse(await prior.text()) as Record<string, unknown>;
          const events = projection.events as Array<Record<string, unknown>>;
          const verifier = projection.verifierEvidence as Record<string, unknown>;
          projection.finalOutput = "x";
          if (!events[0]) throw new Error("projection event missing");
          events[0].content = "x";
          projection.patch = "x";
          verifier.stdout = "x";
          verifier.stderr = "x";
          const fields: Array<[Record<string, unknown>, string, number]> = [
            [projection, "finalOutput", 256_000], [events[0], "content", 256_000],
            [projection, "patch", 65_536], [verifier, "stdout", 8_192], [verifier, "stderr", 8_192],
          ];
          for (const [target, key, max] of fields) {
            const current = String(target[key]);
            const deficit = size - new TextEncoder().encode(JSON.stringify(projection)).byteLength;
            if (deficit <= 0) break;
            target[key] = current + "x".repeat(Math.min(deficit, max - current.length));
          }
          text = JSON.stringify(projection);
          expect(new TextEncoder().encode(text).byteLength).toBe(size);
        }
        const projection = await ctx.storage.store(new Blob([text]));
        await ctx.db.patch(span._id, { reviewerProjectionStorageId: projection });
      });
      const approval = state.owner.action(api.trainingApprovals.approveVerdictCampaign, { campaignId: state.campaignId });
      if (allowed) await expect(approval).resolves.toMatchObject({ eligibleCount: 1 });
      else await expect(approval).rejects.toThrow(/byte limit/i);
    }
  });

  test("approval candidate cap accepts exactly the limit and rejects one above", async () => {
    const atLimit = await setup();
    const traceId = await atLimit.t.run(async (ctx) => (await ctx.db.query("fullSpanEvalRuns").unique())?.agentTraceId);
    if (!traceId) throw new Error("trace missing");
    const makeCampaign = async (count: number, suffix: string) => await atLimit.t.run(async (ctx) => {
      const campaignId = await ctx.db.insert("verdictReviewCampaigns", { projectId: atLimit.ids.projectId, name: suffix, status: "closed", shareToken: suffix, itemCount: count, judgmentCount: count, createdById: atLimit.ids.ownerId, createdAt: 1, closedAt: 2 });
      for (let index = 0; index < count; index++) {
        const itemId = await ctx.db.insert("verdictReviewItems", { campaignId, projectId: atLimit.ids.projectId, agentTraceId: traceId, sortOrder: index });
        await ctx.db.insert("verdictReviewDecisions", { campaignId, itemId, projectId: atLimit.ids.projectId, agentTraceId: traceId, userId: atLimit.ids.guestId, rating: "best", decidedAt: 1 });
      }
      return campaignId;
    });
    const allowed = await makeCampaign(TRAINING_EXPORT_LIMITS.maxCandidates, "at-limit");
    await expect(atLimit.owner.action(api.trainingApprovals.approveVerdictCampaign, { campaignId: allowed })).resolves.toMatchObject({ eligibleCount: TRAINING_EXPORT_LIMITS.maxCandidates });
    const denied = await makeCampaign(TRAINING_EXPORT_LIMITS.maxCandidates + 1, "above-limit");
    await expect(atLimit.owner.action(api.trainingApprovals.approveVerdictCampaign, { campaignId: denied })).rejects.toThrow(/at most|supports/i);
  });

  test("isolated-sandbox producer provenance stays out of approved SFT and its manifest", async () => {
    const { t, owner, ids, campaignId } = await setup(isolatedSandboxFixture);
    const approval = await owner.action(api.trainingApprovals.approveVerdictCampaign, { campaignId });
    const generated = await owner.action(api.exports.generateExport, {
      projectId: ids.projectId, verdictCampaignId: campaignId, trainingApprovalId: approval.approvalId, source: "trajectory", format: "sft",
    });
    const jsonl = await exportText(t, generated.exportId);
    expect(jsonl).not.toMatch(/isolated-sandbox|daytona|fictional-provider|fictional-model|harbor\/pi/i);
    expect(JSON.stringify(generated.manifest)).not.toMatch(/isolated-sandbox|daytona|provider|model|harness/i);
    await expect(verifyApprovedExportArtifact(jsonl, generated.manifest)).resolves.toEqual({ ready: true, reasons: [] });
  });

  test("writes messages-only reviewer-safe SFT with exact hashes and aggregate-only manifest", async () => {
    const { t, owner, ids, campaignId } = await setup();
    const approval = await owner.action(api.trainingApprovals.approveVerdictCampaign, { campaignId });
    const generated = await owner.action(api.exports.generateExport, {
      projectId: ids.projectId,
      verdictCampaignId: campaignId,
      trainingApprovalId: approval.approvalId,
      source: "trajectory",
      format: "sft",
    });
    const jsonl = await exportText(t, generated.exportId);
    const parsed = JSON.parse(jsonl.trim()) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["messages"]);
    const serialized = JSON.stringify(parsed);
    expect(serialized).toContain("Fix fictional widget arithmetic.");
    expect(serialized).toContain("I will edit.");
    expect(serialized).toContain("change_file");
    expect(serialized).toContain("edited [WORKSPACE_PATH]");
    expect(serialized).not.toMatch(/assistant_reasoning|objective_outcomes|verifier|infrastructure|reward|workspace_change|policy_event|termination|fictional-provider|fictional-model|analysis_metadata|attempt-fixture|call-1/);
    expect(generated.manifest.integrity).toMatchObject({ reconciled: true, candidate_count: 1 });
    expect(generated.manifest.integrity.row_hashes).toHaveLength(1);
    expect(generated.manifest.integrity.dataset_hash).toMatch(/^[a-f0-9]{64}$/);
    await expect(verifyApprovedExportArtifact(jsonl, generated.manifest)).resolves.toEqual({ ready: true, reasons: [] });
    expect(JSON.stringify(generated.manifest)).not.toContain(String(ids.projectId));
  });
});
