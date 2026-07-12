/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import {
  normalizeJeevesClogRun,
  type AgentRunTrace,
  type JeevesClogRunExport,
} from "../lib/agentTrace";

const asJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
type Identity = ReturnType<ReturnType<typeof convexTest>["withIdentity"]>;

const runWith = (
  runId: string,
  divergenceTool: string,
  firstMessage = "Looking it up.",
): JeevesClogRunExport => ({
  run_id: runId,
  product: "support",
  harness: { name: "pi", version: "3", sdk: "pi_session_jsonl" },
  model: "claude-sonnet-4-7",
  steps: [
    { type: "message", role: "user", content: "Handle the account." },
    { type: "message", role: "assistant", content: firstMessage },
    { type: "tool_call", id: "t2", name: divergenceTool, args: { account: "A-1" } },
  ],
  final_answer: "Done.",
  usage: { total_tokens: 100 },
});

async function seed(t: ReturnType<typeof convexTest>) {
  const ids = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Owner", email: "owner@test.com" });
    const reviewer1 = await ctx.db.insert("users", { name: "Reviewer 1", email: "r1@test.com" });
    const reviewer2 = await ctx.db.insert("users", { name: "Reviewer 2", email: "r2@test.com" });
    const orgId = await ctx.db.insert("organizations", { name: "Org", slug: "org", createdById: owner });
    await ctx.db.insert("organizationMembers", { organizationId: orgId, userId: owner, role: "owner" });
    const projectId = await ctx.db.insert("projects", { organizationId: orgId, name: "Agent QA", createdById: owner });
    await ctx.db.insert("projectCollaborators", { projectId, userId: owner, role: "owner", invitedById: owner, invitedAt: Date.now() });
    await ctx.db.insert("projectCollaborators", { projectId, userId: reviewer1, role: "evaluator", blindMode: true, invitedById: owner, invitedAt: Date.now() });
    await ctx.db.insert("projectCollaborators", { projectId, userId: reviewer2, role: "evaluator", blindMode: true, invitedById: owner, invitedAt: Date.now() });
    return { owner, reviewer1, reviewer2, projectId };
  });
  const identity = (userId: Id<"users">) => t.withIdentity({
    subject: `${userId}|session`,
    tokenIdentifier: `test|${userId}`,
  });
  return {
    ids,
    asOwner: identity(ids.owner),
    asReviewer1: identity(ids.reviewer1),
    asReviewer2: identity(ids.reviewer2),
  };
}

async function persist(identity: Identity, projectId: Id<"projects">, run: JeevesClogRunExport) {
  const result = await identity.action(api.agentTraces.persistTrace, {
    projectId,
    trace: asJson(normalizeJeevesClogRun(run)) as unknown as AgentRunTrace,
  });
  return result.agentTraceId;
}

async function tokenFor(
  identity: Identity,
  kind: "trace" | "matchup",
): Promise<string> {
  const sessions = await identity.query(api.agentTraceReviewSessions.listMine, {});
  const session = sessions.find((candidate) => candidate.kind === kind);
  if (!session) throw new Error(`Missing ${kind} review session in test`);
  return session.token;
}

