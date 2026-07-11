/** No-account blind verdict campaigns over one or more imported runs. */
import { v } from "convex/values";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireAuth, requireProjectRole } from "./lib/auth";
import { generateToken } from "./lib/crypto";
import { fisherYatesShuffle } from "./lib/shuffle";

const MAX_ITEMS = 50;
type ReadCtx = QueryCtx | MutationCtx;

/** Resolve a user-bound verdict campaign session and enforce its lifecycle. */
export async function resolveVerdictCampaignSession(
  ctx: ReadCtx,
  token: string,
  options: { readonly requireOpen: boolean },
): Promise<{
  readonly userId: Id<"users">;
  readonly session: Doc<"agentTraceReviewSessions">;
  readonly campaign: Doc<"verdictReviewCampaigns">;
}> {
  const userId = await requireAuth(ctx);
  const session = await ctx.db
    .query("agentTraceReviewSessions")
    .withIndex("by_token", (q) => q.eq("token", token))
    .unique();
  if (
    !session ||
    session.reviewerUserId !== userId ||
    session.kind !== "verdict_campaign" ||
    session.verdictCampaignId === undefined
  ) {
    throw new Error("Review session not found or expired.");
  }
  const campaign = await ctx.db.get(session.verdictCampaignId);
  if (!campaign || campaign.projectId !== session.projectId) {
    throw new Error("Review session not found or expired.");
  }
  if (options.requireOpen && campaign.status !== "open") {
    throw new Error("This review is closed.");
  }
  return { userId, session, campaign };
}

/** Return the active trace and item without exposing either identifier to clients. */
export async function activeVerdictReviewItem(
  ctx: ReadCtx,
  session: Doc<"agentTraceReviewSessions">,
): Promise<{
  readonly trace: Doc<"agentTraces">;
  readonly item: Doc<"verdictReviewItems">;
} | null> {
  if (session.kind !== "verdict_campaign" || session.verdictCampaignId === undefined) {
    return null;
  }
  const campaignId = session.verdictCampaignId;
  const order = session.traceOrder ?? [];
  const index = session.currentIndex ?? 0;
  const traceId = order[index];
  if (traceId === undefined) return null;
  const [trace, item] = await Promise.all([
    ctx.db.get(traceId),
    ctx.db
      .query("verdictReviewItems")
      .withIndex("by_campaign_and_trace", (q) =>
        q.eq("campaignId", campaignId).eq("agentTraceId", traceId),
      )
      .unique(),
  ]);
  if (!trace || !item || trace.projectId !== session.projectId) {
    throw new Error("Review run is no longer available.");
  }
  return { trace, item };
}

/** Create a draft verdict review over up to fifty ready runs. */
export const create = mutation({
  args: {
    projectId: v.id("projects"),
    name: v.string(),
    instructions: v.optional(v.string()),
    traceIds: v.array(v.id("agentTraces")),
  },
  handler: async (ctx, args): Promise<Id<"verdictReviewCampaigns">> => {
    const { userId } = await requireProjectRole(ctx, args.projectId, ["owner", "editor"]);
    const name = args.name.trim();
    if (!name) throw new Error("Add a review name.");
    const seenTraceIds = new Set<string>();
    const traceIds = args.traceIds.filter((traceId) => {
      const key = String(traceId);
      if (seenTraceIds.has(key)) return false;
      seenTraceIds.add(key);
      return true;
    });
    if (traceIds.length === 0) throw new Error("Select at least one run to review.");
    if (traceIds.length > MAX_ITEMS) {
      throw new Error(`Select at most ${MAX_ITEMS} runs per review.`);
    }
    for (const traceId of traceIds) {
      const trace = await ctx.db.get(traceId);
      if (!trace || trace.projectId !== args.projectId || trace.status !== "ready") {
        throw new Error("Every selected run must be ready and belong to this project.");
      }
    }
    const instructions = args.instructions?.trim().slice(0, 2_000) || undefined;
    const campaignId = await ctx.db.insert("verdictReviewCampaigns", {
      projectId: args.projectId,
      name: name.slice(0, 120),
      instructions,
      status: "draft",
      shareToken: generateToken(),
      itemCount: traceIds.length,
      judgmentCount: 0,
      createdById: userId,
      createdAt: Date.now(),
    });
    for (let sortOrder = 0; sortOrder < traceIds.length; sortOrder++) {
      const agentTraceId = traceIds[sortOrder];
      if (agentTraceId === undefined) continue;
      await ctx.db.insert("verdictReviewItems", {
        campaignId,
        projectId: args.projectId,
        agentTraceId,
        sortOrder,
      });
    }
    return campaignId;
  },
});

