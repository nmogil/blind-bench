import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireAuth, requireOrgRole } from "./lib/auth";
import { Doc, Id } from "./_generated/dataModel";

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
 * M29.7: Co-pilot panel ambient steps. Tuned for the new welcome-screen
 * onboarding flow where the user lands in a real, mutable project from
 * minute zero — BYOK is inline at the run button, so add_key is gone, and
 * "leave_feedback" is replaced by the M29.6 collab nudge card.
 *
 * The four ambient steps:
 *
 *   1. write_prompt — project has a prompt with non-empty content
 *   2. run_eval — project has a completed run
 *   3. compare_model — user has executed a multi-model "mix" run (>=2
 *      distinct models in slotConfigs) so they've felt the comparison value
 *   4. promote_test_case — project has at least one saved test case (the
 *      welcome-paste path doesn't auto-create one; this nudges the user to
 *      promote inline variables to a reusable case)
 *
 * Steps are computed on the user's first owned project (firstProjectId);
 * once the user has multiple projects the panel switches to suggestions mode
 * via firstActivationAt.
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

    const [user, projects] = await Promise.all([
      ctx.db.get(userId),
      ctx.db
        .query("projects")
        .withIndex("by_org", (q) => q.eq("organizationId", args.orgId))
        .collect(),
    ]);

    const firstProjectId: Id<"projects"> | null = projects[0]?._id ?? null;

    let hasPromptContent = false;
    let hasCompletedRun = false;
    let hasMultiModelRun = false;
    let hasSavedTestCase = false;

    for (const project of projects) {
      if (!hasPromptContent) {
        const versions = await ctx.db
          .query("promptVersions")
          .withIndex("by_project", (q) => q.eq("projectId", project._id))
          .collect();
        if (versions.some((v) => versionHasContent(v))) {
          hasPromptContent = true;
        }
      }

      if (!hasCompletedRun || !hasMultiModelRun) {
        const runs = await ctx.db
          .query("promptRuns")
          .withIndex("by_project_and_status", (q) =>
            q.eq("projectId", project._id).eq("status", "completed"),
          )
          .collect();
        for (const r of runs) {
          hasCompletedRun = true;
          const slotModels = new Set(
            (r.slotConfigs ?? []).map((s) => s.model).filter(Boolean),
          );
          if (r.mode === "mix" && slotModels.size >= 2) {
            hasMultiModelRun = true;
          }
        }
      }

      if (!hasSavedTestCase) {
        const tc = await ctx.db
          .query("testCases")
          .withIndex("by_project", (q) => q.eq("projectId", project._id))
          .first();
        if (tc) hasSavedTestCase = true;
      }

      if (
        hasPromptContent &&
        hasCompletedRun &&
        hasMultiModelRun &&
        hasSavedTestCase
      ) {
        break;
      }
    }

    const steps = {
      write_prompt: hasPromptContent,
      run_eval: hasCompletedRun,
      compare_model: hasMultiModelRun,
      promote_test_case: hasSavedTestCase,
    };
    const order: (keyof typeof steps)[] = [
      "write_prompt",
      "run_eval",
      "compare_model",
      "promote_test_case",
    ];
    const doneCount = order.filter((id) => steps[id]).length;
    const isComplete = doneCount === order.length;

    const firstActivationAt = user?.firstActivationAt;

    // M28.8: lightweight signal the panel uses to rank static suggestions.
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

function versionHasContent(version: Doc<"promptVersions">): boolean {
  if (version.messages) {
    for (const m of version.messages) {
      const content = m.role === "assistant" ? (m.content ?? "") : m.content;
      if (content.trim().length > 0) return true;
    }
    return false;
  }
  return (
    (version.userMessageTemplate ?? "").trim().length > 0 ||
    (version.systemMessage ?? "").trim().length > 0
  );
}

const COLLAB_NUDGE_DISMISS_KEY = "copilot_collab_nudge";

/**
 * M29.6: "Get feedback — copy invite link" nudge gate. Surfaces only when:
 *
 *   1. The current user owns at least one project in the active org, and
 *   2. They have a successful run on it they triggered, and
 *   3. The project has no other reviewer collaborators yet, and
 *   4. The user hasn't dismissed the nudge.
 *
 * The product's value is *receiving feedback from a person* — playing alone
 * with the optimizer doesn't get you to the aha moment. We surface this the
 * moment the user has felt the loop work and not before.
 */
export const collabNudge = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    await requireOrgRole(ctx, args.orgId, ["owner", "admin", "member"]);

    const prefs = await ctx.db
      .query("userPreferences")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (prefs?.dismissedCallouts.includes(COLLAB_NUDGE_DISMISS_KEY)) {
      return { shouldShow: false as const };
    }

    const projects = await ctx.db
      .query("projects")
      .withIndex("by_org", (q) => q.eq("organizationId", args.orgId))
      .collect();

    // Find the user's first owned (collaborator role: owner) project that
    // has a completed run by them — if any.
    let chosen: Id<"projects"> | null = null;
    let chosenRunId: Id<"promptRuns"> | null = null;
    for (const project of projects) {
      const collab = await ctx.db
        .query("projectCollaborators")
        .withIndex("by_project_and_user", (q) =>
          q.eq("projectId", project._id).eq("userId", userId),
        )
        .unique();
      if (!collab || collab.role !== "owner") continue;

      const completed = await ctx.db
        .query("promptRuns")
        .withIndex("by_project_and_status", (q) =>
          q.eq("projectId", project._id).eq("status", "completed"),
        )
        .take(50);
      const mine = completed
        .filter((r) => r.triggeredById === userId)
        .sort((a, b) => a._creationTime - b._creationTime)[0];
      if (!mine) continue;

      chosen = project._id;
      chosenRunId = mine._id;
      break;
    }

    if (!chosen) return { shouldShow: false as const };

    // Bail if anyone else is already a collaborator (review is already
    // happening; the nudge would be noise).
    const collabs = await ctx.db
      .query("projectCollaborators")
      .withIndex("by_project", (q) => q.eq("projectId", chosen!))
      .take(50);
    const hasReviewer = collabs.some((c) => c.userId !== userId);
    if (hasReviewer) return { shouldShow: false as const };

    return {
      shouldShow: true as const,
      projectId: chosen,
      runId: chosenRunId,
      dismissKey: COLLAB_NUDGE_DISMISS_KEY,
    };
  },
});
