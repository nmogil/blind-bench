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

type TestIdentity = ReturnType<ReturnType<typeof convexTest>["withIdentity"]>;

function run(runId: string, answer: string): JeevesClogRunExport {
  return {
    run_id: runId,
    product: "support",
    harness: { name: "pi", version: "3", sdk: "pi_session_jsonl" },
    model: "claude-sonnet",
    steps: [
      { type: "message", role: "user", content: `Handle ${runId}` },
      { type: "message", role: "assistant", content: answer },
    ],
    final_answer: answer,
    usage: { total_tokens: 100 },
  };
}

async function persist(
  identity: TestIdentity,
  projectId: Id<"projects">,
  value: JeevesClogRunExport,
): Promise<Id<"agentTraces">> {
  const result = await identity.action(api.agentTraces.persistTrace, {
    projectId,
    trace: asJson(normalizeJeevesClogRun(value)) as unknown as AgentRunTrace,
  });
  return result.agentTraceId;
}

async function seed() {
  const t = convexTest(schema);
  const ids = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Owner", email: "owner@test.com" });
    const guest1 = await ctx.db.insert("users", { name: "Guest 1", isAnonymous: true });
    const guest2 = await ctx.db.insert("users", { name: "Guest 2", isAnonymous: true });
    const orgId = await ctx.db.insert("organizations", {
      name: "Org",
      slug: "org",
      createdById: owner,
    });
    await ctx.db.insert("organizationMembers", {
      organizationId: orgId,
      userId: owner,
      role: "owner",
    });
    const projectId = await ctx.db.insert("projects", {
      organizationId: orgId,
      name: "Support quality",
      createdById: owner,
    });
    await ctx.db.insert("projectCollaborators", {
      projectId,
      userId: owner,
      role: "owner",
      invitedById: owner,
      invitedAt: Date.now(),
    });
    return { owner, guest1, guest2, projectId };
  });
  const identity = (userId: Id<"users">) => t.withIdentity({
    subject: `${userId}|session`,
    tokenIdentifier: `test|${userId}`,
  });
  return {
    t,
    ids,
    asOwner: identity(ids.owner),
    asGuest1: identity(ids.guest1),
    asGuest2: identity(ids.guest2),
  };
}