describe("opaque trajectory review sessions", () => {
  test("reviewer payloads and access use tokens only; raw ID functions are denied", async () => {
    const t = convexTest(schema);
    const { ids, asOwner, asReviewer1, asReviewer2 } = await seed(t);
    const traceId = await persist(asOwner, ids.projectId, runWith("trace-a", "escalate"));

    const sessions = await asReviewer1.query(api.agentTraceReviewSessions.listMine, {});
    expect(sessions).toHaveLength(1);
    const serialized = JSON.stringify(sessions);
    expect(serialized).not.toContain(traceId);
    expect(serialized).not.toContain("agentTraceId");
    expect(serialized).not.toContain("claude-sonnet");
    expect(serialized).not.toContain("pi_session_jsonl");

    const token = sessions[0]?.token;
    if (!token) throw new Error("Missing review token");
    const trace = await asReviewer1.query(api.agentTraceReviewSessions.getTrace, { token });
    expect(trace.projectName).toBe("Agent QA");
    expect(trace).not.toHaveProperty("_id");
    expect(trace).not.toHaveProperty("model");
    const steps = await asReviewer1.query(api.agentTraceReviewSessions.listSteps, {
      token,
      paginationOpts: { numItems: 20, cursor: null },
    });
    expect(steps.page).toHaveLength(3);
    expect(JSON.stringify(steps)).not.toContain(traceId);

    const reviewer2Token = await tokenFor(asReviewer2, "trace");
    await asReviewer2.mutation(api.agentTraceReviewSessions.addComment, {
      token: reviewer2Token,
      target: { kind: "step", stepIndex: 1 },
      comment: "Peer comment must remain independent.",
      label: "thought",
    });
    await asReviewer1.mutation(api.agentTraceReviewSessions.addComment, {
      token,
      target: { kind: "step", stepIndex: 1 },
      comment: "Good evidence gathering.",
      label: "praise",
    });
    const myComments = await asReviewer1.query(api.agentTraceReviewSessions.listComments, { token });
    expect(myComments).toHaveLength(1);
    expect(JSON.stringify(myComments)).not.toContain("Peer comment");
    await asReviewer1.mutation(api.agentTraceReviewSessions.setVerdict, {
      token,
      rating: "acceptable",
    });
    expect((await asReviewer1.query(api.agentTraceReviewSessions.myVerdict, { token }))?.rating).toBe("acceptable");

    await expect(asReviewer1.query(api.agentTraces.getTrace, { agentTraceId: traceId })).rejects.toThrow(/opaque review session/i);
    await expect(asReviewer1.query(api.agentTraces.listSteps, {
      agentTraceId: traceId,
      paginationOpts: { numItems: 20, cursor: null },
    })).rejects.toThrow(/opaque review session/i);

    await t.run(async (ctx) => {
      const collaborator = await ctx.db
        .query("projectCollaborators")
        .withIndex("by_project_and_user", (q) =>
          q.eq("projectId", ids.projectId).eq("userId", ids.reviewer1),
        )
        .unique();
      if (collaborator) await ctx.db.delete(collaborator._id);
    });
    expect(await asReviewer1.query(api.agentTraceReviewSessions.listMine, {})).toEqual([]);
    await expect(asReviewer1.query(api.agentTraceReviewSessions.getTrace, { token }))
      .rejects.toThrow(/not found or expired/i);
  });

  test("two reviewers keep independent matchup decisions and disagreement is explicitly excluded", async () => {
    const t = convexTest(schema);
    const { ids, asOwner, asReviewer1, asReviewer2 } = await seed(t);
    const left = await persist(asOwner, ids.projectId, runWith("left", "escalate"));
    const right = await persist(asOwner, ids.projectId, runWith("right", "close_ticket"));
    await asOwner.mutation(api.agentTraceReview.createMatchup, {
      leftTraceId: left,
      rightTraceId: right,
      divergenceStepIndex: 2,
      leftBlindLabel: "A",
      rightBlindLabel: "B",
    });

    const token1 = await tokenFor(asReviewer1, "matchup");
    const token2 = await tokenFor(asReviewer2, "matchup");
    expect(token1).not.toBe(token2);
    await asReviewer1.mutation(api.agentTraceReviewSessions.decideMatchup, {
      token: token1,
      winner: "left",
      reasonTags: ["accuracy"],
    });
    await asReviewer2.mutation(api.agentTraceReviewSessions.decideMatchup, {
      token: token2,
      winner: "right",
      reasonTags: ["safety"],
    });

    const decisions = await t.run(async (ctx) => await ctx.db.query("agentTraceMatchupDecisions").collect());
    expect(decisions).toHaveLength(2);
    expect(new Set(decisions.map((decision) => decision.userId)).size).toBe(2);
    expect((await asReviewer1.query(api.agentTraceReviewSessions.getMatchup, { token: token1 })).winner).toBe("left");
    expect((await asReviewer2.query(api.agentTraceReviewSessions.getMatchup, { token: token2 })).winner).toBe("right");

    await expect(asOwner.action(api.exports.generateExport, {
      projectId: ids.projectId,
      source: "trajectory",
      format: "dpo",
    })).rejects.toThrow(/training approval/i);

    await asReviewer2.mutation(api.agentTraceReviewSessions.decideMatchup, {
      token: token2,
      winner: "tie",
      reasonTags: [],
    });
    await expect(asOwner.action(api.exports.generateExport, {
      projectId: ids.projectId,
      source: "trajectory",
      format: "dpo",
    })).rejects.toThrow(/training approval/i);
  });

  test("mismatched prefixes are persisted invalid and excluded with an explicit manifest reason", async () => {
    const t = convexTest(schema);
    const { ids, asOwner, asReviewer1 } = await seed(t);
    const left = await persist(asOwner, ids.projectId, runWith("left-mismatch", "escalate"));
    const right = await persist(asOwner, ids.projectId, runWith("right-mismatch", "close_ticket", "Different prefix."));
    const matchupId = await asOwner.mutation(api.agentTraceReview.createMatchup, {
      leftTraceId: left,
      rightTraceId: right,
      divergenceStepIndex: 2,
      leftBlindLabel: "A",
      rightBlindLabel: "B",
    });
    const matchup = await t.run(async (ctx) => await ctx.db.get(matchupId));
    expect(matchup?.comparabilityStatus).toBe("invalid");
    expect(matchup?.invalidReason).toBe("prefix_mismatch");
    expect((await asReviewer1.query(api.agentTraceReviewSessions.listMine, {})).filter((session) => session.kind === "matchup")).toHaveLength(0);

    await expect(asOwner.action(api.exports.generateExport, {
      projectId: ids.projectId,
      source: "trajectory",
      format: "dpo",
    })).rejects.toThrow(/training approval/i);
  });
});