/** List verdict reviews for the unified owner Reviews/Results surfaces. */
export const listCampaigns = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    await requireProjectRole(ctx, args.projectId, ["owner", "editor"]);
    const campaigns = await ctx.db
      .query("verdictReviewCampaigns")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .order("desc")
      .take(100);
    return await Promise.all(
      campaigns.map(async (campaign) => {
        const decisions = await ctx.db
          .query("verdictReviewDecisions")
          .withIndex("by_campaign", (q) => q.eq("campaignId", campaign._id))
          .collect();
        return {
          id: campaign._id,
          mode: "verdict" as const,
          name: campaign.name,
          status: campaign.status,
          itemCount: campaign.itemCount,
          reviewedRuns: new Set(decisions.map((decision) => String(decision.itemId))).size,
          reviewers: new Set(decisions.map((decision) => String(decision.userId))).size,
          judgments: decisions.length,
          createdAt: campaign.createdAt,
        };
      }),
    );
  },
});

/** Owner/editor campaign summary with reviewer identity and source provenance. */
export const getOwnerCampaign = query({
  args: { campaignId: v.id("verdictReviewCampaigns") },
  handler: async (ctx, args) => {
    const campaign = await ctx.db.get(args.campaignId);
    if (!campaign) throw new Error("Review not found.");
    await requireProjectRole(ctx, campaign.projectId, ["owner", "editor"]);
    const [items, decisions, sessions, regressionCases] = await Promise.all([
      ctx.db
        .query("verdictReviewItems")
        .withIndex("by_campaign", (q) => q.eq("campaignId", campaign._id))
        .collect(),
      ctx.db
        .query("verdictReviewDecisions")
        .withIndex("by_campaign", (q) => q.eq("campaignId", campaign._id))
        .collect(),
      ctx.db
        .query("agentTraceReviewSessions")
        .withIndex("by_verdict_campaign_and_reviewer", (q) =>
          q.eq("verdictCampaignId", campaign._id),
        )
        .collect(),
      ctx.db
        .query("regressionCases")
        .withIndex("by_campaign", (q) => q.eq("verdictCampaignId", campaign._id))
        .collect(),
    ]);
    const displayNameByUser = new Map(
      sessions.map((session) => [String(session.reviewerUserId), session.reviewerDisplayName]),
    );
    const reviewerIds = new Set(decisions.map((decision) => String(decision.userId)));
    const reviewerNameById = new Map<string, string>();
    for (const reviewerId of reviewerIds) {
      const id = decisions.find((decision) => String(decision.userId) === reviewerId)?.userId;
      if (id === undefined) continue;
      const user = await ctx.db.get(id);
      reviewerNameById.set(
        reviewerId,
        displayNameByUser.get(reviewerId)?.trim() || user?.name?.trim() || "Guest reviewer",
      );
    }

    const decisionsByItem = new Map<string, Array<Doc<"verdictReviewDecisions">>>();
    for (const decision of decisions) {
      const key = String(decision.itemId);
      const rows = decisionsByItem.get(key) ?? [];
      rows.push(decision);
      decisionsByItem.set(key, rows);
    }
    let disagreementRuns = 0;
    for (const rows of decisionsByItem.values()) {
      if (new Set(rows.map((row) => row.rating)).size > 1) disagreementRuns++;
    }
    const runs: Array<{
      readonly traceId: Id<"agentTraces">;
      readonly product: string;
      readonly harness: string;
      readonly model?: string;
      readonly judgments: number;
    }> = [];
    for (const item of items) {
      const trace = await ctx.db.get(item.agentTraceId);
      if (!trace) continue;
      runs.push({
        traceId: trace._id,
        product: trace.product,
        harness: trace.harnessName,
        model: trace.model,
        judgments: decisionsByItem.get(String(item._id))?.length ?? 0,
      });
    }

    const comments: Array<{
      readonly reviewerName: string;
      readonly comment: string;
      readonly target: Doc<"agentTraceComments">["target"];
      readonly traceId: Id<"agentTraces">;
    }> = [];
    for (const item of items) {
      const rows = await ctx.db
        .query("agentTraceComments")
        .withIndex("by_trace", (q) => q.eq("agentTraceId", item.agentTraceId))
        .collect();
      for (const row of rows) {
        if (row.verdictCampaignId !== campaign._id) continue;
        comments.push({
          reviewerName: reviewerNameById.get(String(row.userId)) ?? "Guest reviewer",
          comment: row.comment,
          target: row.target,
          traceId: row.agentTraceId,
        });
      }
    }

    return {
      id: campaign._id,
      projectId: campaign.projectId,
      name: campaign.name,
      instructions: campaign.instructions,
      status: campaign.status,
      shareToken: campaign.shareToken,
      itemCount: items.length,
      reviewerNames: [...reviewerNameById.values()].sort((left, right) =>
        left.localeCompare(right),
      ),
      regressionCount: regressionCases.length,
      runs,
      comments,
      results: {
        judgments: decisions.length,
        reviewers: reviewerIds.size,
        reviewedRuns: decisionsByItem.size,
        best: decisions.filter((decision) => decision.rating === "best").length,
        acceptable: decisions.filter((decision) => decision.rating === "acceptable").length,
        weak: decisions.filter((decision) => decision.rating === "weak").length,
        insufficientEvidence: decisions.filter(
          (decision) => decision.rating === "insufficient_evidence",
        ).length,
        disagreementRuns,
      },
    };
  },
});

