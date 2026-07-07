/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import {
  normalizeJeevesClogRun,
  type JeevesClogRunExport,
  type AgentRunTrace,
} from "../lib/agentTrace";

const asJson = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
type Ident = ReturnType<ReturnType<typeof convexTest>["withIdentity"]>;

// Two trajectories that share a 2-step prefix then diverge at step 2.
const runWith = (run_id: string, divergingTool: string): JeevesClogRunExport => ({
  run_id,
  product: "acme",
  harness: { name: "jeeves_clog", version: "v1", sdk: "clog" },
  model: "claude-sonnet-4-0",
  messages: [{ role: "user", content: "Handle the account." }],
  steps: [
    { type: "message", role: "assistant", content: "Looking it up." },
    { type: "tool_call", id: "t1", name: "lookup_account", args: { id: "ACCT-TEST-1" } },
    { type: "tool_call", id: "t2", name: divergingTool, args: { note: "x" } },
  ],
  final_answer: "Done.",
  usage: { cost_usd: 0.01, duration_ms: 1000, total_tokens: 500 },
});

async function seed(t: ReturnType<typeof convexTest>) {
  const ids = await t.run(async (ctx) => {
    const ownerUserId = await ctx.db.insert("users", { name: "Owner", email: "owner@test.com" });
    const evalUserId = await ctx.db.insert("users", { name: "Rev", email: "rev@test.com" });
    const orgId = await ctx.db.insert("organizations", { name: "Org", slug: "org", createdById: ownerUserId });
    await ctx.db.insert("organizationMembers", { organizationId: orgId, userId: ownerUserId, role: "owner" });
    const projectId = await ctx.db.insert("projects", { organizationId: orgId, name: "P", createdById: ownerUserId });
    await ctx.db.insert("projectCollaborators", { projectId, userId: ownerUserId, role: "owner", invitedById: ownerUserId, invitedAt: Date.now() });
    await ctx.db.insert("projectCollaborators", { projectId, userId: evalUserId, role: "evaluator", invitedById: ownerUserId, invitedAt: Date.now() });
    return { ownerUserId, evalUserId, projectId };
  });
  return {
    ids,
    asOwner: t.withIdentity({ subject: `${ids.ownerUserId}|s`, tokenIdentifier: `test|${ids.ownerUserId}` }),
    asEval: t.withIdentity({ subject: `${ids.evalUserId}|s`, tokenIdentifier: `test|${ids.evalUserId}` }),
  };
}

const persist = async (as: Ident, projectId: Id<"projects">, run: JeevesClogRunExport) => {
  const res = await as.action(api.agentTraces.persistTrace, {
    projectId,
    trace: asJson(normalizeJeevesClogRun(run)) as unknown as AgentRunTrace,
  });
  return res.agentTraceId;
};

const readExport = async (t: ReturnType<typeof convexTest>, exportId: Id<"trainingExports">) =>
  await t.run(async (ctx) => {
    const row = await ctx.db.get(exportId);
    const blob = row ? await ctx.storage.get(row.storageId) : null;
    return blob ? await blob.text() : "";
  });

