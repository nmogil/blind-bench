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

const baseRun: JeevesClogRunExport = {
  run_id: "JEEVES-RUN-REVIEW-A",
  product: "jeeves",
  harness: { name: "jeeves_clog", version: "v1", sdk: "clog" },
  model: "claude-sonnet-4-0",
  messages: [{ role: "user", content: "Handle the account." }],
  steps: [
    { type: "message", role: "assistant", content: "Looking it up." },
    { type: "tool_call", id: "t1", name: "lookup_account", args: { account_id: "ACCT-TEST-R-1" } },
    { type: "tool_result", id: "t1", name: "lookup_account", result: { status: "active" } },
    { type: "tool_call", id: "t2", name: "create_escalation", args: { reason: "hardship" } },
  ],
  final_answer: "Escalated.",
  usage: { cost_usd: 0.01, duration_ms: 1000, total_tokens: 500 },
};
const asJson = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

async function seed(t: ReturnType<typeof convexTest>) {
  const ids = await t.run(async (ctx) => {
    const ownerUserId = await ctx.db.insert("users", { name: "Owner", email: "o@test.com" });
    const evaluatorUserId = await ctx.db.insert("users", { name: "Rev", email: "r@test.com" });
    const orgId = await ctx.db.insert("organizations", { name: "Org", slug: "org", createdById: ownerUserId });
    await ctx.db.insert("organizationMembers", { organizationId: orgId, userId: ownerUserId, role: "owner" });
    const projectId = await ctx.db.insert("projects", { organizationId: orgId, name: "P", createdById: ownerUserId });
    await ctx.db.insert("projectCollaborators", { projectId, userId: ownerUserId, role: "owner", invitedById: ownerUserId, invitedAt: Date.now() });
    await ctx.db.insert("projectCollaborators", { projectId, userId: evaluatorUserId, role: "evaluator", invitedById: ownerUserId, invitedAt: Date.now() });
    return { ownerUserId, evaluatorUserId, projectId };
  });
  return {
    ids,
    asOwner: t.withIdentity({ subject: `${ids.ownerUserId}|s`, tokenIdentifier: `test|${ids.ownerUserId}` }),
    asBlind: t.withIdentity({ subject: `${ids.evaluatorUserId}|s`, tokenIdentifier: `test|${ids.evaluatorUserId}` }),
  };
}

type Ident = ReturnType<ReturnType<typeof convexTest>["withIdentity"]>;

async function persist(asUser: Ident, projectId: Id<"projects">, run: JeevesClogRunExport) {
  const trace = normalizeJeevesClogRun(run);
  const res = await asUser.action(api.agentTraces.persistTrace, {
    projectId,
    trace: asJson(trace) as unknown as AgentRunTrace,
  });
  return res.agentTraceId;
}

describe("#267 step-level trace review", () => {
  test("blind reviewer comments on a tool-call step; owner sees it anchored correctly", async () => {
    const t = convexTest(schema);
    const { ids, asOwner, asBlind } = await seed(t);
    const traceId = await persist(asOwner, ids.projectId, baseRun);

    await asBlind.mutation(api.agentTraceReview.addComment, {
      agentTraceId: traceId,
      target: { kind: "tool_call", stepIndex: 3 }, // the create_escalation call
      comment: "Escalating on hardship without verifying is risky.",
      label: "issue",
      tags: ["accuracy", "safety"],
    });

    const asOwnerComments = await asOwner.query(api.agentTraceReview.listComments, { agentTraceId: traceId });
    expect(asOwnerComments).toHaveLength(1);
    expect(asOwnerComments[0]?.target).toEqual({ kind: "tool_call", stepIndex: 3 });
    expect(asOwnerComments[0]?.label).toBe("issue");
    expect(asOwnerComments[0]?.tags).toContain("safety");
  });

  test("out-of-range step anchor is rejected", async () => {
    const t = convexTest(schema);
    const { ids, asOwner, asBlind } = await seed(t);
    const traceId = await persist(asOwner, ids.projectId, baseRun);
    await expect(
      asBlind.mutation(api.agentTraceReview.addComment, {
        agentTraceId: traceId,
        target: { kind: "step", stepIndex: 99 },
        comment: "no such step",
        label: "thought",
      }),
    ).rejects.toThrow(/not part of this trace/);
  });

  test("verdict upserts (one row per reviewer)", async () => {
    const t = convexTest(schema);
    const { ids, asOwner, asBlind } = await seed(t);
    const traceId = await persist(asOwner, ids.projectId, baseRun);

    await asBlind.mutation(api.agentTraceReview.setVerdict, { agentTraceId: traceId, rating: "weak" });
    await asBlind.mutation(api.agentTraceReview.setVerdict, { agentTraceId: traceId, rating: "acceptable", note: "changed my mind" });

    const mine = await asBlind.query(api.agentTraceReview.myVerdict, { agentTraceId: traceId });
    expect(mine?.rating).toBe("acceptable");
    const count = await t.run(async (ctx) =>
      (await ctx.db.query("agentTraceVerdicts").withIndex("by_trace", (q) => q.eq("agentTraceId", traceId)).collect()).length,
    );
    expect(count).toBe(1);
  });

  test("step-level pairwise: owner sets up, blind reviewer picks the winner", async () => {
    const t = convexTest(schema);
    const { ids, asOwner, asBlind } = await seed(t);
    const left = await persist(asOwner, ids.projectId, baseRun);
    const right = await persist(asOwner, ids.projectId, { ...baseRun, run_id: "JEEVES-RUN-REVIEW-B", final_answer: "Did nothing." });

    const matchupId = await asOwner.mutation(api.agentTraceReview.createMatchup, {
      leftTraceId: left,
      rightTraceId: right,
      divergenceStepIndex: 3,
      leftBlindLabel: "Trajectory A",
      rightBlindLabel: "Trajectory B",
    });

    await asBlind.mutation(api.agentTraceReview.decideMatchup, {
      matchupId,
      winner: "left",
      reasonTags: ["accuracy"],
    });

    const m = await asBlind.query(api.agentTraceReview.getMatchup, { matchupId });
    expect(m?.winner).toBe("left");
    expect(m?.leftBlindLabel).toBe("Trajectory A");
    // No provenance in the matchup payload.
    expect(JSON.stringify(m)).not.toContain("jeeves_clog");
    expect(JSON.stringify(m)).not.toContain("claude-sonnet-4-0");
  });
});
