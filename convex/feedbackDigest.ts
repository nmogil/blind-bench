import { v } from "convex/values";
import {
  mutation,
  query,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { requireProjectRole } from "./lib/auth";

// ---------------------------------------------------------------------------
// Public mutations
// ---------------------------------------------------------------------------

export const requestDigest = mutation({
  args: { versionId: v.id("promptVersions") },
  handler: async (ctx, args) => {
    const version = await ctx.db.get(args.versionId);
    if (!version) throw new Error("Version not found");

    const { userId } = await requireProjectRole(ctx, version.projectId, [
      "owner",
      "editor",
    ]);

    // Enforce max 1 in-flight per version
    const pending = await ctx.db
      .query("feedbackDigests")
      .withIndex("by_project_and_status", (q) =>
        q.eq("projectId", version.projectId).eq("status", "pending"),
      )
      .take(1);
    const processing = await ctx.db
      .query("feedbackDigests")
      .withIndex("by_project_and_status", (q) =>
        q.eq("projectId", version.projectId).eq("status", "processing"),
      )
      .take(1);

    if (pending.length > 0 || processing.length > 0) {
      throw new Error("A digest is already being generated.");
    }

    const digestId = await ctx.db.insert("feedbackDigests", {
      projectId: version.projectId,
      promptVersionId: args.versionId,
      status: "pending",
      requestedById: userId,
    });

    await ctx.scheduler.runAfter(
      0,
      internal.feedbackDigestActions.generateDigestAction,
      { digestId },
    );

    return digestId;
  },
});

// ---------------------------------------------------------------------------
// Public queries
// ---------------------------------------------------------------------------

export const getDigest = query({
  args: { versionId: v.id("promptVersions") },
  handler: async (ctx, args) => {
    const version = await ctx.db.get(args.versionId);
    if (!version) return null;

    await requireProjectRole(ctx, version.projectId, ["owner", "editor"]);

    const digests = await ctx.db
      .query("feedbackDigests")
      .withIndex("by_version", (q) =>
        q.eq("promptVersionId", args.versionId),
      )
      .take(10);

    // Return the most recent
    return digests.sort(
      (a, b) => (b._creationTime ?? 0) - (a._creationTime ?? 0),
    )[0] ?? null;
  },
});

export const listDigests = query({
  args: { versionId: v.id("promptVersions") },
  handler: async (ctx, args) => {
    const version = await ctx.db.get(args.versionId);
    if (!version) return [];

    await requireProjectRole(ctx, version.projectId, ["owner", "editor"]);

    const digests = await ctx.db
      .query("feedbackDigests")
      .withIndex("by_version", (q) =>
        q.eq("promptVersionId", args.versionId),
      )
      .take(20);

    return digests.sort(
      (a, b) => (b._creationTime ?? 0) - (a._creationTime ?? 0),
    );
  },
});

// ---------------------------------------------------------------------------
// Internal mutations (called by the digest action)
// ---------------------------------------------------------------------------

export const updateDigestStatus = internalMutation({
  args: {
    digestId: v.id("feedbackDigests"),
    status: v.union(
      v.literal("processing"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const updates: Record<string, unknown> = { status: args.status };
    if (args.errorMessage !== undefined) updates.errorMessage = args.errorMessage;
    await ctx.db.patch(args.digestId, updates);
  },
});

export const completeDigest = internalMutation({
  args: {
    digestId: v.id("feedbackDigests"),
    summary: v.string(),
    themes: v.array(
      v.object({
        title: v.string(),
        severity: v.union(
          v.literal("high"),
          v.literal("medium"),
          v.literal("low"),
        ),
        description: v.string(),
        feedbackCount: v.number(),
      }),
    ),
    preferenceBreakdown: v.optional(
      v.object({
        totalRatings: v.number(),
        bestCount: v.number(),
        acceptableCount: v.number(),
        weakCount: v.number(),
      }),
    ),
    recommendations: v.array(v.string()),
    tagSummary: v.optional(v.record(v.string(), v.number())),
  },
  handler: async (ctx, args) => {
    const { digestId, ...fields } = args;
    await ctx.db.patch(digestId, {
      ...fields,
      status: "completed",
    });
  },
});

export const failDigest = internalMutation({
  args: {
    digestId: v.id("feedbackDigests"),
    errorMessage: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.digestId, {
      status: "failed",
      errorMessage: args.errorMessage,
    });
  },
});

// ---------------------------------------------------------------------------
// Internal query: gather all feedback for the digest
// ---------------------------------------------------------------------------

export const getDigestContext = internalQuery({
  args: { digestId: v.id("feedbackDigests") },
  handler: async (ctx, args) => {
    const digest = await ctx.db.get(args.digestId);
    if (!digest) throw new Error("Digest not found");

    const version = await ctx.db.get(digest.promptVersionId);
    if (!version) throw new Error("Version not found");

    const project = await ctx.db.get(digest.projectId);

    // Gather output feedback
    const runs = await ctx.db
      .query("promptRuns")
      .withIndex("by_version", (q) =>
        q.eq("promptVersionId", digest.promptVersionId),
      )
      .take(200);

    const outputFeedbackItems: Array<{
      blindLabel: string;
      highlightedText: string;
      comment: string;
      tags?: string[];
    }> = [];

    // Gather preferences
    let bestCount = 0;
    let acceptableCount = 0;
    let weakCount = 0;

    // Gather run comments
    const runCommentTexts: string[] = [];

    for (const run of runs) {
      const outputs = await ctx.db
        .query("runOutputs")
        .withIndex("by_run", (q) => q.eq("runId", run._id))
        .take(10);

      for (const output of outputs) {
        // Output feedback
        const feedback = await ctx.db
          .query("outputFeedback")
          .withIndex("by_output", (q) => q.eq("outputId", output._id))
          .take(200);
        for (const fb of feedback) {
          outputFeedbackItems.push({
            blindLabel: output.blindLabel,
            highlightedText: fb.annotationData.highlightedText,
            comment: fb.annotationData.comment,
            tags: fb.tags ?? undefined,
          });
        }

        // Preferences
        const prefs = await ctx.db
          .query("outputPreferences")
          .withIndex("by_output", (q) => q.eq("outputId", output._id))
          .take(200);
        for (const p of prefs) {
          if (p.rating === "best") bestCount++;
          else if (p.rating === "acceptable") acceptableCount++;
          else if (p.rating === "weak") weakCount++;
        }
      }

      // Run comments
      const comments = await ctx.db
        .query("runComments")
        .withIndex("by_run", (q) => q.eq("runId", run._id))
        .take(100);
      for (const c of comments) {
        runCommentTexts.push(c.comment);
      }
    }

    // Prompt feedback
    const promptFeedbackItems: Array<{
      targetField: string;
      highlightedText: string;
      comment: string;
      tags?: string[];
    }> = [];

    const promptFb = await ctx.db
      .query("promptFeedback")
      .withIndex("by_version", (q) =>
        q.eq("promptVersionId", digest.promptVersionId),
      )
      .take(200);

    for (const fb of promptFb) {
      promptFeedbackItems.push({
        targetField: fb.targetField ?? "message",
        highlightedText: fb.annotationData.highlightedText,
        comment: fb.annotationData.comment,
        tags: fb.tags ?? undefined,
      });
    }

    const totalRatings = bestCount + acceptableCount + weakCount;

    return {
      projectName: project?.name ?? "Unknown",
      versionNumber: version.versionNumber,
      outputFeedback: outputFeedbackItems,
      promptFeedback: promptFeedbackItems,
      runComments: runCommentTexts,
      preferences: totalRatings > 0
        ? { totalRatings, bestCount, acceptableCount, weakCount }
        : null,
      organizationId: project?.organizationId,
    };
  },
});
