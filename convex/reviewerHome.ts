/**
 * M26: Reviewer dashboard backend.
 *
 * Powers the simplified `/review/:projectId` home for non-blind reviewers
 * (PMs, legal, domain experts). Surfaces only the bare minimum to do the job:
 * project header, current draft preview, runs awaiting their feedback, and
 * versions awaiting their feedback. No version numbers, model strings, or
 * temperatures — those are stripped at the API boundary, not just hidden in
 * the UI.
 *
 * Access policy:
 *   - owner / editor       → allowed (helpful for QA / "what does the
 *                            reviewer see")
 *   - evaluator !blindMode → allowed (the primary persona)
 *   - evaluator  blindMode → null (they have the blind session inbox)
 *   - non-collaborator     → null (so the route can render a 404)
 */
import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireAuth } from "./lib/auth";
import { readMessages } from "./lib/messages";

const RUNS_LIMIT = 8;
const DRAFTS_LIMIT = 5;

export const getProjectReview = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    const project = await ctx.db.get(args.projectId);
    if (!project) return null;

    const collaborator = await ctx.db
      .query("projectCollaborators")
      .withIndex("by_project_and_user", (q) =>
        q.eq("projectId", args.projectId).eq("userId", userId),
      )
      .unique();
    if (!collaborator) return null;
    // Blind evaluators have their own inbox; reject so the frontend can 404.
    if (
      collaborator.role === "evaluator" &&
      (collaborator.blindMode ?? true)
    ) {
      return null;
    }

    const versions = await ctx.db
      .query("promptVersions")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .take(200);

    // Pick the active version: prefer "current", fall back to latest non-draft,
    // fall back to latest draft.
    const sortedByNumberDesc = [...versions].sort(
      (a, b) => b.versionNumber - a.versionNumber,
    );
    const currentVersion =
      sortedByNumberDesc.find((v) => v.status === "current") ??
      sortedByNumberDesc.find((v) => v.status !== "draft") ??
      sortedByNumberDesc[0] ??
      null;

    const author = currentVersion
      ? await ctx.db.get(currentVersion.createdById)
      : null;

    // ----- Runs waiting for this reviewer's feedback ------------------------
    // Recent completed runs in the project, then keep ones with at least one
    // output the reviewer hasn't annotated yet. Reactive: the `useQuery`
    // subscription fires when new runs land or when the reviewer's annotations
    // are written.
    const completedRuns = await ctx.db
      .query("promptRuns")
      .withIndex("by_project_and_status", (q) =>
        q.eq("projectId", args.projectId).eq("status", "completed"),
      )
      .order("desc")
      .take(RUNS_LIMIT * 2);

    const runsWaiting = [];
    for (const run of completedRuns) {
      const outputs = await ctx.db
        .query("runOutputs")
        .withIndex("by_run", (q) => q.eq("runId", run._id))
        .take(10);
      let untouched = 0;
      for (const output of outputs) {
        const fb = await ctx.db
          .query("outputFeedback")
          .withIndex("by_output", (q) => q.eq("outputId", output._id))
          .take(50);
        if (!fb.some((f) => f.userId === userId)) untouched++;
      }
      if (untouched === 0) continue;
      const trigger = await ctx.db.get(run.triggeredById);
      const testCase = run.testCaseId
        ? await ctx.db.get(run.testCaseId)
        : null;
      runsWaiting.push({
        runId: run._id,
        completedAt: run.completedAt ?? run._creationTime,
        triggeredByName: trigger?.name ?? trigger?.email ?? null,
        triggeredByImage: trigger?.image ?? null,
        testCaseName: testCase?.name ?? null,
        outputsToReview: untouched,
      });
      if (runsWaiting.length >= RUNS_LIMIT) break;
    }

    // ----- Drafts ready for review ------------------------------------------
    // New non-draft versions the reviewer hasn't left feedback on. Keeps the
    // common case ("editor shipped a v2 since I last looked") visible without
    // hand-rolling an opt-out tracker.
    const nonDraftVersions = sortedByNumberDesc.filter(
      (v) => v.status !== "draft",
    );
    const draftsWaiting = [];
    for (const version of nonDraftVersions) {
      if (currentVersion && version._id === currentVersion._id) continue;
      const myFeedback = await ctx.db
        .query("promptFeedback")
        .withIndex("by_version", (q) => q.eq("promptVersionId", version._id))
        .take(50);
      if (myFeedback.some((f) => f.userId === userId)) continue;
      const versionAuthor = await ctx.db.get(version.createdById);
      draftsWaiting.push({
        versionId: version._id,
        createdAt: version._creationTime,
        authorName: versionAuthor?.name ?? versionAuthor?.email ?? null,
        authorImage: versionAuthor?.image ?? null,
      });
      if (draftsWaiting.length >= DRAFTS_LIMIT) break;
    }

    const org = await ctx.db.get(project.organizationId);

    return {
      project: {
        _id: project._id,
        name: project.name,
        description: project.description ?? null,
        organizationId: project.organizationId,
        orgSlug: org?.slug ?? null,
      },
      role: collaborator.role,
      blindMode: collaborator.blindMode ?? null,
      currentVersion: currentVersion
        ? {
            versionId: currentVersion._id,
            createdAt: currentVersion._creationTime,
            authorName: author?.name ?? author?.email ?? null,
            authorImage: author?.image ?? null,
            messages: readMessages(currentVersion),
          }
        : null,
      runsWaiting,
      draftsWaiting,
    };
  },
});