/** Open a draft verdict review and return its share token. */
export const openCampaign = mutation({
  args: { campaignId: v.id("verdictReviewCampaigns") },
  handler: async (ctx, args) => {
    const campaign = await ctx.db.get(args.campaignId);
    if (!campaign) throw new Error("Review not found.");
    await requireProjectRole(ctx, campaign.projectId, ["owner", "editor"]);
    if (campaign.status !== "draft" && campaign.status !== "open") {
      throw new Error("Only a draft review can be opened.");
    }
    if (campaign.status === "draft") {
      await ctx.db.patch(campaign._id, { status: "open", openedAt: Date.now() });
    }
    return { shareToken: campaign.shareToken };
  },
});

/** Close a verdict review while preserving every submitted judgment. */
export const closeCampaign = mutation({
  args: { campaignId: v.id("verdictReviewCampaigns") },
  handler: async (ctx, args) => {
    const campaign = await ctx.db.get(args.campaignId);
    if (!campaign) throw new Error("Review not found.");
    await requireProjectRole(ctx, campaign.projectId, ["owner", "editor"]);
    if (campaign.status !== "open" && campaign.status !== "closed") {
      throw new Error("Only an open review can be closed.");
    }
    if (campaign.status === "open") {
      await ctx.db.patch(campaign._id, { status: "closed", closedAt: Date.now() });
    }
    return { closed: true };
  },
});

