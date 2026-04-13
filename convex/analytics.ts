import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireProjectRole } from "./lib/auth";

export const getQualityTrend = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    await requireProjectRole(ctx, args.projectId, ["owner", "editor"]);

    const versions = await ctx.db
      .query("promptVersions")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .take(20);

    const sorted = versions.sort((a, b) => a.versionNumber - b.versionNumber);

    const dataPoints = [];

    for (const version of sorted) {
      // Count feedback
      let outputFeedbackCount = 0;
      let bestCount = 0;
      let acceptableCount = 0;
      let weakCount = 0;
      const tagCounts: Record<string, number> = {};

      const runs = await ctx.db
        .query("promptRuns")
        .withIndex("by_version", (q) =>
          q.eq("promptVersionId", version._id),
        )
        .take(200);

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
          outputFeedbackCount += feedback.length;

          for (const fb of feedback) {
            if (fb.tags) {
              for (const tag of fb.tags) {
                tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
              }
            }
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
      }

      // Count prompt feedback
      const promptFb = await ctx.db
        .query("promptFeedback")
        .withIndex("by_version", (q) =>
          q.eq("promptVersionId", version._id),
        )
        .take(200);

      for (const fb of promptFb) {
        if (fb.tags) {
          for (const tag of fb.tags) {
            tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
          }
        }
      }

      const totalFeedback = outputFeedbackCount + promptFb.length;
      const totalRatings = bestCount + acceptableCount + weakCount;

      // Preference score: best=1.0, acceptable=0.5, weak=0.0
      const preferenceScore = totalRatings > 0
        ? (bestCount * 1.0 + acceptableCount * 0.5 + weakCount * 0.0) / totalRatings
        : null;

      dataPoints.push({
        versionId: version._id as string,
        versionNumber: version.versionNumber,
        feedbackCount: totalFeedback,
        totalRatings,
        preferenceScore,
        tagDistribution: Object.keys(tagCounts).length > 0 ? tagCounts : null,
      });
    }

    return dataPoints;
  },
});
