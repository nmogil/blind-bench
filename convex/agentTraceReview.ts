/**
 * #267 (M31.4): step-level review of agent traces — comments anchored to a
 * step / tool call / whole trajectory, whole-trajectory verdicts, and
 * step-level pairwise preferences.
 *
 * Anchoring is by `stepIndex` (stable + identical for blind and owner). None of
 * these functions return trace provenance — they operate on reviewer-authored
 * data — so they inherit the blind posture without extra projection. Auth is
 * `requireProjectRole` including evaluators (reviewers are first-class here).
 */
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { isBlindReviewer, requireProjectRole } from "./lib/auth";
import { ensureMatchupSessionsForProjectReviewers } from "./lib/traceReviewSessions";

const LABEL = v.union(
  v.literal("suggestion"),
  v.literal("issue"),
  v.literal("praise"),
  v.literal("question"),
  v.literal("nitpick"),
  v.literal("thought"),
);
const TAG = v.union(
  v.literal("accuracy"),
  v.literal("tone"),
  v.literal("length"),
  v.literal("relevance"),
  v.literal("safety"),
  v.literal("format"),
  v.literal("clarity"),
  v.literal("other"),
);
const TARGET = v.union(
  v.object({ kind: v.literal("trace") }),
  v.object({ kind: v.literal("step"), stepIndex: v.number() }),
  v.object({ kind: v.literal("tool_call"), stepIndex: v.number() }),
);
const RATING = v.union(v.literal("best"), v.literal("acceptable"), v.literal("weak"));
const WINNER = v.union(
  v.literal("left"),
  v.literal("right"),
  v.literal("tie"),
  v.literal("neither"),
  v.literal("skip"),
);

const REVIEW_ROLES = ["owner", "editor", "evaluator"] as const;

async function traceForReview(
  ctx: Parameters<typeof requireProjectRole>[0],
  agentTraceId: Id<"agentTraces">,
) {
  const trace = await ctx.db.get(agentTraceId);
  if (!trace) throw new Error("Trace not found.");
  const { userId } = await requireProjectRole(ctx, trace.projectId, [...REVIEW_ROLES]);
  if (await isBlindReviewer(ctx, trace.projectId)) {
    throw new Error("Use an opaque review session for trajectory feedback.");
  }
  return { trace, userId };
}

// --- comments ----------------------------------------------------------------

export const addComment = mutation({
  args: {
    agentTraceId: v.id("agentTraces"),
    target: TARGET,
    comment: v.string(),
    label: LABEL,
    tags: v.optional(v.array(TAG)),
  },
  handler: async (ctx, args): Promise<Id<"agentTraceComments">> => {
    const { trace, userId } = await traceForReview(ctx, args.agentTraceId);
    const body = args.comment.trim();
    if (!body) throw new Error("Add a comment before saving.");
    if (args.target.kind !== "trace") {
      if (args.target.stepIndex < 0 || args.target.stepIndex >= trace.stepCount) {
        throw new Error("That step is not part of this trace.");
      }
    }
    return await ctx.db.insert("agentTraceComments", {
      agentTraceId: args.agentTraceId,
      projectId: trace.projectId,
      userId,
      target: args.target,
      comment: body,
      label: args.label,
      tags: args.tags,
    });
  },
});

export const deleteComment = mutation({
  args: { commentId: v.id("agentTraceComments") },
  handler: async (ctx, args) => {
    const comment = await ctx.db.get(args.commentId);
    if (!comment) return;
    // Authors delete their own; owners/editors can moderate any.
    const { userId, collaborator } = await requireProjectRole(ctx, comment.projectId, [...REVIEW_ROLES]);
    if (comment.userId !== userId && collaborator.role === "evaluator") {
      throw new Error("You can only delete your own comments.");
    }
    await ctx.db.delete(args.commentId);
  },
});

/**
 * All comments on a trace, anchored by stepIndex so they re-attach correctly
 * after pagination/re-render. Carries no trace provenance.
 */
