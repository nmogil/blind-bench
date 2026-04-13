import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireAuth, requireProjectRole } from "./lib/auth";

const tagsValidator = v.optional(
  v.array(
    v.union(
      v.literal("accuracy"),
      v.literal("tone"),
      v.literal("length"),
      v.literal("relevance"),
      v.literal("safety"),
      v.literal("format"),
      v.literal("clarity"),
      v.literal("other"),
    ),
  ),
);

// ---------------------------------------------------------------------------
// Output Feedback
// ---------------------------------------------------------------------------

export const addOutputFeedback = mutation({
  args: {
    outputId: v.id("runOutputs"),
    annotationData: v.object({
      from: v.number(),
      to: v.number(),
      highlightedText: v.string(),
      comment: v.string(),
    }),
    tags: tagsValidator,
  },
  handler: async (ctx, args) => {
    const output = await ctx.db.get(args.outputId);
    if (!output) throw new Error("Output not found");

    const run = await ctx.db.get(output.runId);
    if (!run) throw new Error("Run not found");

    const { userId } = await requireProjectRole(ctx, run.projectId, [
      "owner",
      "editor",
      "evaluator",
    ]);

    return await ctx.db.insert("outputFeedback", {
      outputId: args.outputId,
      userId,
      annotationData: args.annotationData,
      tags: args.tags,
    });
  },
});

export const listOutputFeedback = query({
  args: { outputId: v.id("runOutputs") },
  handler: async (ctx, args) => {
    const output = await ctx.db.get(args.outputId);
    if (!output) return [];

    const run = await ctx.db.get(output.runId);
    if (!run) return [];

    const { userId } = await requireProjectRole(ctx, run.projectId, [
      "owner",
      "editor",
      "evaluator",
    ]);

    const feedback = await ctx.db
      .query("outputFeedback")
      .withIndex("by_output", (q) => q.eq("outputId", args.outputId))
      .take(200);

    const enriched = [];
    for (const fb of feedback) {
      const user = await ctx.db.get(fb.userId);
      enriched.push({
        ...fb,
        authorName: user?.name ?? null,
        isOwn: fb.userId === userId,
      });
    }
    return enriched;
  },
});

export const updateOutputFeedback = mutation({
  args: {
    feedbackId: v.id("outputFeedback"),
    comment: v.string(),
    tags: tagsValidator,
  },
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    const fb = await ctx.db.get(args.feedbackId);
    if (!fb) throw new Error("Feedback not found");
    if (fb.userId !== userId) throw new Error("Permission denied");

    const updates: Record<string, unknown> = {
      annotationData: { ...fb.annotationData, comment: args.comment },
    };
    if (args.tags !== undefined) updates.tags = args.tags;

    await ctx.db.patch(args.feedbackId, updates);
  },
});

export const deleteOutputFeedback = mutation({
  args: { feedbackId: v.id("outputFeedback") },
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    const fb = await ctx.db.get(args.feedbackId);
    if (!fb) throw new Error("Feedback not found");
    if (fb.userId !== userId) throw new Error("Permission denied");

    await ctx.db.delete(args.feedbackId);
  },
});

// ---------------------------------------------------------------------------
// Prompt Feedback
// ---------------------------------------------------------------------------

export const addPromptFeedback = mutation({
  args: {
    promptVersionId: v.id("promptVersions"),
    targetField: v.union(
      v.literal("system_message"),
      v.literal("user_message_template"),
    ),
    annotationData: v.object({
      from: v.number(),
      to: v.number(),
      highlightedText: v.string(),
      comment: v.string(),
    }),
    tags: tagsValidator,
  },
  handler: async (ctx, args) => {
    const version = await ctx.db.get(args.promptVersionId);
    if (!version) throw new Error("Version not found");

    const { userId } = await requireProjectRole(ctx, version.projectId, [
      "owner",
      "editor",
    ]);

    return await ctx.db.insert("promptFeedback", {
      promptVersionId: args.promptVersionId,
      userId,
      targetField: args.targetField,
      annotationData: args.annotationData,
      tags: args.tags,
    });
  },
});

