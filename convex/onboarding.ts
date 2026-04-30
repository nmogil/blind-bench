import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireAuth, requireOrgRole } from "./lib/auth";
import { Id } from "./_generated/dataModel";

/**
 * Compute onboarding progress for the current user in an org.
 * All steps are derived from real data — no separate completion tracking.
 */
export const getProgress = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const { membership } = await requireOrgRole(ctx, args.orgId, [
      "owner",
      "admin",
      "member",
    ]);

    const [key, allProjects] = await Promise.all([
      ctx.db
        .query("openRouterKeys")
        .withIndex("by_org", (q) => q.eq("organizationId", args.orgId))
        .unique(),
      ctx.db
        .query("projects")
        .withIndex("by_org", (q) => q.eq("organizationId", args.orgId))
        .collect(),
    ]);

    // M28.1: sample projects don't count for activation — the user hasn't
    // actually done any of the work, just inspected pre-seeded data.
    const projects = allProjects.filter((p) => !p.isSample);

    const hasKey = key !== null;
    const hasProject = projects.length > 0;
    const firstProjectId: Id<"projects"> | null =
      projects[0]?._id ?? null;

    let hasTestCase = false;
    let hasRun = false;
    let hasCycle = false;
    let hasAcceptedOptimization = false;

    for (const project of projects) {
      if (!hasTestCase) {
        const tc = await ctx.db
          .query("testCases")
          .withIndex("by_project", (q) => q.eq("projectId", project._id))
          .first();
        if (tc) hasTestCase = true;
      }

      if (!hasRun) {
        const run = await ctx.db
          .query("promptRuns")
          .withIndex("by_project_and_status", (q) =>
            q.eq("projectId", project._id),
          )
          .first();
        if (run) hasRun = true;
      }

      if (!hasCycle) {
        const cycle = await ctx.db
          .query("reviewCycles")
          .withIndex("by_project", (q) => q.eq("projectId", project._id))
          .first();
        if (cycle) hasCycle = true;
      }

      if (!hasAcceptedOptimization) {
        const optimizations = await ctx.db
          .query("optimizationRequests")
          .withIndex("by_project_and_status", (q) =>
            q.eq("projectId", project._id),
          )
          .collect();
        if (optimizations.some((o) => o.reviewStatus === "accepted")) {
          hasAcceptedOptimization = true;
        }
      }

      if (
        hasTestCase &&
        hasRun &&
        hasCycle &&
        hasAcceptedOptimization
      ) {
        break;
      }
    }

    return {
      role: membership.role,
      hasKey,
      hasProject,
      hasTestCase,
      hasRun,
      hasCycle,
      hasAcceptedOptimization,
      firstProjectId,
    };
  },
});

/**
 * M28.3: Co-pilot panel progress. Five steps tied directly to user activity in
 * the current org — no progress table, all derived from real data. Sample
 * (auto-seeded) rows never count: the user has to do the action themselves.
 */
export const copilotProgress = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    const { membership } = await requireOrgRole(ctx, args.orgId, [
      "owner",
      "admin",
      "member",
    ]);

    const [user, key, allProjects] = await Promise.all([
      ctx.db.get(userId),
      ctx.db
        .query("openRouterKeys")
        .withIndex("by_org", (q) => q.eq("organizationId", args.orgId))
        .unique(),
      ctx.db
        .query("projects")
        .withIndex("by_org", (q) => q.eq("organizationId", args.orgId))
        .collect(),
    ]);

    const projects = allProjects.filter((p) => !p.isSample);
    const firstProjectId: Id<"projects"> | null = projects[0]?._id ?? null;

    const hasKey = key !== null;

    let hasNonSampleVersion = false;
    let hasCompletedRun = false;
    let hasAcceptedOptimization = false;

    // Track non-sample run output ids so we can scope outputFeedback membership
    // back to this org's surface area without scanning every annotation.
    const nonSampleVersionIds: Id<"promptVersions">[] = [];
    const nonSampleRunIds: Id<"promptRuns">[] = [];

    for (const project of projects) {
      const versions = await ctx.db
        .query("promptVersions")
        .withIndex("by_project", (q) => q.eq("projectId", project._id))
        .collect();
      for (const v of versions) {
        if (!v.isSample) {
          hasNonSampleVersion = true;
          nonSampleVersionIds.push(v._id);
        }
      }

      const runs = await ctx.db
        .query("promptRuns")
        .withIndex("by_project_and_status", (q) =>
          q.eq("projectId", project._id),
        )
        .collect();
      for (const r of runs) {
        if (r.isSample) continue;
        nonSampleRunIds.push(r._id);
        if (r.status === "completed") hasCompletedRun = true;
      }

      if (!hasAcceptedOptimization) {
        const optimizations = await ctx.db
          .query("optimizationRequests")
          .withIndex("by_project_and_status", (q) =>
            q.eq("projectId", project._id),
          )
          .collect();
        if (
          optimizations.some(
            (o) => !o.isSample && o.reviewStatus === "accepted",
          )
        ) {
          hasAcceptedOptimization = true;
        }
      }
    }

    // leave_feedback: any non-sample annotation authored by this user against
    // any surface in this org. Cheaper to walk the user's feedback rows and
    // filter than to walk every output. Includes both prompt-template feedback
    // (promptFeedback) and run-output feedback (outputFeedback).
    let hasFeedback = false;
    if (nonSampleVersionIds.length > 0) {
      const promptFeedback = await ctx.db
        .query("promptFeedback")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect();
      const versionIdSet = new Set(nonSampleVersionIds.map((id) => id as string));
      if (promptFeedback.some((f) => versionIdSet.has(f.promptVersionId as string))) {
        hasFeedback = true;
      }
    }
    if (!hasFeedback && nonSampleRunIds.length > 0) {
      const outputFeedback = await ctx.db
        .query("outputFeedback")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect();
      if (outputFeedback.length > 0) {
        const runIdSet = new Set(nonSampleRunIds.map((id) => id as string));
        for (const fb of outputFeedback) {
          if (fb.isSample) continue;
          const output = await ctx.db.get(fb.outputId);
          if (output && runIdSet.has(output.runId as string)) {
            hasFeedback = true;
            break;
          }
        }
      }
    }

    const steps = {
      add_key: hasKey,
      write_prompt: hasNonSampleVersion,
      run_eval: hasCompletedRun,
      leave_feedback: hasFeedback,
      accept_optimizer: hasAcceptedOptimization,
    };
    const order: (keyof typeof steps)[] = [
      "add_key",
      "write_prompt",
      "run_eval",
      "leave_feedback",
      "accept_optimizer",
    ];
    const doneCount = order.filter((id) => steps[id]).length;
    const isComplete = doneCount === order.length;

    // M28.7: surfacing the activation timestamp lets the co-pilot panel
    // (M28.8) flip from "guidance" mode to "suggestions" mode reactively.
    const firstActivationAt = user?.firstActivationAt;

    // M28.8: lightweight signals the panel uses to rank static suggestions.
    // Cheap counts only — no scans of feedback / runs / annotations here.
    const orgMembers = await ctx.db
      .query("organizationMembers")
      .withIndex("by_org", (q) => q.eq("organizationId", args.orgId))
      .collect();
    const orgMemberCount = orgMembers.length;

    return {
      role: membership.role,
      steps,
      doneCount,
      totalCount: order.length,
      isComplete,
      firstProjectId,
      firstActivationAt,
      orgMemberCount,
    };
  },
});
