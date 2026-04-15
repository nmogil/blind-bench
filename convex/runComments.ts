import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireProjectRole } from "./lib/auth";

// ---------------------------------------------------------------------------
// Authenticated mutations (owner/editor/evaluator with direct access)
// ---------------------------------------------------------------------------

export const upsertComment = mutation({
  args: {
    runId: v.id("promptRuns"),
    comment: v.string(),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run) throw new Error("Run not found");

    const { userId } = await requireProjectRole(ctx, run.projectId, [
      "owner",
      "editor",
      "evaluator",
    ]);

    const existing = await ctx.db
      .query("runComments")
      .withIndex("by_run_user", (q) =>
        q.eq("runId", args.runId).eq("userId", userId),
      )
      .unique();

    // Empty string = delete
    if (args.comment === "") {
      if (existing) await ctx.db.delete(existing._id);
      return null;
    }

    if (existing) {
      await ctx.db.patch(existing._id, { comment: args.comment });
      return existing._id;
    }

    return await ctx.db.insert("runComments", {
      runId: args.runId,
      userId,
      comment: args.comment,
    });
  },
});

// ---------------------------------------------------------------------------
// Authenticated queries
// ---------------------------------------------------------------------------

export const getMyComment = query({
  args: { runId: v.id("promptRuns") },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run) return null;

    const { userId } = await requireProjectRole(ctx, run.projectId, [
      "owner",
      "editor",
      "evaluator",
    ]);

    const comment = await ctx.db
      .query("runComments")
      .withIndex("by_run_user", (q) =>
        q.eq("runId", args.runId).eq("userId", userId),
      )
      .unique();

    return comment ? { comment: comment.comment, createdAt: comment._creationTime } : null;
  },
});

export const listForRun = query({
  args: { runId: v.id("promptRuns") },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run) return [];

    const { userId, collaborator } = await requireProjectRole(ctx, run.projectId, [
      "owner",
      "editor",
      "evaluator",
    ]);

    const isEvaluator = collaborator.role === "evaluator";

    const comments = await ctx.db
      .query("runComments")
      .withIndex("by_run", (q) => q.eq("runId", args.runId))
      .take(100);

    // Evaluators see only their own comment
    const filtered = isEvaluator
      ? comments.filter((c) => c.userId === userId)
      : comments;

    const enriched = [];
    for (const c of filtered) {
      const user = await ctx.db.get(c.userId);
      enriched.push({
        _id: c._id,
        comment: c.comment,
        createdAt: c._creationTime,
        authorName: isEvaluator ? null : (user?.name ?? null),
        isOwn: c.userId === userId,
      });
    }

    return enriched;
  },
});

