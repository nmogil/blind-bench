import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireAuth } from "./lib/auth";
import { refreshEvalToken as refreshToken } from "./lib/evalTokens";

/**
 * List the evaluator's inbox — pending runs they can evaluate.
 * Returns ONLY safe fields: opaqueToken, projectName, completedAt, expiresAt.
 * NO runId, versionId, model, test case, or trigger user.
 */
export const listMyInbox = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireAuth(ctx);

    // Find all projects where user is evaluator
    const collabs = await ctx.db
      .query("projectCollaborators")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(200);

    const evalCollabs = collabs.filter((c) => c.role === "evaluator");
    if (evalCollabs.length === 0) return [];

    const items = [];
    for (const collab of evalCollabs) {
      const project = await ctx.db.get(collab.projectId);
      if (!project) continue;

      // Find eval tokens for this project's runs
      const runs = await ctx.db
        .query("promptRuns")
        .withIndex("by_project_and_status", (q) =>
          q.eq("projectId", collab.projectId).eq("status", "completed"),
        )
        .take(50);

      for (const run of runs) {
        const tokenDoc = await ctx.db
          .query("evalTokens")
          .withIndex("by_run", (q) => q.eq("runId", run._id))
          .unique();

        if (!tokenDoc) continue;

        // Count outputs
        const outputs = await ctx.db
          .query("runOutputs")
          .withIndex("by_run", (q) => q.eq("runId", run._id))
          .take(10);

        items.push({
          opaqueToken: tokenDoc.token,
          projectName: project.name,
          outputCount: outputs.length,
          completedAt: run.completedAt ?? run._creationTime,
          expiresAt: tokenDoc.expiresAt,
        });
      }
    }

    return items.sort((a, b) => b.completedAt - a.completedAt);
  },
});

/**
 * Refresh an expired eval token. Called by client before navigating to eval view.
 */
export const refreshEvalToken = mutation({
  args: { opaqueToken: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);

    // Find the token doc
    const tokenDoc = await ctx.db
      .query("evalTokens")
      .withIndex("by_token", (q) => q.eq("token", args.opaqueToken))
      .unique();
    if (!tokenDoc) throw new Error("Invalid eval token");

    // Verify caller is evaluator on this project
    const collab = await ctx.db
      .query("projectCollaborators")
      .withIndex("by_project_and_user", (q) =>
        q.eq("projectId", tokenDoc.projectId).eq("userId", userId),
      )
      .unique();
    if (!collab || collab.role !== "evaluator") {
      throw new Error("Permission denied");
    }

    // Refresh
    const newToken = await refreshToken(ctx, tokenDoc.runId);
    return newToken;
  },
});
