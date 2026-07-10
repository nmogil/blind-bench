/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";

import { api, internal } from "../_generated/api";
import schema from "../schema";

function pairedCsvWithRows(count: number): string {
  return [
    "case_id,context,candidate_a,candidate_b,candidate_a_model,candidate_b_model,segment",
    ...Array.from({ length: count }, (_, index) =>
      `case-${index + 1},Context ${index + 1},Reply A ${index + 1},Reply B ${index + 1},gpt-4o,luna,segment-${index % 2}`,
    ),
  ].join("\n");
}

const pairedCsv = [
  "case_id,context,candidate_a,candidate_b,candidate_a_model,candidate_b_model,segment",
  "case-1,Customer asks to reschedule,What day works for you?,Choose a different day.,gpt-4o,luna,scheduling",
  "case-2,Customer asks to stop texts,I will opt you out now.,Okay.,gpt-4o,luna,opt-out",
].join("\n");

async function seed() {
  const t = convexTest(schema);
  const ids = await t.run(async (ctx) => {
    const ownerUserId = await ctx.db.insert("users", {
      name: "Owner",
      email: "owner@test.com",
    });
    const guestUserId = await ctx.db.insert("users", {
      name: "Guest",
      isAnonymous: true,
    });
    const orgId = await ctx.db.insert("organizations", {
      name: "Org",
      slug: "org",
      createdById: ownerUserId,
    });
    await ctx.db.insert("organizationMembers", {
      organizationId: orgId,
      userId: ownerUserId,
      role: "owner",
    });
    const projectId = await ctx.db.insert("projects", {
      organizationId: orgId,
      name: "Marcia SMS",
      createdById: ownerUserId,
    });
    await ctx.db.insert("projectCollaborators", {
      projectId,
      userId: ownerUserId,
      role: "owner",
      invitedById: ownerUserId,
      invitedAt: Date.now(),
    });
    return { ownerUserId, guestUserId, projectId };
  });
  return {
    t,
    ids,
    asOwner: t.withIdentity({
      subject: `${ids.ownerUserId}|owner-session`,
      tokenIdentifier: `test|${ids.ownerUserId}`,
    }),
    asGuest: t.withIdentity({
      subject: `${ids.guestUserId}|guest-session`,
      tokenIdentifier: `test|${ids.guestUserId}`,
    }),
  };
}