/** Promote majority-approved runs from a closed review into the regression corpus. */
export const promoteAcceptedRuns = mutation({
  args: { campaignId: v.id("verdictReviewCampaigns") },
  handler: async (ctx, args) => {
    const campaign = await ctx.db.get(args.campaignId);
    if (!campaign) throw new Error("Review not found.");
    const { userId } = await requireProjectRole(ctx, campaign.projectId, [
      "owner",
      "editor",
    ]);
    if (campaign.status !== "closed") {
      throw new Error("Close the review before promoting regression cases.");
    }
    const items = await ctx.db
      .query("verdictReviewItems")
      .withIndex("by_campaign", (q) => q.eq("campaignId", campaign._id))
      .collect();
    let added = 0;
    let alreadyPresent = 0;
    let excluded = 0;
    for (const item of items) {
      const decisions = await ctx.db
        .query("verdictReviewDecisions")
        .withIndex("by_item", (q) => q.eq("itemId", item._id))
        .collect();
      const approved = decisions.filter(
        (decision) => decision.rating === "best" || decision.rating === "acceptable",
      ).length;
      const weak = decisions.filter((decision) => decision.rating === "weak").length;
      if (decisions.length === 0 || approved <= weak) {
        excluded++;
        continue;
      }
      const existing = await ctx.db
        .query("regressionCases")
        .withIndex("by_project_and_trace", (q) =>
          q.eq("projectId", campaign.projectId).eq("agentTraceId", item.agentTraceId),
        )
        .unique();
      if (existing) {
        alreadyPresent++;
        continue;
      }
      await ctx.db.insert("regressionCases", {
        projectId: campaign.projectId,
        agentTraceId: item.agentTraceId,
        verdictCampaignId: campaign._id,
        createdById: userId,
        createdAt: Date.now(),
      });
      added++;
    }
    return { added, alreadyPresent, excluded };
  },
});

/** Redeem a public share token for one stable, reviewer-bound opaque session. */
export const joinCampaign = mutation({
  args: { shareToken: v.string(), displayName: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    const campaign = await ctx.db
      .query("verdictReviewCampaigns")
      .withIndex("by_share_token", (q) => q.eq("shareToken", args.shareToken))
      .unique();
    if (!campaign || campaign.status !== "open") {
      throw new Error("This review is not open.");
    }
    const collaborator = await ctx.db
      .query("projectCollaborators")
      .withIndex("by_project_and_user", (q) =>
        q.eq("projectId", campaign.projectId).eq("userId", userId),
      )
      .unique();
    if (collaborator?.role === "owner" || collaborator?.role === "editor") {
      throw new Error("Open this review link in a guest window to preserve blinding.");
    }
    const displayName = args.displayName.trim().slice(0, 80);
    if (!displayName) throw new Error("Add your display name before starting.");
    const existing = await ctx.db
      .query("agentTraceReviewSessions")
      .withIndex("by_verdict_campaign_and_reviewer", (q) =>
        q.eq("verdictCampaignId", campaign._id).eq("reviewerUserId", userId),
      )
      .unique();
    if (existing) {
      if (existing.reviewerDisplayName !== displayName) {
        await ctx.db.patch(existing._id, { reviewerDisplayName: displayName });
      }
      return { sessionToken: existing.token };
    }
    const items = await ctx.db
      .query("verdictReviewItems")
      .withIndex("by_campaign", (q) => q.eq("campaignId", campaign._id))
      .collect();
    if (items.length === 0) throw new Error("This review has no runs.");
    const token = generateToken();
    await ctx.db.insert("agentTraceReviewSessions", {
      projectId: campaign.projectId,
      reviewerUserId: userId,
      token,
      kind: "verdict_campaign",
      verdictCampaignId: campaign._id,
      reviewerDisplayName: displayName,
      traceOrder: fisherYatesShuffle(items).map((item) => item.agentTraceId),
      currentIndex: 0,
      visibleCount: items.length,
    });
    return { sessionToken: token };
  },
});

/** Reviewer-safe campaign progress; run and project identifiers never cross the wire. */
export const getReview = query({
  args: { sessionToken: v.string() },
  handler: async (ctx, args) => {
    const { userId, session, campaign } = await resolveVerdictCampaignSession(
      ctx,
      args.sessionToken,
      { requireOpen: false },
    );
    const decisions = await ctx.db
      .query("verdictReviewDecisions")
      .withIndex("by_campaign_and_user", (q) =>
        q.eq("campaignId", campaign._id).eq("userId", userId),
      )
      .collect();
    const total = session.traceOrder?.length ?? campaign.itemCount;
    return {
      title: "Blind run review",
      instructions: campaign.instructions,
      status: campaign.status,
      progress: { judged: decisions.length, total },
      complete: decisions.length >= total || session.completedAt !== undefined,
    };
  },
});