export const listComments = query({
  args: { agentTraceId: v.id("agentTraces") },
  handler: async (ctx, args) => {
    const { userId } = await traceForReview(ctx, args.agentTraceId);
    const rows = await ctx.db
      .query("agentTraceComments")
      .withIndex("by_trace", (q) => q.eq("agentTraceId", args.agentTraceId))
      .collect();
    return rows.map((r) => ({
      _id: r._id,
      target: r.target,
      comment: r.comment,
      label: r.label,
      tags: r.tags ?? [],
      mine: r.userId === userId,
      createdAt: r._creationTime,
    }));
  },
});

// --- whole-trajectory verdict ------------------------------------------------

export const setVerdict = mutation({
  args: {
    agentTraceId: v.id("agentTraces"),
    rating: RATING,
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { trace, userId } = await traceForReview(ctx, args.agentTraceId);
    const existing = await ctx.db
      .query("agentTraceVerdicts")
      .withIndex("by_trace_and_user", (q) =>
        q.eq("agentTraceId", args.agentTraceId).eq("userId", userId),
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { rating: args.rating, note: args.note });
      return existing._id;
    }
    return await ctx.db.insert("agentTraceVerdicts", {
      agentTraceId: args.agentTraceId,
      projectId: trace.projectId,
      userId,
      rating: args.rating,
      note: args.note,
    });
  },
});

export const myVerdict = query({
  args: { agentTraceId: v.id("agentTraces") },
  handler: async (ctx, args) => {
    const { userId } = await traceForReview(ctx, args.agentTraceId);
    const row = await ctx.db
      .query("agentTraceVerdicts")
      .withIndex("by_trace_and_user", (q) =>
        q.eq("agentTraceId", args.agentTraceId).eq("userId", userId),
      )
      .unique();
    return row ? { rating: row.rating, note: row.note } : null;
  },
});

// --- step-level pairwise preference ------------------------------------------