describe("verdict review campaigns", () => {
  test("creates one opaque no-account batch review and keeps reviewer decisions independent", async () => {
    const { t, ids, asOwner, asGuest1, asGuest2 } = await seed();
    const first = await persist(asOwner, ids.projectId, run("case-1", "First answer"));
    const second = await persist(asOwner, ids.projectId, run("case-2", "Second answer"));

    const campaignId = await asOwner.mutation(api.verdictReviewCampaigns.create, {
      projectId: ids.projectId,
      name: "Support run review",
      instructions: "Check correctness and policy compliance.",
      traceIds: [first, second],
    });
    const ownerView = await asOwner.query(api.verdictReviewCampaigns.getOwnerCampaign, {
      campaignId,
    });
    expect(ownerView).toMatchObject({
      name: "Support run review",
      status: "draft",
      itemCount: 2,
      instructions: "Check correctness and policy compliance.",
      results: { judgments: 0, reviewers: 0, reviewedRuns: 0 },
    });

    await asOwner.mutation(api.verdictReviewCampaigns.openCampaign, { campaignId });
    const firstSession = await asGuest1.mutation(api.verdictReviewCampaigns.joinCampaign, {
      shareToken: ownerView.shareToken,
      displayName: "Reviewer One",
    });
    const secondSession = await asGuest2.mutation(api.verdictReviewCampaigns.joinCampaign, {
      shareToken: ownerView.shareToken,
      displayName: "Reviewer Two",
    });
    expect(firstSession.sessionToken).not.toBe(secondSession.sessionToken);
    expect(firstSession.sessionToken).not.toBe(ownerView.shareToken);

    const reviewerState = await asGuest1.query(api.verdictReviewCampaigns.getReview, {
      sessionToken: firstSession.sessionToken,
    });
    expect(reviewerState).toMatchObject({
      title: "Blind run review",
      instructions: "Check correctness and policy compliance.",
      progress: { judged: 0, total: 2 },
      complete: false,
    });
    const serialized = JSON.stringify(reviewerState);
    expect(serialized).not.toContain(first);
    expect(serialized).not.toContain(second);
    expect(serialized).not.toContain("claude-sonnet");
    expect(serialized).not.toContain("pi_session_jsonl");
    expect(serialized).not.toContain(ids.projectId);

    const trace = await asGuest1.query(api.agentTraceReviewSessions.getTrace, {
      token: firstSession.sessionToken,
    });
    expect(trace).not.toHaveProperty("model");
    expect(trace).not.toHaveProperty("harnessName");
    await asGuest1.mutation(api.agentTraceReviewSessions.addComment, {
      token: firstSession.sessionToken,
      target: { kind: "step", stepIndex: 1 },
      comment: "The answer skips the refund rule.",
      label: "issue",
      tags: ["accuracy"],
    });
    await asGuest1.mutation(api.agentTraceReviewSessions.setVerdict, {
      token: firstSession.sessionToken,
      rating: "weak",
      note: "Policy miss.",
    });
    expect((await asGuest1.query(api.verdictReviewCampaigns.getReview, {
      sessionToken: firstSession.sessionToken,
    })).progress.judged).toBe(1);
    await asGuest1.mutation(api.agentTraceReviewSessions.setVerdict, {
      token: firstSession.sessionToken,
      rating: "acceptable",
    });

    await asGuest2.mutation(api.agentTraceReviewSessions.setVerdict, {
      token: secondSession.sessionToken,
      rating: "best",
      note: "Looks correct.",
    });
    await asGuest2.mutation(api.agentTraceReviewSessions.setVerdict, {
      token: secondSession.sessionToken,
      rating: "acceptable",
    });

    const results = await asOwner.query(api.verdictReviewCampaigns.getOwnerCampaign, {
      campaignId,
    });
    expect(results.results).toMatchObject({
      judgments: 4,
      reviewers: 2,
      reviewedRuns: 2,
      best: 1,
      acceptable: 2,
      weak: 1,
    });
    expect(results.results.disagreementRuns).toBeGreaterThan(0);
    expect(results.comments).toMatchObject([{
      reviewerName: "Reviewer One",
      comment: "The answer skips the refund rule.",
      target: { kind: "step", stepIndex: 1 },
    }]);

    const decisions = await t.run(async (ctx) =>
      ctx.db.query("verdictReviewDecisions").collect(),
    );
    expect(decisions).toHaveLength(4);
    expect(new Set(decisions.map((decision) => decision.userId)).size).toBe(2);
    expect(await t.run(async (ctx) =>
      ctx.db.query("projectCollaborators").withIndex("by_user", (q) =>
        q.eq("userId", ids.guest1),
      ).collect(),
    )).toEqual([]);
  });

  test("closed strong consensus becomes an SFT row and an idempotent regression case", async () => {
    const { ids, asOwner, asGuest1, asGuest2 } = await seed();
    const traceId = await persist(asOwner, ids.projectId, run("case-approved", "Approved answer"));
    const campaignId = await asOwner.mutation(api.verdictReviewCampaigns.create, {
      projectId: ids.projectId,
      name: "Approved run",
      traceIds: [traceId],
    });
    const ownerView = await asOwner.query(api.verdictReviewCampaigns.getOwnerCampaign, {
      campaignId,
    });
    await asOwner.mutation(api.verdictReviewCampaigns.openCampaign, { campaignId });
    for (const [identity, displayName] of [[asGuest1, "One"], [asGuest2, "Two"]] as const) {
      const { sessionToken } = await identity.mutation(api.verdictReviewCampaigns.joinCampaign, {
        shareToken: ownerView.shareToken,
        displayName,
      });
      await identity.mutation(api.agentTraceReviewSessions.setVerdict, {
        token: sessionToken,
        rating: "best",
      });
    }
    await asOwner.mutation(api.verdictReviewCampaigns.closeCampaign, { campaignId });

    const promoted = await asOwner.mutation(api.verdictReviewCampaigns.promoteAcceptedRuns, {
      campaignId,
    });
    expect(promoted).toEqual({ added: 1, alreadyPresent: 0, excluded: 0 });
    expect(await asOwner.mutation(api.verdictReviewCampaigns.promoteAcceptedRuns, {
      campaignId,
    })).toEqual({ added: 0, alreadyPresent: 1, excluded: 0 });

    const exported = await asOwner.action(api.exports.generateExport, {
      projectId: ids.projectId,
      verdictCampaignId: campaignId,
      source: "trajectory",
      format: "sft",
    });
    expect(exported).toMatchObject({ rowCount: 1, excludedCount: 0 });
    expect(exported.manifest).toMatchObject({
      format: "sft",
      source_units: 1,
      reviewers: 2,
    });
  });

  test("rejects owner self-review, closes submissions, and resumes a guest idempotently", async () => {
    const { ids, asOwner, asGuest1 } = await seed();
    const traceId = await persist(asOwner, ids.projectId, run("case-1", "Answer"));
    const campaignId = await asOwner.mutation(api.verdictReviewCampaigns.create, {
      projectId: ids.projectId,
      name: "Policy review",
      traceIds: [traceId],
    });
    const ownerView = await asOwner.query(api.verdictReviewCampaigns.getOwnerCampaign, {
      campaignId,
    });
    await asOwner.mutation(api.verdictReviewCampaigns.openCampaign, { campaignId });

    await expect(asOwner.mutation(api.verdictReviewCampaigns.joinCampaign, {
      shareToken: ownerView.shareToken,
      displayName: "Owner",
    })).rejects.toThrow(/guest window/i);

    const joined = await asGuest1.mutation(api.verdictReviewCampaigns.joinCampaign, {
      shareToken: ownerView.shareToken,
      displayName: "Guest",
    });
    const resumed = await asGuest1.mutation(api.verdictReviewCampaigns.joinCampaign, {
      shareToken: ownerView.shareToken,
      displayName: "Guest",
    });
    expect(resumed.sessionToken).toBe(joined.sessionToken);

    await asOwner.mutation(api.verdictReviewCampaigns.closeCampaign, { campaignId });
    await expect(asGuest1.mutation(api.agentTraceReviewSessions.setVerdict, {
      token: joined.sessionToken,
      rating: "acceptable",
    })).rejects.toThrow(/closed|expired/i);
  });
});
