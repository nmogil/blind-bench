/** Token-authenticated, management-safe automation operations for verdict reviews. */
import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { generateToken } from "./lib/crypto";

const apiError = (status: 401 | 403 | 404 | 409, error: string) => ({ ok: false as const, status, error });

/** Create and open one campaign transactionally, replaying an idempotent request. */
export const createReview = internalMutation({
  args: {
    token: v.string(),
    name: v.string(),
    instructions: v.optional(v.string()),
    traceIds: v.array(v.string()),
    idempotencyKey: v.string(),
    fingerprint: v.string(),
  },
  handler: async (ctx, args) => {
    const tokenRow = await ctx.db
      .query("ingestTokens")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .unique();
    if (!tokenRow || tokenRow.revokedAt !== undefined) return apiError(401, "Invalid or revoked API token");
    if (!(tokenRow.scopes ?? []).includes("reviews:write")) return apiError(403, "Token lacks reviews:write scope");

    const existing = await ctx.db
      .query("verdictReviewCampaigns")
      .withIndex("by_project_and_idempotency", (q) =>
        q.eq("projectId", tokenRow.projectId).eq("idempotencyKey", args.idempotencyKey),
      )
      .unique();
    if (existing) {
      if (existing.idempotencyFingerprint !== args.fingerprint) {
        return apiError(409, "Idempotency key is already used by a different request");
      }
      await ctx.db.patch(tokenRow._id, { lastUsedAt: Date.now() });
      return {
        ok: true as const,
        reviewId: existing._id,
        status: existing.status,
        itemCount: existing.itemCount,
        shareToken: existing.shareToken,
      };
    }

    const traces: Array<Doc<"agentTraces">> = [];
    for (const stableTraceId of args.traceIds) {
      const trace = await ctx.db
        .query("agentTraces")
        .withIndex("by_trace_id", (q) => q.eq("traceId", stableTraceId))
        .filter((q) => q.eq(q.field("projectId"), tokenRow.projectId))
        .unique();
      if (!trace) return apiError(404, "Run not found in this project");
      if (trace.status !== "ready") return apiError(409, "Every selected run must be ready");
      traces.push(trace);
    }

    const now = Date.now();
    const shareToken = generateToken();
    const campaignId = await ctx.db.insert("verdictReviewCampaigns", {
      projectId: tokenRow.projectId,
      name: args.name,
      instructions: args.instructions,
      status: "open",
      shareToken,
      idempotencyKey: args.idempotencyKey,
      idempotencyFingerprint: args.fingerprint,
      itemCount: traces.length,
      judgmentCount: 0,
      createdById: tokenRow.createdById,
      createdAt: now,
      openedAt: now,
    });
    for (let sortOrder = 0; sortOrder < traces.length; sortOrder++) {
      const trace = traces[sortOrder];
      if (trace === undefined) continue;
      await ctx.db.insert("verdictReviewItems", {
        campaignId,
        projectId: tokenRow.projectId,
        agentTraceId: trace._id,
        sortOrder,
      });
    }
    await ctx.db.patch(tokenRow._id, { lastUsedAt: now });
    return { ok: true as const, reviewId: campaignId, status: "open" as const, itemCount: traces.length, shareToken };
  },
});

async function safeSummary(
  ctx: QueryCtx | MutationCtx,
  campaign: Doc<"verdictReviewCampaigns">,
) {
  const decisions = await ctx.db
    .query("verdictReviewDecisions")
    .withIndex("by_campaign", (q) => q.eq("campaignId", campaign._id))
    .collect();
  const ratingsByItem = new Map<string, Set<string>>();
  for (const decision of decisions) {
    const key = String(decision.itemId);
    const ratings = ratingsByItem.get(key) ?? new Set<string>();
    ratings.add(decision.rating);
    ratingsByItem.set(key, ratings);
  }
  return {
    review_id: campaign._id,
    status: campaign.status,
    item_count: campaign.itemCount,
    judgment_count: decisions.length,
    reviewed_item_count: ratingsByItem.size,
    aggregate: {
      best: decisions.filter((decision) => decision.rating === "best").length,
      acceptable: decisions.filter((decision) => decision.rating === "acceptable").length,
      weak: decisions.filter((decision) => decision.rating === "weak").length,
      disagreement: [...ratingsByItem.values()].filter((ratings) => ratings.size > 1).length,
    },
  };
}

/** Read a project-tenanted status projection with no reviewer or run provenance. */
export const getReview = internalMutation({
  args: { token: v.string(), reviewId: v.string() },
  handler: async (ctx, args) => {
    const tokenRow = await ctx.db.query("ingestTokens").withIndex("by_token", (q) => q.eq("token", args.token)).unique();
    if (!tokenRow || tokenRow.revokedAt !== undefined) return apiError(401, "Invalid or revoked API token");
    if (!(tokenRow.scopes ?? []).includes("reviews:read")) return apiError(403, "Token lacks reviews:read scope");
    const campaignId = ctx.db.normalizeId("verdictReviewCampaigns", args.reviewId);
    if (!campaignId) return apiError(404, "Review not found");
    const campaign = await ctx.db.get(campaignId);
    if (!campaign || campaign.projectId !== tokenRow.projectId) return apiError(404, "Review not found");
    await ctx.db.patch(tokenRow._id, { lastUsedAt: Date.now() });
    return { ok: true as const, summary: await safeSummary(ctx, campaign) };
  },
});

/** Idempotently close an open project-tenanted review and return its safe summary. */
export const closeReview = internalMutation({
  args: { token: v.string(), reviewId: v.string() },
  handler: async (ctx, args) => {
    const tokenRow = await ctx.db.query("ingestTokens").withIndex("by_token", (q) => q.eq("token", args.token)).unique();
    if (!tokenRow || tokenRow.revokedAt !== undefined) return apiError(401, "Invalid or revoked API token");
    if (!(tokenRow.scopes ?? []).includes("reviews:write")) return apiError(403, "Token lacks reviews:write scope");
    const campaignId = ctx.db.normalizeId("verdictReviewCampaigns", args.reviewId);
    if (!campaignId) return apiError(404, "Review not found");
    const campaign = await ctx.db.get(campaignId);
    if (!campaign || campaign.projectId !== tokenRow.projectId) return apiError(404, "Review not found");
    if (campaign.status === "draft") return apiError(409, "Review is not open");
    if (campaign.status === "open") {
      await ctx.db.patch(campaign._id, { status: "closed", closedAt: Date.now() });
    }
    await ctx.db.patch(tokenRow._id, { lastUsedAt: Date.now() });
    const current = campaign.status === "closed" ? campaign : { ...campaign, status: "closed" as const };
    return { ok: true as const, summary: await safeSummary(ctx, current) };
  },
});