/** Owner/editor sets up a pairwise between two traces at a divergence point. */
export const createMatchup = mutation({
  args: {
    leftTraceId: v.id("agentTraces"),
    rightTraceId: v.id("agentTraces"),
    divergenceStepIndex: v.number(),
    leftBlindLabel: v.string(),
    rightBlindLabel: v.string(),
    campaignId: v.optional(v.id("comparisonCampaigns")),
    caseKey: v.optional(v.string()),
    segment: v.optional(v.string()),
    sortOrder: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<Id<"agentTraceMatchups">> => {
    const left = await ctx.db.get(args.leftTraceId);
    const right = await ctx.db.get(args.rightTraceId);
    if (!left || !right) throw new Error("Both traces must exist.");
    if (left.projectId !== right.projectId) {
      throw new Error("Both traces must be in the same project.");
    }
    await requireProjectRole(ctx, left.projectId, ["owner", "editor"]);
    if (args.campaignId !== undefined) {
      const campaign = await ctx.db.get(args.campaignId);
      if (!campaign || campaign.projectId !== left.projectId) {
        throw new Error("Comparison campaign not found in this project.");
      }
      if (!args.caseKey?.trim()) {
        throw new Error("Campaign matchups require a case key.");
      }
    }
    if (!Number.isInteger(args.divergenceStepIndex) || args.divergenceStepIndex < 0) {
      throw new Error("Divergence step must be a non-negative integer.");
    }
    const [leftStep, rightStep] = await Promise.all([
      ctx.db
        .query("agentTraceSteps")
        .withIndex("by_trace_and_index", (q) =>
          q.eq("agentTraceId", args.leftTraceId).eq("stepIndex", args.divergenceStepIndex),
        )
        .unique(),
      ctx.db
        .query("agentTraceSteps")
        .withIndex("by_trace_and_index", (q) =>
          q.eq("agentTraceId", args.rightTraceId).eq("stepIndex", args.divergenceStepIndex),
        )
        .unique(),
    ]);
    if (!leftStep || !rightStep) {
      throw new Error("Both traces must contain the divergence step.");
    }
    const comparable = leftStep.prefixHash === rightStep.prefixHash;
    if (args.campaignId !== undefined && args.caseKey !== undefined) {
      const existing = await ctx.db
        .query("agentTraceMatchups")
        .withIndex("by_campaign_case", (q) =>
          q.eq("campaignId", args.campaignId).eq("caseKey", args.caseKey),
        )
        .unique();
      if (existing) return existing._id;
    }
    const matchupId = await ctx.db.insert("agentTraceMatchups", {
      projectId: left.projectId,
      leftTraceId: args.leftTraceId,
      rightTraceId: args.rightTraceId,
      campaignId: args.campaignId,
      caseKey: args.caseKey,
      segment: args.segment,
      sortOrder: args.sortOrder,
      divergenceStepIndex: args.divergenceStepIndex,
      leftBlindLabel: args.leftBlindLabel,
      rightBlindLabel: args.rightBlindLabel,
      prefixHash: comparable ? leftStep.prefixHash : undefined,
      comparabilityStatus: comparable ? "valid" : "invalid",
      invalidReason: comparable ? undefined : "prefix_mismatch",
    });
    if (comparable && args.campaignId === undefined) {
      await ensureMatchupSessionsForProjectReviewers(ctx, matchupId, left.projectId);
    }
    return matchupId;
  },
});

/** Reviewer records the better next action. */
export const decideMatchup = mutation({
  args: {
    matchupId: v.id("agentTraceMatchups"),
    winner: WINNER,
    reasonTags: v.array(TAG),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const matchup = await ctx.db.get(args.matchupId);
    if (!matchup) throw new Error("Matchup not found.");
    const { userId } = await requireProjectRole(ctx, matchup.projectId, [...REVIEW_ROLES]);
    if (await isBlindReviewer(ctx, matchup.projectId)) {
      throw new Error("Use an opaque review session for matchup decisions.");
    }
    if (matchup.comparabilityStatus !== "valid") {
      throw new Error("This matchup is not comparable because its prefixes differ.");
    }
    const existing = await ctx.db
      .query("agentTraceMatchupDecisions")
      .withIndex("by_matchup_and_user", (q) =>
        q.eq("matchupId", args.matchupId).eq("userId", userId),
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, {
        winner: args.winner,
        reasonTags: args.reasonTags,
        note: args.note,
        decidedAt: Date.now(),
      });
      return existing._id;
    }
    return await ctx.db.insert("agentTraceMatchupDecisions", {
      matchupId: args.matchupId,
      projectId: matchup.projectId,
      userId,
      winner: args.winner,
      reasonTags: args.reasonTags,
      note: args.note,
      decidedAt: Date.now(),
    });
  },
});

/**
 * A matchup for the reviewer: blind labels + the two opaque trace handles + the
 * divergence index. No provenance — the handles page steps through the
 * blind-projected listSteps.
 */
export const getMatchup = query({
  args: { matchupId: v.id("agentTraceMatchups") },
  handler: async (ctx, args) => {
    const matchup = await ctx.db.get(args.matchupId);
    if (!matchup) return null;
    const { userId } = await requireProjectRole(ctx, matchup.projectId, [...REVIEW_ROLES]);
    if (await isBlindReviewer(ctx, matchup.projectId)) {
      throw new Error("Use an opaque review session for matchup access.");
    }
    const project = await ctx.db.get(matchup.projectId);
    const decision = await ctx.db
      .query("agentTraceMatchupDecisions")
      .withIndex("by_matchup_and_user", (q) =>
        q.eq("matchupId", args.matchupId).eq("userId", userId),
      )
      .unique();
    return {
      _id: matchup._id,
      projectName: project?.name ?? "Project",
      leftTraceId: matchup.leftTraceId,
      rightTraceId: matchup.rightTraceId,
      divergenceStepIndex: matchup.divergenceStepIndex,
      leftBlindLabel: matchup.leftBlindLabel,
      rightBlindLabel: matchup.rightBlindLabel,
      comparable: matchup.comparabilityStatus === "valid",
      invalidReason: matchup.invalidReason,
      winner: decision?.winner ?? null,
      reasonTags: decision?.reasonTags ?? [],
    };
  },
});