export const listPromptFeedback = query({
  args: { promptVersionId: v.id("promptVersions") },
  handler: async (ctx, args) => {
    const version = await ctx.db.get(args.promptVersionId);
    if (!version) return [];

    const { userId } = await requireProjectRole(ctx, version.projectId, [
      "owner",
      "editor",
    ]);

    const feedback = await ctx.db
      .query("promptFeedback")
      .withIndex("by_version", (q) =>
        q.eq("promptVersionId", args.promptVersionId),
      )
      .take(200);

    const enriched = [];
    for (const fb of feedback) {
      const user = await ctx.db.get(fb.userId);
      enriched.push({
        ...fb,
        authorName: user?.name ?? null,
        isOwn: fb.userId === userId,
      });
    }
    return enriched;
  },
});

export const updatePromptFeedback = mutation({
  args: {
    feedbackId: v.id("promptFeedback"),
    comment: v.string(),
    tags: tagsValidator,
  },
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    const fb = await ctx.db.get(args.feedbackId);
    if (!fb) throw new Error("Feedback not found");
    if (fb.userId !== userId) throw new Error("Permission denied");

    const updates: Record<string, unknown> = {
      annotationData: { ...fb.annotationData, comment: args.comment },
    };
    if (args.tags !== undefined) updates.tags = args.tags;

    await ctx.db.patch(args.feedbackId, updates);
  },
});

export const deletePromptFeedback = mutation({
  args: { feedbackId: v.id("promptFeedback") },
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    const fb = await ctx.db.get(args.feedbackId);
    if (!fb) throw new Error("Feedback not found");
    if (fb.userId !== userId) throw new Error("Permission denied");

    await ctx.db.delete(args.feedbackId);
  },
});

// ---------------------------------------------------------------------------
// Evaluator-safe output feedback (via opaque token, no outputId exposed)
// ---------------------------------------------------------------------------

export const addOutputFeedbackByToken = mutation({
  args: {
    opaqueToken: v.string(),
    blindLabel: v.string(),
    annotationData: v.object({
      from: v.number(),
      to: v.number(),
      highlightedText: v.string(),
      comment: v.string(),
    }),
    tags: tagsValidator,
  },
  handler: async (ctx, args) => {
    // Resolve token
    const tokenDoc = await ctx.db
      .query("evalTokens")
      .withIndex("by_token", (q) => q.eq("token", args.opaqueToken))
      .unique();
    if (!tokenDoc) throw new Error("Invalid eval token");

    const { userId } = await requireProjectRole(ctx, tokenDoc.projectId, [
      "evaluator",
    ]);

    // Find the output by run + blind label
    const outputs = await ctx.db
      .query("runOutputs")
      .withIndex("by_run", (q) => q.eq("runId", tokenDoc.runId))
      .take(10);

    const output = outputs.find((o) => o.blindLabel === args.blindLabel);
    if (!output) throw new Error("Output not found");

    return await ctx.db.insert("outputFeedback", {
      outputId: output._id,
      userId,
      annotationData: args.annotationData,
      tags: args.tags,
    });
  },
});

// ---------------------------------------------------------------------------
// Tag distribution aggregation (M11)
// ---------------------------------------------------------------------------

export const getTagDistribution = query({
  args: { versionId: v.id("promptVersions") },
  handler: async (ctx, args) => {
    const version = await ctx.db.get(args.versionId);
    if (!version) return {};

    await requireProjectRole(ctx, version.projectId, ["owner", "editor"]);

    const counts: Record<string, number> = {};

    // Count from output feedback across all runs for this version
    const runs = await ctx.db
      .query("promptRuns")
      .withIndex("by_version", (q) =>
        q.eq("promptVersionId", args.versionId),
      )
      .take(200);

    for (const run of runs) {
      const outputs = await ctx.db
        .query("runOutputs")
        .withIndex("by_run", (q) => q.eq("runId", run._id))
        .take(10);
      for (const output of outputs) {
        const feedback = await ctx.db
          .query("outputFeedback")
          .withIndex("by_output", (q) => q.eq("outputId", output._id))
          .take(200);
        for (const fb of feedback) {
          if (fb.tags) {
            for (const tag of fb.tags) {
              counts[tag] = (counts[tag] ?? 0) + 1;
            }
          }
        }
      }
    }

    // Count from prompt feedback
    const promptFb = await ctx.db
      .query("promptFeedback")
      .withIndex("by_version", (q) =>
        q.eq("promptVersionId", args.versionId),
      )
      .take(200);

    for (const fb of promptFb) {
      if (fb.tags) {
        for (const tag of fb.tags) {
          counts[tag] = (counts[tag] ?? 0) + 1;
        }
      }
    }

    return counts;
  },
});
