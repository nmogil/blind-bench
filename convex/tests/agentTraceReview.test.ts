/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
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

  test("blind reviewer discovers reviewable traces across their projects, blinded", async () => {
    const t = convexTest(schema);
    const { ids, asOwner, asBlind } = await seed(t);
    await persist(asOwner, ids.projectId, baseRun);

    const list = await asBlind.query(api.agentTraces.listReviewableTraces, {});
    expect(list).toHaveLength(1);
    expect(list[0]?.projectName).toBe("P");
    expect(list[0]?.stepCount).toBeGreaterThan(0);
    // Blinded: no harness/model/product for the evaluator.
    expect(list[0]?.harnessName).toBeUndefined();
    expect(list[0]?.model).toBeUndefined();
    expect(JSON.stringify(list)).not.toContain("jeeves_clog");
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

  test("#311: two reviewers' decisions coexist; each sees only their own pick", async () => {
    const t = convexTest(schema);
    const { ids, asOwner, asBlind } = await seed(t);
    const left = await persist(asOwner, ids.projectId, baseRun);
    const right = await persist(asOwner, ids.projectId, { ...baseRun, run_id: "JEEVES-RUN-REVIEW-C" });
    const matchupId = await asOwner.mutation(api.agentTraceReview.createMatchup, {
      leftTraceId: left, rightTraceId: right, divergenceStepIndex: 3,
      leftBlindLabel: "A", rightBlindLabel: "B",
    });

    await asBlind.mutation(api.agentTraceReview.decideMatchup, { matchupId, winner: "left", reasonTags: ["accuracy"] });
    await asOwner.mutation(api.agentTraceReview.decideMatchup, { matchupId, winner: "right", reasonTags: ["tone"] });
    // Re-decide upserts, never duplicates.
    await asBlind.mutation(api.agentTraceReview.decideMatchup, { matchupId, winner: "tie", reasonTags: [] });

    const rows = await t.run(async (ctx) =>
      ctx.db.query("agentTraceMatchupDecisions").withIndex("by_matchup", (q) => q.eq("matchupId", matchupId)).collect(),
    );
    expect(rows).toHaveLength(2);

    const mineBlind = await asBlind.query(api.agentTraceReview.getMatchup, { matchupId });
    const mineOwner = await asOwner.query(api.agentTraceReview.getMatchup, { matchupId });
    expect(mineBlind?.winner).toBe("tie");
    expect(mineOwner?.winner).toBe("right");
    // The matchup row itself is never patched (last-write-wins is gone).
    const raw = await t.run(async (ctx) => ctx.db.get(matchupId));
    expect(raw?.winner).toBeUndefined();
  });

  test("#312: createMatchup rejects divergence points the traces don't share", async () => {
    const t = convexTest(schema);
    const { ids, asOwner } = await seed(t);
    const left = await persist(asOwner, ids.projectId, baseRun);
    // Diverges at step 1 (different tool), so any later divergence index is invalid.
    const right = await persist(asOwner, ids.projectId, {
      ...baseRun,
      run_id: "JEEVES-RUN-REVIEW-D",
      steps: [
        { type: "message", role: "assistant", content: "Looking it up." },
        { type: "tool_call", id: "t1", name: "close_ticket", args: {} },
        { type: "tool_result", id: "t1", name: "close_ticket", result: {} },
        { type: "tool_call", id: "t2", name: "create_escalation", args: { reason: "hardship" } },
      ],
    });
    await expect(
      asOwner.mutation(api.agentTraceReview.createMatchup, {
        leftTraceId: left, rightTraceId: right, divergenceStepIndex: 3,
        leftBlindLabel: "A", rightBlindLabel: "B",
      }),
    ).rejects.toThrow(/already differ/);
    // Out-of-range divergence is rejected too.
    await expect(
      asOwner.mutation(api.agentTraceReview.createMatchup, {
        leftTraceId: left, rightTraceId: right, divergenceStepIndex: 99,
        leftBlindLabel: "A", rightBlindLabel: "B",
      }),
    ).rejects.toThrow(/must exist in both/);
  });

  test("#310: review handles are opaque tokens, resolvable by reviewers", async () => {
    const t = convexTest(schema);
    const { ids, asOwner, asBlind } = await seed(t);
    const traceId = await persist(asOwner, ids.projectId, baseRun);

    const list = await asBlind.query(api.agentTraces.listReviewableTraces, {});
    const handle = list[0]?.handle;
    expect(handle).toBeDefined();
    expect(handle).not.toBe(traceId); // never the raw Convex id
    expect(handle).toMatch(/^[0-9a-f]{32}$/);

    const resolved = await asBlind.query(api.agentTraces.resolveReviewHandle, { handle: handle! });
    expect(resolved?.agentTraceId).toBe(traceId);

    const right = await persist(asOwner, ids.projectId, { ...baseRun, run_id: "JEEVES-RUN-REVIEW-E" });
    const matchupId = await asOwner.mutation(api.agentTraceReview.createMatchup, {
      leftTraceId: traceId, rightTraceId: right, divergenceStepIndex: 3,
      leftBlindLabel: "A", rightBlindLabel: "B",
    });
    const token = await t.run(async (ctx) => (await ctx.db.get(matchupId))?.reviewToken);
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    const m = await asBlind.query(api.agentTraceReview.resolveMatchupHandle, { handle: token! });
    expect(m?.matchupId).toBe(matchupId);
  });

  test("#310: pre-token rows still resolve by raw id until backfill runs", async () => {
    const t = convexTest(schema);
    const { ids, asOwner, asBlind } = await seed(t);
    const traceId = await persist(asOwner, ids.projectId, baseRun);
    // Simulate a legacy row created before tokens existed.
    await t.run(async (ctx) => ctx.db.patch(traceId, { reviewToken: undefined }));

    const resolved = await asBlind.query(api.agentTraces.resolveReviewHandle, { handle: traceId });
    expect(resolved?.agentTraceId).toBe(traceId);

    // Backfill stamps it; afterwards the token resolves too.
    await t.mutation(internal.agentTraces.backfillReviewTokens, {});
    const token = await t.run(async (ctx) => (await ctx.db.get(traceId))?.reviewToken);
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    const byToken = await asBlind.query(api.agentTraces.resolveReviewHandle, { handle: token! });
    expect(byToken?.agentTraceId).toBe(traceId);
  });
});