describe("blind comparison campaigns", () => {
  test("imports paired CSV into one campaign backed by comparable trajectories", async () => {
    const { asOwner, ids } = await seed();

    const imported = await asOwner.action(api.comparisonCampaigns.importPairedCsv, {
      projectId: ids.projectId,
      name: "4o vs Luna",
      csv: pairedCsv,
    });

    expect(imported).toMatchObject({
      importedCases: 2,
      deduped: false,
      summary: { rows: 2, valid: 2, invalid: 0 },
    });
    expect(JSON.stringify(imported.summary)).not.toContain("reschedule");

    const ownerView = await asOwner.query(api.comparisonCampaigns.getOwnerCampaign, {
      campaignId: imported.campaignId,
    });
    expect(ownerView).toMatchObject({
      name: "4o vs Luna",
      status: "draft",
      caseCount: 2,
      comparableCount: 2,
      invalidCount: 0,
    });
    expect(ownerView.candidates).toEqual([
      { model: "gpt-4o", harness: "paired_csv" },
      { model: "luna", harness: "paired_csv" },
    ]);

    const repeated = await asOwner.action(api.comparisonCampaigns.importPairedCsv, {
      projectId: ids.projectId,
      name: "4o vs Luna",
      csv: pairedCsv,
    });
    expect(repeated).toMatchObject({
      campaignId: imported.campaignId,
      importedCases: 0,
      deduped: true,
    });

    await expect(asOwner.action(api.comparisonCampaigns.importPairedCsv, {
      projectId: ids.projectId,
      name: "Incomplete",
      csv: "case_id,context,candidate_a,candidate_b\ncase-secret,Sensitive context,,Reply",
    })).rejects.toThrow(/1 invalid row.*fix every row/i);
  });

  test("redeems a share link for a user-bound opaque guest session", async () => {
    const { asOwner, asGuest, ids, t } = await seed();
    const imported = await asOwner.action(api.comparisonCampaigns.importPairedCsv, {
      projectId: ids.projectId,
      name: "4o vs Luna",
      csv: pairedCsv,
    });
    const ownerView = await asOwner.query(api.comparisonCampaigns.getOwnerCampaign, {
      campaignId: imported.campaignId,
    });
    await asOwner.mutation(api.comparisonCampaigns.openCampaign, {
      campaignId: imported.campaignId,
    });

    await expect(asGuest.mutation(api.comparisonCampaigns.joinCampaign, {
      shareToken: ownerView.shareToken,
      displayName: "   ",
    })).rejects.toThrow(/display name/i);
    const joined = await asGuest.mutation(api.comparisonCampaigns.joinCampaign, {
      shareToken: ownerView.shareToken,
      displayName: "Dan",
    });
    expect(joined.sessionToken).toMatch(/^[a-f0-9]{32}$/);
    expect(joined.sessionToken).not.toBe(ownerView.shareToken);
    await expect(asGuest.query(api.agentTraceReviewSessions.getMatchup, {
      token: joined.sessionToken,
    })).rejects.toThrow(/campaign review flow/i);

    const review = await asGuest.query(api.comparisonCampaigns.getReview, {
      sessionToken: joined.sessionToken,
    });
    expect(review).toMatchObject({
      title: "Blind comparison",
      status: "open",
      progress: { judged: 0, visible: 2, total: 2 },
      current: {
        firstLabel: "A",
        secondLabel: "B",
        comparable: true,
        divergenceStepIndex: 1,
      },
    });
    const serialized = JSON.stringify(review);
    expect(serialized).not.toContain("agentTraceId");
    expect(serialized).not.toContain("matchupId");
    expect(serialized).not.toContain("4o vs Luna");
    expect(serialized).not.toContain("Marcia SMS");
    expect(serialized).not.toContain("gpt-4o");
    expect(serialized).not.toContain("luna");
    expect(serialized).not.toContain(ids.projectId);

    const content = await asGuest.action(api.comparisonCampaigns.getCurrentContent, {
      sessionToken: joined.sessionToken,
    });
    expect(content.context).toContain("Customer asks to");
    expect(content.firstCandidate).not.toBe(content.secondCandidate);
    expect(content.firstCandidate.length).toBeGreaterThan(0);
    expect(content.secondCandidate.length).toBeGreaterThan(0);
    expect(JSON.stringify(content)).not.toContain("gpt-4o");

    const side = review.current?.firstSide;
    if (!side) throw new Error("Missing blind matchup side");
    await asGuest.mutation(api.agentTraceReviewSessions.addMatchupComment, {
      token: joined.sessionToken,
      side,
      target: { kind: "tool_call", stepIndex: 1 },
      comment: "This call used the wrong arguments.",
      label: "issue",
      tags: ["accuracy"],
    });
    const comments = await asGuest.query(api.agentTraceReviewSessions.listMatchupComments, {
      token: joined.sessionToken,
      side,
    });
    expect(comments).toMatchObject([{
      target: { kind: "tool_call", stepIndex: 1 },
      comment: "This call used the wrong arguments.",
      mine: true,
    }]);

    const collaborators = await t.run(async (ctx) =>
      ctx.db
        .query("projectCollaborators")
        .withIndex("by_project_and_user", (q) =>
          q.eq("projectId", ids.projectId).eq("userId", ids.guestUserId),
        )
        .collect(),
    );
    expect(collaborators).toEqual([]);

    const resumed = await asGuest.mutation(api.comparisonCampaigns.joinCampaign, {
      shareToken: ownerView.shareToken,
      displayName: "Dan",
    });
    expect(resumed.sessionToken).toBe(joined.sessionToken);
  });

  test("preserves anonymous campaign reviewers during orphan cleanup", async () => {
    const { asOwner, asGuest, ids, t } = await seed();
    const imported = await asOwner.action(api.comparisonCampaigns.importPairedCsv, {
      projectId: ids.projectId,
      name: "Cleanup protection",
      csv: pairedCsv,
    });
    const ownerView = await asOwner.query(api.comparisonCampaigns.getOwnerCampaign, {
      campaignId: imported.campaignId,
    });
    await asOwner.mutation(api.comparisonCampaigns.openCampaign, {
      campaignId: imported.campaignId,
    });
    await asGuest.mutation(api.comparisonCampaigns.joinCampaign, {
      shareToken: ownerView.shareToken,
      displayName: "Persistent guest",
    });

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 2 * 24 * 60 * 60 * 1_000);
    try {
      const cleanup = await t.mutation(internal.anonCleanup.cleanupAnonUsers, {});
      expect(cleanup.deleted).toBe(0);
      expect(await t.run(async (ctx) => ctx.db.get(ids.guestUserId))).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  test("saves five distinct choices idempotently and offers five more", async () => {
    const { asOwner, asGuest, ids, t } = await seed();
    const imported = await asOwner.action(api.comparisonCampaigns.importPairedCsv, {
      projectId: ids.projectId,
      name: "Six cases",
      csv: pairedCsvWithRows(6),
    });
    const ownerView = await asOwner.query(api.comparisonCampaigns.getOwnerCampaign, {
      campaignId: imported.campaignId,
    });
    await asOwner.mutation(api.comparisonCampaigns.openCampaign, {
      campaignId: imported.campaignId,
    });
    const { sessionToken } = await asGuest.mutation(api.comparisonCampaigns.joinCampaign, {
      shareToken: ownerView.shareToken,
      displayName: "Reviewer",
    });

    await expect(asGuest.mutation(api.agentTraceReviewSessions.decideMatchup, {
      token: sessionToken,
      winner: "left",
      reasonTags: [],
    })).rejects.toThrow(/campaign review flow/i);
    await expect(asGuest.mutation(api.comparisonCampaigns.extendBatch, {
      sessionToken,
    })).rejects.toThrow(/complete the current five/i);

    const choices = ["first", "second", "same", "neither", "cannot_judge"] as const;
    for (const choice of choices) {
      const current = await asGuest.query(api.comparisonCampaigns.getReview, { sessionToken });
      if (!current.current) throw new Error("Missing review item");
      await asGuest.mutation(api.comparisonCampaigns.submitChoice, {
        sessionToken,
        position: current.current.position,
        choice,
        note: choice === "neither" ? "Both miss the policy." : undefined,
      });
    }
    let review = await asGuest.query(api.comparisonCampaigns.getReview, { sessionToken });
    expect(review).toMatchObject({
      progress: { judged: 5, visible: 5, total: 6 },
      batchComplete: true,
      allComplete: false,
      current: null,
    });

    const decisions = await t.run(async (ctx) => ctx.db.query("agentTraceMatchupDecisions").collect());
    expect(decisions).toHaveLength(5);
    const winners = decisions.map((decision) => decision.winner);
    expect(winners.filter((winner) => winner === "left" || winner === "right")).toHaveLength(2);
    expect(winners).toEqual(expect.arrayContaining(["tie", "neither", "skip"]));
    expect(decisions.find((decision) => decision.winner === "neither")?.note)
      .toBe("Both miss the policy.");

    await asGuest.mutation(api.comparisonCampaigns.extendBatch, { sessionToken });
    review = await asGuest.query(api.comparisonCampaigns.getReview, { sessionToken });
    expect(review.progress).toEqual({ judged: 5, visible: 6, total: 6 });
    expect(review.current).not.toBeNull();

    if (!review.current) throw new Error("Missing extended review item");
    const finalPosition = review.current.position;
    await asGuest.mutation(api.comparisonCampaigns.submitChoice, {
      sessionToken,
      position: finalPosition,
      choice: "first",
    });
    await asGuest.mutation(api.comparisonCampaigns.submitChoice, {
      sessionToken,
      position: finalPosition,
      choice: "second",
    });
    review = await asGuest.query(api.comparisonCampaigns.getReview, { sessionToken });
    expect(review).toMatchObject({
      progress: { judged: 6, visible: 6, total: 6 },
      allComplete: true,
    });
    expect(await t.run(async (ctx) => (await ctx.db.query("agentTraceMatchupDecisions").collect()).length))
      .toBe(6);

    const results = await asOwner.query(api.comparisonCampaigns.getOwnerCampaign, {
      campaignId: imported.campaignId,
    });
    expect(results.results).toMatchObject({
      judgments: 6,
      reviewers: 1,
      same: 1,
      neither: 1,
      cannotJudge: 1,
    });
    expect(results.results.leftWins + results.results.rightWins).toBe(3);
    expect(results.results.agreementRate).toBeNull();
    expect(results.reviewerNames).toEqual(["Reviewer"]);
    expect(results.feedback).toMatchObject([{
      reviewerName: "Reviewer",
      outcome: "Neither acceptable",
      note: "Both miss the policy.",
    }]);
    expect(await asOwner.query(api.comparisonCampaigns.listCampaigns, {
      projectId: ids.projectId,
    })).toMatchObject([{
      id: imported.campaignId,
      caseCount: 6,
      judgments: 6,
    }]);

    await asOwner.mutation(api.comparisonCampaigns.closeCampaign, {
      campaignId: imported.campaignId,
    });
    const exported = await asOwner.action(api.exports.generateExport, {
      projectId: ids.projectId,
      campaignId: imported.campaignId,
      source: "trajectory",
      format: "dpo",
    });
    expect(exported).toMatchObject({ rowCount: 3, excludedCount: 3 });
    expect(exported.manifest).toMatchObject({
      format: "dpo",
      source_units: 6,
      reviewers: 1,
    });

    await expect(asGuest.mutation(api.comparisonCampaigns.submitChoice, {
      sessionToken,
      position: 5,
      choice: "first",
    })).rejects.toThrow(/closed/i);
    expect(await asGuest.action(api.comparisonCampaigns.getCurrentContent, {
      sessionToken,
    })).toEqual({ context: "", firstCandidate: "", secondCandidate: "" });
  });
});