describe("#53 training export", () => {
  test("trajectory DPO: winner's divergence step is chosen, loser's rejected, prefix is the prompt", async () => {
    const t = convexTest(schema);
    const { ids, asOwner } = await seed(t);
    const left = await persist(asOwner, ids.projectId, runWith("A", "create_escalation"));
    const right = await persist(asOwner, ids.projectId, runWith("B", "close_ticket"));
    const matchupId = await asOwner.mutation(api.agentTraceReview.createMatchup, {
      leftTraceId: left, rightTraceId: right, divergenceStepIndex: 2,
      leftBlindLabel: "A", rightBlindLabel: "B",
    });
    await asOwner.mutation(api.agentTraceReview.decideMatchup, { matchupId, winner: "left", reasonTags: ["accuracy"] });

    const res = await asOwner.action(api.exports.generateExport, {
      projectId: ids.projectId, source: "trajectory", format: "dpo",
    });
    expect(res.rowCount).toBe(1);
    const line = JSON.parse(await readExport(t, res.exportId));
    expect(line.chosen).toContain("create_escalation"); // winner (left) next action
    expect(line.rejected).toContain("close_ticket"); // loser (right) next action
    expect(line.prompt).toContain("lookup_account"); // shared prefix
    expect(line.prompt).not.toContain("create_escalation"); // prefix stops before divergence
  });

  test("output-preference DPO: best vs weak with the resolved prompt", async () => {
    const t = convexTest(schema);
    const { ids, asOwner } = await seed(t);
    await t.run(async (ctx) => {
      const versionId = await ctx.db.insert("promptVersions", {
        projectId: ids.projectId, versionNumber: 1,
        // messages[] is canonical (readMessages prefers it); userMessageTemplate
        // is the still-required legacy field.
        messages: [{ id: "m1", role: "user", content: "Handle {{topic}} for the customer." }],
        userMessageTemplate: "Handle {{topic}} for the customer.",
        status: "current",
        createdById: ids.ownerUserId,
      });
      const runId = await ctx.db.insert("promptRuns", {
        projectId: ids.projectId, promptVersionId: versionId,
        inlineVariables: { topic: "a refund" },
        model: "m", temperature: 0, status: "completed", triggeredById: ids.ownerUserId,
      });
      const good = await ctx.db.insert("runOutputs", { runId, blindLabel: "A", outputContent: "Happy to refund you." });
      const bad = await ctx.db.insert("runOutputs", { runId, blindLabel: "B", outputContent: "No refunds." });
      await ctx.db.insert("outputPreferences", { runId, outputId: good, userId: ids.ownerUserId, rating: "best" });
      await ctx.db.insert("outputPreferences", { runId, outputId: bad, userId: ids.ownerUserId, rating: "weak" });
    });

    const res = await asOwner.action(api.exports.generateExport, {
      projectId: ids.projectId, source: "output_preference", format: "dpo",
    });
    expect(res.rowCount).toBe(1);
    const line = JSON.parse(await readExport(t, res.exportId));
    expect(line.prompt).toContain("Handle a refund for the customer."); // {{topic}} substituted
    expect(line.chosen).toBe("Happy to refund you.");
    expect(line.rejected).toBe("No refunds.");
  });

  test("consent gate: a pii-classed trajectory is excluded unless allowSensitive", async () => {
    const t = convexTest(schema);
    const { ids, asOwner } = await seed(t);
    // ssn in args → normalizer marks the trace privacy pii.
    const piiRun = (id: string, tool: string): JeevesClogRunExport => ({
      ...runWith(id, tool),
      steps: [
        { type: "tool_call", id: "t1", name: "lookup", args: { ssn: "123-45-6789" } },
        { type: "tool_call", id: "t2", name: tool, args: {} },
      ],
    });
    const left = await persist(asOwner, ids.projectId, piiRun("A", "escalate"));
    const right = await persist(asOwner, ids.projectId, piiRun("B", "close"));
    const matchupId = await asOwner.mutation(api.agentTraceReview.createMatchup, {
      leftTraceId: left, rightTraceId: right, divergenceStepIndex: 1, leftBlindLabel: "A", rightBlindLabel: "B",
    });
    await asOwner.mutation(api.agentTraceReview.decideMatchup, { matchupId, winner: "left", reasonTags: [] });

    const denied = await asOwner.action(api.exports.generateExport, { projectId: ids.projectId, source: "trajectory", format: "dpo" });
    expect(denied.rowCount).toBe(0);
    expect(denied.excludedCount).toBe(1);

    const consented = await asOwner.action(api.exports.generateExport, { projectId: ids.projectId, source: "trajectory", format: "dpo", allowSensitive: true });
    expect(consented.rowCount).toBe(1);
  });

  test("export is owner/editor only — an evaluator is denied", async () => {
    const t = convexTest(schema);
    const { ids, asEval } = await seed(t);
    await expect(
      asEval.action(api.exports.generateExport, { projectId: ids.projectId, source: "output_preference", format: "sft" }),
    ).rejects.toThrow(/Permission denied/);
  });

  test("download link expires after 1 hour", async () => {
    const t = convexTest(schema);
    const { ids, asOwner } = await seed(t);
    const res = await asOwner.action(api.exports.generateExport, { projectId: ids.projectId, source: "output_preference", format: "dpo" });
    // Fresh download works.
    await expect(asOwner.action(api.exports.downloadExport, { exportId: res.exportId })).resolves.toBeTruthy();
    // Age the row past the TTL.
    await t.run(async (ctx) => {
      await ctx.db.patch(res.exportId, { createdAt: Date.now() - 2 * 60 * 60 * 1000 });
    });
    await expect(asOwner.action(api.exports.downloadExport, { exportId: res.exportId })).rejects.toThrow(/expired/);
  });
});
