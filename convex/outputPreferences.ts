import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireProjectRole } from "./lib/auth";

const ratingValidator = v.union(
  v.literal("best"),
  v.literal("acceptable"),
  v.literal("weak"),
);

// ---------------------------------------------------------------------------
// Authenticated mutations (owner/editor/evaluator with direct access)
// ---------------------------------------------------------------------------

export const rateOutput = mutation({
  args: {
    outputId: v.id("runOutputs"),
    rating: ratingValidator,
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

    // Upsert: find existing rating for this user on this output
    const existing = await ctx.db
      .query("outputPreferences")
      .withIndex("by_output", (q) => q.eq("outputId", args.outputId))
      .filter((q) => q.eq(q.field("userId"), userId))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, { rating: args.rating });
      await ctx.scheduler.runAfter(0, internal.analyticsActions.track, {
        event: "output rated",
        distinctId: userId as string,
        properties: {
          run_id: output.runId as string,
          project_id: run.projectId as string,
          rating: args.rating,
          is_update: true,
        },
      });
      return existing._id;
    }

    const prefId = await ctx.db.insert("outputPreferences", {
      runId: output.runId,
      outputId: args.outputId,
      userId,
      rating: args.rating,
    });

    await ctx.scheduler.runAfter(0, internal.analyticsActions.track, {
      event: "output rated",
      distinctId: userId as string,
      properties: {
        run_id: output.runId as string,
        project_id: run.projectId as string,
        rating: args.rating,
        is_update: false,
      },
    });

    return prefId;
  },
});

export const clearRating = mutation({
  args: { outputId: v.id("runOutputs") },
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

    const existing = await ctx.db
      .query("outputPreferences")
      .withIndex("by_output", (q) => q.eq("outputId", args.outputId))
      .filter((q) => q.eq(q.field("userId"), userId))
      .unique();

    if (existing) {
      await ctx.db.delete(existing._id);
    }
  },
});

// ---------------------------------------------------------------------------
// Authenticated queries (owner/editor)
// ---------------------------------------------------------------------------

export const getMyRatingsForRun = query({
  args: { runId: v.id("promptRuns") },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run) return [];

    const { userId } = await requireProjectRole(ctx, run.projectId, [
      "owner",
      "editor",
      "evaluator",
    ]);

    const prefs = await ctx.db
      .query("outputPreferences")
      .withIndex("by_run_user", (q) =>
        q.eq("runId", args.runId).eq("userId", userId),
      )
      .take(20);

    return prefs.map((p) => ({
      outputId: p.outputId,
      rating: p.rating,
    }));
  },
});

export const aggregateForRun = query({
  args: { runId: v.id("promptRuns") },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run) return [];

    // Owner/editor only — evaluators must not see aggregate data
    await requireProjectRole(ctx, run.projectId, ["owner", "editor"]);

    const allPrefs = await ctx.db
      .query("outputPreferences")
      .withIndex("by_run", (q) => q.eq("runId", args.runId))
      .take(200);

    // Group by outputId
    const byOutput: Record<
      string,
      { bestCount: number; acceptableCount: number; weakCount: number }
    > = {};

    for (const pref of allPrefs) {
      const key = pref.outputId as string;
      if (!byOutput[key]) {
        byOutput[key] = { bestCount: 0, acceptableCount: 0, weakCount: 0 };
      }
      if (pref.rating === "best") byOutput[key]!.bestCount++;
      else if (pref.rating === "acceptable") byOutput[key]!.acceptableCount++;
      else if (pref.rating === "weak") byOutput[key]!.weakCount++;
    }

    return Object.entries(byOutput).map(([outputId, counts]) => ({
      outputId,
      ...counts,
    }));
  },
});

