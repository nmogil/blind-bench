import { v } from "convex/values";
import { mutation, query, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireProjectRole, requireAuth } from "./lib/auth";
import { fisherYatesShuffle } from "./lib/shuffle";
import { getCycleBlindLabels } from "./lib/slotConfig";
import { generateToken } from "./lib/evalTokens";
import { resolveCycleEvalToken } from "./lib/cycleEvalTokens";
import { Id } from "./_generated/dataModel";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CYCLE_EVAL_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ---------------------------------------------------------------------------
// #57: Cycle CRUD mutations
// ---------------------------------------------------------------------------

export const create = mutation({
  args: {
    projectId: v.id("projects"),
    primaryVersionId: v.id("promptVersions"),
    controlVersionId: v.optional(v.id("promptVersions")),
    parentCycleId: v.optional(v.id("reviewCycles")),
  },
  handler: async (ctx, args) => {
    const { userId } = await requireProjectRole(ctx, args.projectId, [
      "owner",
      "editor",
    ]);

    // Validate primary version belongs to project
    const primaryVersion = await ctx.db.get(args.primaryVersionId);
    if (!primaryVersion || primaryVersion.projectId !== args.projectId) {
      throw new Error("Primary version not found in this project");
    }

    // Validate control version belongs to project (if provided)
    let controlVersionNumber: number | null = null;
    if (args.controlVersionId) {
      const controlVersion = await ctx.db.get(args.controlVersionId);
      if (!controlVersion || controlVersion.projectId !== args.projectId) {
        throw new Error("Control version not found in this project");
      }
      controlVersionNumber = controlVersion.versionNumber;
    }

    // Validate parent cycle (if provided)
    if (args.parentCycleId) {
      const parentCycle = await ctx.db.get(args.parentCycleId);
      if (!parentCycle || parentCycle.projectId !== args.projectId) {
        throw new Error("Parent cycle not found in this project");
      }
    }

    // Auto-generate name: "Cycle N — vX vs vY"
    const existingCycles = await ctx.db
      .query("reviewCycles")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .take(1000);
    const cycleNumber = existingCycles.length + 1;
    const name = controlVersionNumber !== null
      ? `Cycle ${cycleNumber} — v${primaryVersion.versionNumber} vs v${controlVersionNumber}`
      : `Cycle ${cycleNumber} — v${primaryVersion.versionNumber}`;

    const cycleId = await ctx.db.insert("reviewCycles", {
      projectId: args.projectId,
      primaryVersionId: args.primaryVersionId,
      controlVersionId: args.controlVersionId,
      parentCycleId: args.parentCycleId,
      name,
      status: "draft",
      includeSoloEval: false,
      createdById: userId,
    });

    return cycleId;
  },
});

export const addOutputs = mutation({
  args: {
    cycleId: v.id("reviewCycles"),
    runIds: v.array(v.id("promptRuns")),
  },
  handler: async (ctx, args) => {
    const cycle = await ctx.db.get(args.cycleId);
    if (!cycle) throw new Error("Cycle not found");
    if (cycle.status !== "draft") {
      throw new Error("Can only add outputs to a draft cycle");
    }

    await requireProjectRole(ctx, cycle.projectId, ["owner", "editor"]);

    // Collect all outputs from the specified runs
    const newOutputEntries: Array<{
      sourceOutputId: Id<"runOutputs">;
      sourceRunId: Id<"promptRuns">;
      sourceVersionId: Id<"promptVersions">;
      content: string;
    }> = [];

    for (const runId of args.runIds) {
      const run = await ctx.db.get(runId);
      if (!run) throw new Error(`Run ${runId} not found`);
      if (run.status !== "completed") {
        throw new Error(`Run must be completed to pool outputs`);
      }
      if (run.projectId !== cycle.projectId) {
        throw new Error(`Run does not belong to this project`);
      }

      const outputs = await ctx.db
        .query("runOutputs")
        .withIndex("by_run", (q) => q.eq("runId", runId))
        .take(10);

      for (const output of outputs) {
        newOutputEntries.push({
          sourceOutputId: output._id,
          sourceRunId: runId,
          sourceVersionId: run.promptVersionId,
          content: output.outputContent,
        });
      }
    }

    if (newOutputEntries.length === 0) {
      throw new Error("No outputs found in the specified runs");
    }

    // Get existing cycle outputs to merge with new ones
    const existingOutputs = await ctx.db
      .query("cycleOutputs")
      .withIndex("by_cycle", (q) => q.eq("cycleId", args.cycleId))
      .take(26);

    // Filter out duplicates (already-pooled outputs)
    const existingSourceIds = new Set(
      existingOutputs.map((o) => o.sourceOutputId),
    );
    const uniqueNewEntries = newOutputEntries.filter(
      (e) => !existingSourceIds.has(e.sourceOutputId),
    );

    // Combine existing + new, check total doesn't exceed 26
    const totalCount = existingOutputs.length + uniqueNewEntries.length;
    if (totalCount > 26) {
      throw new Error(
        `Cannot exceed 26 outputs per cycle (would have ${totalCount})`,
      );
    }

    // Delete existing cycle outputs — we'll re-shuffle everything
    for (const existing of existingOutputs) {
      await ctx.db.delete(existing._id);
    }

    // Build combined pool and shuffle
    const allEntries = [
      ...existingOutputs.map((o) => ({
        sourceOutputId: o.sourceOutputId,
        sourceRunId: o.sourceRunId,
        sourceVersionId: o.sourceVersionId,
        content: o.outputContentSnapshot,
      })),
      ...uniqueNewEntries,
    ];

    const shuffled = fisherYatesShuffle(allEntries);
    const labels = getCycleBlindLabels(shuffled.length);

    // Insert freshly shuffled + labeled outputs
    for (let i = 0; i < shuffled.length; i++) {
      const entry = shuffled[i]!;
      await ctx.db.insert("cycleOutputs", {
        cycleId: args.cycleId,
        sourceOutputId: entry.sourceOutputId,
        sourceRunId: entry.sourceRunId,
        sourceVersionId: entry.sourceVersionId,
        cycleBlindLabel: labels[i]!,
        outputContentSnapshot: entry.content,
      });
    }

    return { outputCount: shuffled.length };
  },
});

export const autoPoolOutputs = mutation({
  args: {
    cycleId: v.id("reviewCycles"),
  },
  handler: async (ctx, args) => {
    const cycle = await ctx.db.get(args.cycleId);
    if (!cycle) throw new Error("Cycle not found");
    if (cycle.status !== "draft") {
      throw new Error("Can only pool outputs for a draft cycle");
    }

    await requireProjectRole(ctx, cycle.projectId, ["owner", "editor"]);

    // Gather version IDs to pool from
    const versionIds: Id<"promptVersions">[] = [cycle.primaryVersionId];
    if (cycle.controlVersionId) {
      versionIds.push(cycle.controlVersionId);
    }

    // For each version, find the most recent completed run per test case
    const runIds: Id<"promptRuns">[] = [];

    for (const versionId of versionIds) {
      const runs = await ctx.db
        .query("promptRuns")
        .withIndex("by_version", (q) => q.eq("promptVersionId", versionId))
        .take(200);

      const completedRuns = runs.filter((r) => r.status === "completed");

      // Group by test case, pick most recent per group
      const byTestCase = new Map<string, typeof completedRuns[0]>();
      // Also track runs without a test case (quick runs)
      const noTestCaseRuns: typeof completedRuns = [];

      for (const run of completedRuns) {
        const key = run.testCaseId ?? null;
        if (key === null) {
          noTestCaseRuns.push(run);
        } else {
          const existing = byTestCase.get(key);
          if (!existing || run._creationTime > existing._creationTime) {
            byTestCase.set(key, run);
          }
        }
      }

      // Add most recent run per test case
      for (const run of byTestCase.values()) {
        runIds.push(run._id);
      }

      // Add the most recent quick run (if any)
      if (noTestCaseRuns.length > 0) {
        noTestCaseRuns.sort(
          (a, b) => b._creationTime - a._creationTime,
        );
        runIds.push(noTestCaseRuns[0]!._id);
      }
    }

    if (runIds.length === 0) {
      throw new Error(
        "No completed runs found for the selected versions",
      );
    }

    // Delegate to addOutputs which handles dedup, shuffle, labeling
    // We call the handler logic directly to avoid scheduling
    // But since we can't call mutations from mutations, we'll inline the logic
    const newOutputEntries: Array<{
      sourceOutputId: Id<"runOutputs">;
      sourceRunId: Id<"promptRuns">;
      sourceVersionId: Id<"promptVersions">;
      content: string;
    }> = [];

    for (const runId of runIds) {
      const run = await ctx.db.get(runId);
      if (!run) continue;

      const outputs = await ctx.db
        .query("runOutputs")
        .withIndex("by_run", (q) => q.eq("runId", runId))
        .take(10);

      for (const output of outputs) {
        newOutputEntries.push({
          sourceOutputId: output._id,
          sourceRunId: runId,
          sourceVersionId: run.promptVersionId,
          content: output.outputContent,
        });
      }
    }

    if (newOutputEntries.length === 0) {
      throw new Error("No outputs found in the selected runs");
    }

    // Delete any existing cycle outputs
    const existingOutputs = await ctx.db
      .query("cycleOutputs")
      .withIndex("by_cycle", (q) => q.eq("cycleId", args.cycleId))
      .take(26);

    for (const existing of existingOutputs) {
      await ctx.db.delete(existing._id);
    }

    // Deduplicate by sourceOutputId
    const seen = new Set<string>();
    const unique = newOutputEntries.filter((e) => {
      if (seen.has(e.sourceOutputId)) return false;
      seen.add(e.sourceOutputId);
      return true;
    });

    if (unique.length > 26) {
      throw new Error(
        `Too many outputs to pool (${unique.length}). Maximum is 26.`,
      );
    }

    const shuffled = fisherYatesShuffle(unique);
    const labels = getCycleBlindLabels(shuffled.length);

    for (let i = 0; i < shuffled.length; i++) {
      const entry = shuffled[i]!;
      await ctx.db.insert("cycleOutputs", {
        cycleId: args.cycleId,
        sourceOutputId: entry.sourceOutputId,
        sourceRunId: entry.sourceRunId,
        sourceVersionId: entry.sourceVersionId,
        cycleBlindLabel: labels[i]!,
        outputContentSnapshot: entry.content,
      });
    }

    return { outputCount: shuffled.length };
  },
});

export const assignEvaluators = mutation({
  args: {
    cycleId: v.id("reviewCycles"),
    evaluatorIds: v.array(v.id("users")),
  },
  handler: async (ctx, args) => {
    const cycle = await ctx.db.get(args.cycleId);
    if (!cycle) throw new Error("Cycle not found");
    if (cycle.status !== "draft") {
      throw new Error("Can only assign evaluators to a draft cycle");
    }

    await requireProjectRole(ctx, cycle.projectId, ["owner", "editor"]);

    // Verify each user is an evaluator on the project
    for (const evalId of args.evaluatorIds) {
      const collaborator = await ctx.db
        .query("projectCollaborators")
        .withIndex("by_project_and_user", (q) =>
          q.eq("projectId", cycle.projectId).eq("userId", evalId),
        )
        .unique();

      if (!collaborator || collaborator.role !== "evaluator") {
        throw new Error(
          `User is not an evaluator on this project`,
        );
      }

      // Check if already assigned
      const existing = await ctx.db
        .query("cycleEvaluators")
        .withIndex("by_cycle_and_user", (q) =>
          q.eq("cycleId", args.cycleId).eq("userId", evalId),
        )
        .unique();

      if (existing) continue; // Skip duplicates

      await ctx.db.insert("cycleEvaluators", {
        cycleId: args.cycleId,
        userId: evalId,
        status: "pending",
        assignedAt: Date.now(),
        reminderCount: 0,
      });
    }
  },
});

export const removeEvaluator = mutation({
  args: {
    cycleId: v.id("reviewCycles"),
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const cycle = await ctx.db.get(args.cycleId);
    if (!cycle) throw new Error("Cycle not found");
    if (cycle.status !== "draft") {
      throw new Error("Can only remove evaluators from a draft cycle");
    }

    await requireProjectRole(ctx, cycle.projectId, ["owner", "editor"]);

    const evaluator = await ctx.db
      .query("cycleEvaluators")
      .withIndex("by_cycle_and_user", (q) =>
        q.eq("cycleId", args.cycleId).eq("userId", args.userId),
      )
      .unique();

    if (!evaluator) throw new Error("Evaluator not assigned to this cycle");

    await ctx.db.delete(evaluator._id);
  },
});

export const start = mutation({
  args: {
    cycleId: v.id("reviewCycles"),
  },
  handler: async (ctx, args) => {
    const cycle = await ctx.db.get(args.cycleId);
    if (!cycle) throw new Error("Cycle not found");
    if (cycle.status !== "draft") {
      throw new Error("Only draft cycles can be started");
    }

    await requireProjectRole(ctx, cycle.projectId, ["owner", "editor"]);

    // Verify at least 1 output
    const outputs = await ctx.db
      .query("cycleOutputs")
      .withIndex("by_cycle", (q) => q.eq("cycleId", args.cycleId))
      .take(1);
    if (outputs.length === 0) {
      throw new Error("Add at least one output before starting the cycle");
    }

    // Verify no other open cycle for this primaryVersionId
    const openCycles = await ctx.db
      .query("reviewCycles")
      .withIndex("by_primary_version", (q) =>
        q.eq("primaryVersionId", cycle.primaryVersionId),
      )
      .take(50);
    const hasOpenCycle = openCycles.some(
      (c) => c.status === "open" && c._id !== args.cycleId,
    );
    if (hasOpenCycle) {
      throw new Error(
        "There is already an open cycle for this version. Close it first.",
      );
    }

    // Mint cycle eval token (24hr TTL)
    const token = generateToken();
    await ctx.db.insert("cycleEvalTokens", {
      token,
      cycleId: args.cycleId,
      projectId: cycle.projectId,
      expiresAt: Date.now() + CYCLE_EVAL_TOKEN_TTL_MS,
    });

    // Open the cycle
    await ctx.db.patch(args.cycleId, {
      status: "open",
      openedAt: Date.now(),
    });

    // Schedule evaluator notifications
    await ctx.scheduler.runAfter(
      0,
      internal.evaluatorNotifications.notifyCycleEvaluators,
      {
        cycleId: args.cycleId,
        projectId: cycle.projectId,
        type: "cycle_assigned" as const,
        message: `You've been assigned to review "${cycle.name}"`,
      },
    );

    return { token };
  },
});

export const close = mutation({
  args: {
    cycleId: v.id("reviewCycles"),
  },
  handler: async (ctx, args) => {
    const cycle = await ctx.db.get(args.cycleId);
    if (!cycle) throw new Error("Cycle not found");
    if (cycle.status !== "open") {
      throw new Error("Only open cycles can be closed");
    }

    await requireProjectRole(ctx, cycle.projectId, ["owner", "editor"]);

    await ctx.db.patch(args.cycleId, {
      status: "closed",
      closedAt: Date.now(),
    });

    // Notify evaluators that the cycle is closed
    await ctx.scheduler.runAfter(
      0,
      internal.evaluatorNotifications.notifyCycleEvaluators,
      {
        cycleId: args.cycleId,
        projectId: cycle.projectId,
        type: "cycle_closed" as const,
        message: `Review cycle "${cycle.name}" has been closed`,
      },
    );
  },
});

export const setClosedAction = mutation({
  args: {
    cycleId: v.id("reviewCycles"),
    action: v.union(
      v.literal("new_version_manual"),
      v.literal("optimizer_requested"),
      v.literal("no_action"),
    ),
  },
  handler: async (ctx, args) => {
    const cycle = await ctx.db.get(args.cycleId);
    if (!cycle) throw new Error("Cycle not found");
    if (cycle.status !== "closed") {
      throw new Error("Can only set closed action on a closed cycle");
    }

    await requireProjectRole(ctx, cycle.projectId, ["owner", "editor"]);

    await ctx.db.patch(args.cycleId, {
      closedAction: args.action,
    });

    // If optimizer requested, trigger the existing optimizer
    if (args.action === "optimizer_requested") {
      const requestId = await ctx.db.insert("optimizationRequests", {
        projectId: cycle.projectId,
        promptVersionId: cycle.primaryVersionId,
        status: "pending",
        optimizerModel: "anthropic/claude-sonnet-4",
        optimizerPromptVersion: "cycle-triggered",
        requestedById: (
          await requireProjectRole(ctx, cycle.projectId, [
            "owner",
            "editor",
          ])
        ).userId,
        sourceCycleId: args.cycleId,
      });
      await ctx.db.patch(args.cycleId, {
        resultingOptimizationId: requestId,
      });
      // Schedule the optimizer action
      await ctx.scheduler.runAfter(
        0,
        internal.optimizeActions.runOptimizerAction,
        { requestId },
      );
    }
  },
});

export const updateName = mutation({
  args: {
    cycleId: v.id("reviewCycles"),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    const cycle = await ctx.db.get(args.cycleId);
    if (!cycle) throw new Error("Cycle not found");

    await requireProjectRole(ctx, cycle.projectId, ["owner", "editor"]);

    await ctx.db.patch(args.cycleId, { name: args.name });
  },
});

// ===========================================================================
// #58: Cycle evaluation — evaluator-facing mutations (SECURITY BOUNDARY)
// ===========================================================================

/**
 * SECURITY BOUNDARY — Returns ONLY blind labels and content snapshots.
 * No sourceOutputId, sourceRunId, sourceVersionId, model, temperature, latency.
 */
export const getOutputsForEvaluator = query({
  args: { cycleEvalToken: v.string() },
  handler: async (ctx, args) => {
    const resolved = await resolveCycleEvalToken(ctx, args.cycleEvalToken);
    if (!resolved) throw new Error("Invalid or expired cycle eval token");

    const cycle = await ctx.db.get(resolved.cycleId);
    if (!cycle) throw new Error("Cycle not found");

    // Verify caller is assigned as an evaluator for this cycle
    const userId = await requireAuth(ctx);
    const evaluator = await ctx.db
      .query("cycleEvaluators")
      .withIndex("by_cycle_and_user", (q) =>
        q.eq("cycleId", resolved.cycleId).eq("userId", userId),
      )
      .unique();
    if (!evaluator) throw new Error("Not assigned to this cycle");

    const project = await ctx.db.get(resolved.projectId);

    const outputs = await ctx.db
      .query("cycleOutputs")
      .withIndex("by_cycle", (q) => q.eq("cycleId", resolved.cycleId))
      .take(26);

    // Load existing feedback annotations for display
    const result = [];
    for (const output of outputs) {
      const feedback = await ctx.db
        .query("cycleFeedback")
        .withIndex("by_cycle_output", (q) =>
          q.eq("cycleOutputId", output._id),
        )
        .take(200);

      result.push({
        cycleBlindLabel: output.cycleBlindLabel,
        outputContentSnapshot: output.outputContentSnapshot,
        annotations: feedback.map((fb) => ({
          from: fb.annotationData.from,
          to: fb.annotationData.to,
          highlightedText: fb.annotationData.highlightedText,
          comment: fb.annotationData.comment,
          createdAt: fb._creationTime,
        })),
      });
    }

    // SECURITY: Return ONLY blindLabel, content snapshot, annotations + names
    return {
      projectName: project?.name ?? "Unknown",
      cycleName: cycle.name,
      cycleStatus: cycle.status,
      outputs: result.sort((a, b) =>
        a.cycleBlindLabel.localeCompare(b.cycleBlindLabel),
      ),
    };
  },
});

/** Token-based rating for evaluators. Upserts cyclePreferences. */
export const rateCycleOutput = mutation({
  args: {
    cycleEvalToken: v.string(),
    cycleBlindLabel: v.string(),
    rating: v.union(
      v.literal("best"),
      v.literal("acceptable"),
      v.literal("weak"),
    ),
  },
  handler: async (ctx, args) => {
    const resolved = await resolveCycleEvalToken(ctx, args.cycleEvalToken);
    if (!resolved) throw new Error("Invalid or expired cycle eval token");

    const cycle = await ctx.db.get(resolved.cycleId);
    if (!cycle || cycle.status !== "open") {
      throw new Error("Cycle is not open for evaluation");
    }

    const userId = await requireAuth(ctx);

    // Verify evaluator is assigned
    const evaluator = await ctx.db
      .query("cycleEvaluators")
      .withIndex("by_cycle_and_user", (q) =>
        q.eq("cycleId", resolved.cycleId).eq("userId", userId),
      )
      .unique();
    if (!evaluator) throw new Error("Not assigned to this cycle");

    // Find output by blind label (never by outputId)
    const cycleOutput = await ctx.db
      .query("cycleOutputs")
      .withIndex("by_cycle_and_label", (q) =>
        q
          .eq("cycleId", resolved.cycleId)
          .eq("cycleBlindLabel", args.cycleBlindLabel),
      )
      .unique();
    if (!cycleOutput) throw new Error("Output not found");

    // Upsert: check for existing rating by this user on this output
    const existing = await ctx.db
      .query("cyclePreferences")
      .withIndex("by_cycle_output", (q) =>
        q.eq("cycleOutputId", cycleOutput._id),
      )
      .take(100);
    const myExisting = existing.find(
      (p) => p.userId === userId && p.source === "evaluator",
    );

    if (myExisting) {
      await ctx.db.patch(myExisting._id, { rating: args.rating });
    } else {
      await ctx.db.insert("cyclePreferences", {
        cycleId: resolved.cycleId,
        cycleOutputId: cycleOutput._id,
        userId,
        rating: args.rating,
        source: "evaluator",
      });
    }

    // Auto-update evaluator status
    const totalOutputs = await ctx.db
      .query("cycleOutputs")
      .withIndex("by_cycle", (q) => q.eq("cycleId", resolved.cycleId))
      .take(26);

    const myRatings = await ctx.db
      .query("cyclePreferences")
      .withIndex("by_cycle_user", (q) =>
        q.eq("cycleId", resolved.cycleId).eq("userId", userId),
      )
      .take(26);
    const evaluatorRatings = myRatings.filter(
      (r) => r.source === "evaluator",
    );

    if (evaluator.status === "pending") {
      await ctx.db.patch(evaluator._id, {
        status: "in_progress",
        startedAt: Date.now(),
      });
    }

    if (evaluatorRatings.length >= totalOutputs.length) {
      await ctx.db.patch(evaluator._id, {
        status: "completed",
        completedAt: Date.now(),
      });
    }
  },
});

/** Token-based annotation feedback for evaluators. */
export const addCycleFeedback = mutation({
  args: {
    cycleEvalToken: v.string(),
    cycleBlindLabel: v.string(),
    annotationData: v.object({
      from: v.number(),
      to: v.number(),
      highlightedText: v.string(),
      comment: v.string(),
    }),
    tags: v.optional(
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
    ),
  },
  handler: async (ctx, args) => {
    const resolved = await resolveCycleEvalToken(ctx, args.cycleEvalToken);
    if (!resolved) throw new Error("Invalid or expired cycle eval token");

    const cycle = await ctx.db.get(resolved.cycleId);
    if (!cycle || cycle.status !== "open") {
      throw new Error("Cycle is not open for evaluation");
    }

    const userId = await requireAuth(ctx);

    // Verify evaluator is assigned
    const evaluator = await ctx.db
      .query("cycleEvaluators")
      .withIndex("by_cycle_and_user", (q) =>
        q.eq("cycleId", resolved.cycleId).eq("userId", userId),
      )
      .unique();
    if (!evaluator) throw new Error("Not assigned to this cycle");

    // Find output by blind label
    const cycleOutput = await ctx.db
      .query("cycleOutputs")
      .withIndex("by_cycle_and_label", (q) =>
        q
          .eq("cycleId", resolved.cycleId)
          .eq("cycleBlindLabel", args.cycleBlindLabel),
      )
      .unique();
    if (!cycleOutput) throw new Error("Output not found");

    await ctx.db.insert("cycleFeedback", {
      cycleId: resolved.cycleId,
      cycleOutputId: cycleOutput._id,
      userId,
      annotationData: args.annotationData,
      tags: args.tags,
      source: "evaluator",
    });
  },
});

/** Author rates outputs directly (not token-based). */
export const rateAsAuthor = mutation({
  args: {
    cycleId: v.id("reviewCycles"),
    cycleBlindLabel: v.string(),
    rating: v.union(
      v.literal("best"),
      v.literal("acceptable"),
      v.literal("weak"),
    ),
  },
  handler: async (ctx, args) => {
    const cycle = await ctx.db.get(args.cycleId);
    if (!cycle) throw new Error("Cycle not found");

    const { userId } = await requireProjectRole(ctx, cycle.projectId, [
      "owner",
      "editor",
    ]);

    // Find output by blind label
    const cycleOutput = await ctx.db
      .query("cycleOutputs")
      .withIndex("by_cycle_and_label", (q) =>
        q
          .eq("cycleId", args.cycleId)
          .eq("cycleBlindLabel", args.cycleBlindLabel),
      )
      .unique();
    if (!cycleOutput) throw new Error("Output not found");

    // Upsert author rating
    const existing = await ctx.db
      .query("cyclePreferences")
      .withIndex("by_cycle_output", (q) =>
        q.eq("cycleOutputId", cycleOutput._id),
      )
      .take(100);
    const myExisting = existing.find(
      (p) => p.userId === userId && p.source === "author",
    );

    if (myExisting) {
      await ctx.db.patch(myExisting._id, { rating: args.rating });
    } else {
      await ctx.db.insert("cyclePreferences", {
        cycleId: args.cycleId,
        cycleOutputId: cycleOutput._id,
        userId,
        rating: args.rating,
        source: "author",
      });
    }
  },
});

/** Token-based query: returns existing ratings for the current user. */
export const getMyRatingsForCycle = query({
  args: { cycleEvalToken: v.string() },
  handler: async (ctx, args) => {
    const resolved = await resolveCycleEvalToken(ctx, args.cycleEvalToken);
    if (!resolved) throw new Error("Invalid or expired cycle eval token");

    const userId = await requireAuth(ctx);

    const ratings = await ctx.db
      .query("cyclePreferences")
      .withIndex("by_cycle_user", (q) =>
        q.eq("cycleId", resolved.cycleId).eq("userId", userId),
      )
      .take(26);

    const evaluatorRatings = ratings.filter(
      (r) => r.source === "evaluator",
    );

    // Map to blind labels — never expose output IDs to evaluators
    const result = [];
    for (const rating of evaluatorRatings) {
      const output = await ctx.db.get(rating.cycleOutputId);
      if (output) {
        result.push({
          cycleBlindLabel: output.cycleBlindLabel,
          rating: rating.rating,
        });
      }
    }

    return result;
  },
});

// ===========================================================================
// #59: Cycle queries — author view
// ===========================================================================

/** List all cycles for a project (owner/editor only). */
export const list = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    await requireProjectRole(ctx, args.projectId, ["owner", "editor"]);

    const cycles = await ctx.db
      .query("reviewCycles")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .take(200);

    const result = [];
    for (const cycle of cycles) {
      // Get version numbers
      const primaryVersion = await ctx.db.get(cycle.primaryVersionId);
      const controlVersion = cycle.controlVersionId
        ? await ctx.db.get(cycle.controlVersionId)
        : null;

      // Get evaluator progress
      const evaluators = await ctx.db
        .query("cycleEvaluators")
        .withIndex("by_cycle", (q) => q.eq("cycleId", cycle._id))
        .take(50);

      const outputCount = (
        await ctx.db
          .query("cycleOutputs")
          .withIndex("by_cycle", (q) => q.eq("cycleId", cycle._id))
          .take(26)
      ).length;

      result.push({
        _id: cycle._id,
        name: cycle.name,
        status: cycle.status,
        primaryVersionNumber: primaryVersion?.versionNumber ?? null,
        controlVersionNumber: controlVersion?.versionNumber ?? null,
        outputCount,
        evaluatorProgress: {
          total: evaluators.length,
          pending: evaluators.filter((e) => e.status === "pending").length,
          inProgress: evaluators.filter((e) => e.status === "in_progress")
            .length,
          completed: evaluators.filter((e) => e.status === "completed")
            .length,
        },
        createdAt: cycle._creationTime,
        openedAt: cycle.openedAt ?? null,
        closedAt: cycle.closedAt ?? null,
        closedAction: cycle.closedAction ?? null,
      });
    }

    return result.sort((a, b) => b.createdAt - a.createdAt);
  },
});

/** Get full cycle detail with version reveal for the author. */
export const get = query({
  args: { cycleId: v.id("reviewCycles") },
  handler: async (ctx, args) => {
    const cycle = await ctx.db.get(args.cycleId);
    if (!cycle) throw new Error("Cycle not found");

    await requireProjectRole(ctx, cycle.projectId, ["owner", "editor"]);

    const project = await ctx.db.get(cycle.projectId);
    const primaryVersion = await ctx.db.get(cycle.primaryVersionId);
    const controlVersion = cycle.controlVersionId
      ? await ctx.db.get(cycle.controlVersionId)
      : null;

    // Outputs with version reveal (author only)
    const rawOutputs = await ctx.db
      .query("cycleOutputs")
      .withIndex("by_cycle", (q) => q.eq("cycleId", args.cycleId))
      .take(26);

    const outputs = [];
    for (const output of rawOutputs) {
      const sourceVersion = await ctx.db.get(output.sourceVersionId);
      const sourceRun = await ctx.db.get(output.sourceRunId);
      const sourceOutput = await ctx.db.get(output.sourceOutputId);

      // Aggregate ratings for this output
      const preferences = await ctx.db
        .query("cyclePreferences")
        .withIndex("by_cycle_output", (q) =>
          q.eq("cycleOutputId", output._id),
        )
        .take(200);

      const ratings = {
        best: preferences.filter((p) => p.rating === "best").length,
        acceptable: preferences.filter((p) => p.rating === "acceptable")
          .length,
        weak: preferences.filter((p) => p.rating === "weak").length,
        bySource: {
          evaluator: {
            best: preferences.filter(
              (p) => p.source === "evaluator" && p.rating === "best",
            ).length,
            acceptable: preferences.filter(
              (p) => p.source === "evaluator" && p.rating === "acceptable",
            ).length,
            weak: preferences.filter(
              (p) => p.source === "evaluator" && p.rating === "weak",
            ).length,
          },
          anonymous: {
            best: preferences.filter(
              (p) => p.source === "anonymous" && p.rating === "best",
            ).length,
            acceptable: preferences.filter(
              (p) => p.source === "anonymous" && p.rating === "acceptable",
            ).length,
            weak: preferences.filter(
              (p) => p.source === "anonymous" && p.rating === "weak",
            ).length,
          },
          solo: {
            best: preferences.filter(
              (p) => p.source === "solo" && p.rating === "best",
            ).length,
            acceptable: preferences.filter(
              (p) => p.source === "solo" && p.rating === "acceptable",
            ).length,
            weak: preferences.filter(
              (p) => p.source === "solo" && p.rating === "weak",
            ).length,
          },
          author: {
            best: preferences.filter(
              (p) => p.source === "author" && p.rating === "best",
            ).length,
            acceptable: preferences.filter(
              (p) => p.source === "author" && p.rating === "acceptable",
            ).length,
            weak: preferences.filter(
              (p) => p.source === "author" && p.rating === "weak",
            ).length,
          },
        },
      };

      outputs.push({
        _id: output._id,
        cycleBlindLabel: output.cycleBlindLabel,
        outputContentSnapshot: output.outputContentSnapshot,
        sourceVersionNumber: sourceVersion?.versionNumber ?? null,
        sourceVersionId: output.sourceVersionId,
        sourceRunBlindLabel: sourceOutput?.blindLabel ?? null,
        sourceModel: sourceOutput?.model ?? sourceRun?.model ?? null,
        sourceTemperature:
          sourceOutput?.temperature ?? sourceRun?.temperature ?? null,
        isPrimaryVersion:
          output.sourceVersionId === cycle.primaryVersionId,
        ratings,
      });
    }

    // Evaluators with user names
    const rawEvaluators = await ctx.db
      .query("cycleEvaluators")
      .withIndex("by_cycle", (q) => q.eq("cycleId", args.cycleId))
      .take(50);

    const evaluators = [];
    for (const evaluator of rawEvaluators) {
      const user = await ctx.db.get(evaluator.userId);
      evaluators.push({
        _id: evaluator._id,
        userId: evaluator.userId,
        userName: user?.name ?? null,
        userEmail: user?.email ?? null,
        status: evaluator.status,
        assignedAt: evaluator.assignedAt,
        startedAt: evaluator.startedAt ?? null,
        completedAt: evaluator.completedAt ?? null,
        lastReminderSentAt: evaluator.lastReminderSentAt ?? null,
        reminderCount: evaluator.reminderCount,
      });
    }

    // Get eval token for sharing
    const evalToken = await ctx.db
      .query("cycleEvalTokens")
      .withIndex("by_cycle", (q) => q.eq("cycleId", args.cycleId))
      .take(1);

    // Get shareable link if exists (exclude per-email invitation links)
    const shareableLink = await ctx.db
      .query("cycleShareableLinks")
      .withIndex("by_cycle", (q) => q.eq("cycleId", args.cycleId))
      .take(100);
    const activeLink = shareableLink.find(
      (l) => l.active && l.purpose !== "invitation",
    );

    return {
      _id: cycle._id,
      projectId: cycle.projectId,
      projectName: project?.name ?? "Unknown",
      name: cycle.name,
      status: cycle.status,
      primaryVersionId: cycle.primaryVersionId,
      primaryVersionNumber: primaryVersion?.versionNumber ?? null,
      controlVersionId: cycle.controlVersionId ?? null,
      controlVersionNumber: controlVersion?.versionNumber ?? null,
      parentCycleId: cycle.parentCycleId ?? null,
      includeSoloEval: cycle.includeSoloEval,
      createdById: cycle.createdById,
      createdAt: cycle._creationTime,
      openedAt: cycle.openedAt ?? null,
      closedAt: cycle.closedAt ?? null,
      closedAction: cycle.closedAction ?? null,
      resultingVersionId: cycle.resultingVersionId ?? null,
      resultingOptimizationId: cycle.resultingOptimizationId ?? null,
      outputs: outputs.sort((a, b) =>
        a.cycleBlindLabel.localeCompare(b.cycleBlindLabel),
      ),
      evaluators,
      evalToken: evalToken[0]?.token ?? null,
      shareableLink: activeLink
        ? {
            token: activeLink.token,
            responseCount: activeLink.responseCount,
            expiresAt: activeLink.expiresAt,
          }
        : null,
    };
  },
});

/** Aggregated ratings per output with source breakdown. */
export const getCycleAggregates = query({
  args: { cycleId: v.id("reviewCycles") },
  handler: async (ctx, args) => {
    const cycle = await ctx.db.get(args.cycleId);
    if (!cycle) throw new Error("Cycle not found");

    await requireProjectRole(ctx, cycle.projectId, ["owner", "editor"]);

    const outputs = await ctx.db
      .query("cycleOutputs")
      .withIndex("by_cycle", (q) => q.eq("cycleId", args.cycleId))
      .take(26);

    const result = [];
    for (const output of outputs) {
      const preferences = await ctx.db
        .query("cyclePreferences")
        .withIndex("by_cycle_output", (q) =>
          q.eq("cycleOutputId", output._id),
        )
        .take(200);

      // Aggregate feedback tags
      const feedback = await ctx.db
        .query("cycleFeedback")
        .withIndex("by_cycle_output", (q) =>
          q.eq("cycleOutputId", output._id),
        )
        .take(200);

      const tagCounts: Record<string, number> = {};
      for (const fb of feedback) {
        if (fb.tags) {
          for (const tag of fb.tags) {
            tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
          }
        }
      }

      result.push({
        cycleBlindLabel: output.cycleBlindLabel,
        sourceVersionId: output.sourceVersionId,
        bestCount: preferences.filter((p) => p.rating === "best").length,
        acceptableCount: preferences.filter(
          (p) => p.rating === "acceptable",
        ).length,
        weakCount: preferences.filter((p) => p.rating === "weak").length,
        bySource: {
          evaluator: preferences.filter((p) => p.source === "evaluator")
            .length,
          anonymous: preferences.filter((p) => p.source === "anonymous")
            .length,
          solo: preferences.filter((p) => p.source === "solo").length,
          author: preferences.filter((p) => p.source === "author").length,
        },
        tagCounts,
        feedbackCount: feedback.length,
      });
    }

    return result.sort((a, b) =>
      a.cycleBlindLabel.localeCompare(b.cycleBlindLabel),
    );
  },
});

/** Per-evaluator progress for the author view. */
export const getEvaluatorProgress = query({
  args: { cycleId: v.id("reviewCycles") },
  handler: async (ctx, args) => {
    const cycle = await ctx.db.get(args.cycleId);
    if (!cycle) throw new Error("Cycle not found");

    await requireProjectRole(ctx, cycle.projectId, ["owner", "editor"]);

    const totalOutputs = (
      await ctx.db
        .query("cycleOutputs")
        .withIndex("by_cycle", (q) => q.eq("cycleId", args.cycleId))
        .take(26)
    ).length;

    const evaluators = await ctx.db
      .query("cycleEvaluators")
      .withIndex("by_cycle", (q) => q.eq("cycleId", args.cycleId))
      .take(50);

    const result = [];
    for (const evaluator of evaluators) {
      const user = await ctx.db.get(evaluator.userId);

      // Count rated outputs for this evaluator
      const ratings = await ctx.db
        .query("cyclePreferences")
        .withIndex("by_cycle_user", (q) =>
          q.eq("cycleId", args.cycleId).eq("userId", evaluator.userId),
        )
        .take(26);
      const ratedCount = ratings.filter(
        (r) => r.source === "evaluator",
      ).length;

      result.push({
        userId: evaluator.userId,
        userName: user?.name ?? null,
        userEmail: user?.email ?? null,
        status: evaluator.status,
        ratedCount,
        totalCount: totalOutputs,
        assignedAt: evaluator.assignedAt,
        startedAt: evaluator.startedAt ?? null,
        completedAt: evaluator.completedAt ?? null,
        lastReminderSentAt: evaluator.lastReminderSentAt ?? null,
        reminderCount: evaluator.reminderCount,
      });
    }

    return result;
  },
});

/** Suggest a control version based on historical ratings. */
export const suggestControlVersion = query({
  args: {
    projectId: v.id("projects"),
    excludeVersionId: v.id("promptVersions"),
  },
  handler: async (ctx, args) => {
    await requireProjectRole(ctx, args.projectId, ["owner", "editor"]);

    const versions = await ctx.db
      .query("promptVersions")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .take(200);

    const candidates = versions.filter(
      (v) =>
        v._id !== args.excludeVersionId && v.status !== "draft",
    );

    let bestVersion: {
      suggestedVersionId: Id<"promptVersions">;
      versionNumber: number;
      score: number;
      ratingCount: number;
    } | null = null;

    for (const version of candidates) {
      // Find all runs for this version
      const runs = await ctx.db
        .query("promptRuns")
        .withIndex("by_version", (q) =>
          q.eq("promptVersionId", version._id),
        )
        .take(100);

      const completedRuns = runs.filter((r) => r.status === "completed");

      // Aggregate outputPreferences across all runs
      let bestCount = 0;
      let acceptableCount = 0;
      let totalRatings = 0;

      for (const run of completedRuns) {
        const preferences = await ctx.db
          .query("outputPreferences")
          .withIndex("by_run", (q) => q.eq("runId", run._id))
          .take(200);

        for (const pref of preferences) {
          totalRatings++;
          if (pref.rating === "best") bestCount++;
          else if (pref.rating === "acceptable") acceptableCount++;
        }
      }

      if (totalRatings === 0) continue;

      const score = (bestCount * 2 + acceptableCount) / totalRatings;

      if (!bestVersion || score > bestVersion.score) {
        bestVersion = {
          suggestedVersionId: version._id,
          versionNumber: version.versionNumber,
          score,
          ratingCount: totalRatings,
        };
      }
    }

    return bestVersion;
  },
});

// ===========================================================================
// #64: Reminder mutations
// ===========================================================================

const REMINDER_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hours
const MAX_REMINDERS = 3;

export const sendReminder = mutation({
  args: {
    cycleId: v.id("reviewCycles"),
    evaluatorId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const cycle = await ctx.db.get(args.cycleId);
    if (!cycle) throw new Error("Cycle not found");
    if (cycle.status !== "open") {
      throw new Error("Can only send reminders for open cycles");
    }

    await requireProjectRole(ctx, cycle.projectId, ["owner", "editor"]);

    const evaluator = await ctx.db
      .query("cycleEvaluators")
      .withIndex("by_cycle_and_user", (q) =>
        q.eq("cycleId", args.cycleId).eq("userId", args.evaluatorId),
      )
      .unique();
    if (!evaluator) throw new Error("Evaluator not assigned to this cycle");

    if (evaluator.status === "completed") {
      throw new Error("Evaluator has already completed the cycle");
    }

    if (
      evaluator.lastReminderSentAt &&
      Date.now() - evaluator.lastReminderSentAt < REMINDER_COOLDOWN_MS
    ) {
      throw new Error("Reminder sent recently. Wait 4 hours between reminders.");
    }

    if (evaluator.reminderCount >= MAX_REMINDERS) {
      throw new Error("Maximum 3 reminders per evaluator reached");
    }

    // Update evaluator record
    await ctx.db.patch(evaluator._id, {
      lastReminderSentAt: Date.now(),
      reminderCount: evaluator.reminderCount + 1,
    });

    // In-app notification
    await ctx.scheduler.runAfter(
      0,
      internal.evaluatorNotifications.notifyCycleEvaluators,
      {
        cycleId: args.cycleId,
        projectId: cycle.projectId,
        type: "cycle_reminder" as const,
        message: `Reminder: "${cycle.name}" is waiting for your review`,
      },
    );

    // Email reminder
    const user = await ctx.db.get(args.evaluatorId);
    const project = await ctx.db.get(cycle.projectId);
    const evalToken = await ctx.db
      .query("cycleEvalTokens")
      .withIndex("by_cycle", (q) => q.eq("cycleId", args.cycleId))
      .take(1);

    if (user?.email && evalToken[0]) {
      // Count rated outputs
      const ratings = await ctx.db
        .query("cyclePreferences")
        .withIndex("by_cycle_user", (q) =>
          q.eq("cycleId", args.cycleId).eq("userId", args.evaluatorId),
        )
        .take(26);
      const ratedCount = ratings.filter(
        (r) => r.source === "evaluator",
      ).length;
      const totalCount = (
        await ctx.db
          .query("cycleOutputs")
          .withIndex("by_cycle", (q) => q.eq("cycleId", args.cycleId))
          .take(26)
      ).length;

      await ctx.scheduler.runAfter(
        0,
        internal.reviewCycleActions.sendCycleReminderEmail,
        {
          evaluatorEmail: user.email,
          evaluatorName: user.name ?? undefined,
          cycleName: cycle.name,
          projectName: project?.name ?? "Unknown",
          cycleEvalToken: evalToken[0].token,
          ratedCount,
          totalCount,
        },
      );
    }
  },
});

export const sendReminderAll = mutation({
  args: {
    cycleId: v.id("reviewCycles"),
  },
  handler: async (ctx, args) => {
    const cycle = await ctx.db.get(args.cycleId);
    if (!cycle) throw new Error("Cycle not found");
    if (cycle.status !== "open") {
      throw new Error("Can only send reminders for open cycles");
    }

    await requireProjectRole(ctx, cycle.projectId, ["owner", "editor"]);

    const evaluators = await ctx.db
      .query("cycleEvaluators")
      .withIndex("by_cycle", (q) => q.eq("cycleId", args.cycleId))
      .take(50);

    let sentCount = 0;
    for (const evaluator of evaluators) {
      // Skip completed evaluators
      if (evaluator.status === "completed") continue;

      // Check cooldown
      if (
        evaluator.lastReminderSentAt &&
        Date.now() - evaluator.lastReminderSentAt < REMINDER_COOLDOWN_MS
      )
        continue;

      // Check max reminders
      if (evaluator.reminderCount >= MAX_REMINDERS) continue;

      // Update evaluator record
      await ctx.db.patch(evaluator._id, {
        lastReminderSentAt: Date.now(),
        reminderCount: evaluator.reminderCount + 1,
      });

      sentCount++;
    }

    // Send batch notification
    if (sentCount > 0) {
      await ctx.scheduler.runAfter(
        0,
        internal.evaluatorNotifications.notifyCycleEvaluators,
        {
          cycleId: args.cycleId,
          projectId: cycle.projectId,
          type: "cycle_reminder" as const,
          message: `Reminder: "${cycle.name}" is waiting for your review`,
        },
      );
    }

    return { sentCount };
  },
});

// ===========================================================================
// #66: Version-level feedback dashboard
// ===========================================================================

export const getVersionDashboard = query({
  args: { versionId: v.id("promptVersions") },
  handler: async (ctx, args) => {
    const version = await ctx.db.get(args.versionId);
    if (!version) throw new Error("Version not found");

    await requireProjectRole(ctx, version.projectId, ["owner", "editor"]);

    const creator = await ctx.db.get(version.createdById);

    // Find all cycles where this version is the primary
    const allCycles = await ctx.db
      .query("reviewCycles")
      .withIndex("by_primary_version", (q) =>
        q.eq("primaryVersionId", args.versionId),
      )
      .take(100);

    const overallRatings = {
      best: 0,
      acceptable: 0,
      weak: 0,
      total: 0,
    };
    const overallBySource = {
      evaluator: { best: 0, acceptable: 0, weak: 0 },
      anonymous: { best: 0, acceptable: 0, weak: 0 },
      solo: { best: 0, acceptable: 0, weak: 0 },
      author: { best: 0, acceptable: 0, weak: 0 },
    };
    const allTagCounts: Record<string, number> = {};

    const cycles = [];
    for (const cycle of allCycles) {
      const controlVersion = cycle.controlVersionId
        ? await ctx.db.get(cycle.controlVersionId)
        : null;

      // Get outputs for this version only (not control)
      const outputs = await ctx.db
        .query("cycleOutputs")
        .withIndex("by_cycle", (q) => q.eq("cycleId", cycle._id))
        .take(26);
      const versionOutputs = outputs.filter(
        (o) => o.sourceVersionId === args.versionId,
      );

      // Aggregate ratings for this version's outputs in this cycle
      const cycleRatings = {
        best: 0,
        acceptable: 0,
        weak: 0,
      };
      const cycleBySource: Record<
        string,
        { best: number; acceptable: number; weak: number }
      > = {
        evaluator: { best: 0, acceptable: 0, weak: 0 },
        anonymous: { best: 0, acceptable: 0, weak: 0 },
        solo: { best: 0, acceptable: 0, weak: 0 },
        author: { best: 0, acceptable: 0, weak: 0 },
      };
      const cycleTagCounts: Record<string, number> = {};

      for (const output of versionOutputs) {
        const prefs = await ctx.db
          .query("cyclePreferences")
          .withIndex("by_cycle_output", (q) =>
            q.eq("cycleOutputId", output._id),
          )
          .take(200);

        for (const pref of prefs) {
          cycleRatings[pref.rating]++;
          overallRatings[pref.rating]++;
          overallRatings.total++;
          if (cycleBySource[pref.source]) {
            cycleBySource[pref.source]![pref.rating]++;
          }
          if (overallBySource[pref.source as keyof typeof overallBySource]) {
            overallBySource[pref.source as keyof typeof overallBySource][
              pref.rating
            ]++;
          }
        }

        const feedback = await ctx.db
          .query("cycleFeedback")
          .withIndex("by_cycle_output", (q) =>
            q.eq("cycleOutputId", output._id),
          )
          .take(200);

        for (const fb of feedback) {
          if (fb.tags) {
            for (const tag of fb.tags) {
              cycleTagCounts[tag] = (cycleTagCounts[tag] ?? 0) + 1;
              allTagCounts[tag] = (allTagCounts[tag] ?? 0) + 1;
            }
          }
        }
      }

      // Get evaluator counts
      const evaluators = await ctx.db
        .query("cycleEvaluators")
        .withIndex("by_cycle", (q) => q.eq("cycleId", cycle._id))
        .take(50);
      const completedEvals = evaluators.filter(
        (e) => e.status === "completed",
      ).length;

      cycles.push({
        cycleId: cycle._id,
        name: cycle.name,
        status: cycle.status,
        parentCycleId: cycle.parentCycleId ?? null,
        controlVersionNumber: controlVersion?.versionNumber ?? null,
        aggregatedRatings: cycleRatings,
        ratingsBySource: cycleBySource,
        themes: Object.entries(cycleTagCounts)
          .map(([tag, count]) => ({ tag, count }))
          .sort((a, b) => b.count - a.count),
        evaluatorCount: evaluators.length,
        completedEvaluatorCount: completedEvals,
        openedAt: cycle.openedAt ?? null,
        closedAt: cycle.closedAt ?? null,
        closedAction: cycle.closedAction ?? null,
      });
    }

    // Compute top themes with trends (compare last two cycles if available)
    const sortedCycles = cycles
      .filter((c) => c.closedAt !== null)
      .sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0));

    const topThemes = Object.entries(allTagCounts)
      .map(([tag, count]) => {
        let trend: "up" | "down" | "stable" | "new" | "resolved" =
          "stable";

        if (sortedCycles.length >= 2) {
          const prev =
            sortedCycles[sortedCycles.length - 2]!.themes.find(
              (t) => t.tag === tag,
            )?.count ?? 0;
          const curr =
            sortedCycles[sortedCycles.length - 1]!.themes.find(
              (t) => t.tag === tag,
            )?.count ?? 0;

          if (prev === 0 && curr > 0) trend = "new";
          else if (prev > 0 && curr === 0) trend = "resolved";
          else if (curr > prev * 1.5) trend = "up";
          else if (curr < prev * 0.5) trend = "down";
        }

        return { tag, count, trend };
      })
      .sort((a, b) => b.count - a.count);

    return {
      version: {
        _id: version._id,
        versionNumber: version.versionNumber,
        status: version.status,
        createdById: version.createdById,
        createdByName: creator?.name ?? null,
      },
      cycles: cycles.sort(
        (a, b) => (b.openedAt ?? 0) - (a.openedAt ?? 0),
      ),
      overallRatings,
      overallRatingsBySource: overallBySource,
      topThemes,
    };
  },
});

// ===========================================================================
// #67: Feedback trail computation
// ===========================================================================

export const getFeedbackTrail = query({
  args: { versionId: v.id("promptVersions") },
  handler: async (ctx, args) => {
    const version = await ctx.db.get(args.versionId);
    if (!version) throw new Error("Version not found");

    await requireProjectRole(ctx, version.projectId, ["owner", "editor"]);

    // Get all cycles for this version, sorted by creation time
    const cycles = await ctx.db
      .query("reviewCycles")
      .withIndex("by_primary_version", (q) =>
        q.eq("primaryVersionId", args.versionId),
      )
      .take(100);

    const closedCycles = cycles
      .filter((c) => c.status === "closed" && c.closedAt)
      .sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0));

    if (closedCycles.length < 2) return { trail: [] };

    // Build per-cycle theme maps
    const cycleThemes: Map<string, Record<string, number>> = new Map();

    for (const cycle of closedCycles) {
      const outputs = await ctx.db
        .query("cycleOutputs")
        .withIndex("by_cycle", (q) => q.eq("cycleId", cycle._id))
        .take(26);
      const versionOutputs = outputs.filter(
        (o) => o.sourceVersionId === args.versionId,
      );

      const tagCounts: Record<string, number> = {};
      for (const output of versionOutputs) {
        const feedback = await ctx.db
          .query("cycleFeedback")
          .withIndex("by_cycle_output", (q) =>
            q.eq("cycleOutputId", output._id),
          )
          .take(200);
        for (const fb of feedback) {
          if (fb.tags) {
            for (const tag of fb.tags) {
              tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
            }
          }
        }
      }
      cycleThemes.set(cycle._id, tagCounts);
    }

    // Build trail transitions
    const trail = [];
    for (let i = 0; i < closedCycles.length - 1; i++) {
      const fromCycle = closedCycles[i]!;
      const toCycle = closedCycles[i + 1]!;
      const fromThemes = cycleThemes.get(fromCycle._id) ?? {};
      const toThemes = cycleThemes.get(toCycle._id) ?? {};

      const allTags = new Set([
        ...Object.keys(fromThemes),
        ...Object.keys(toThemes),
      ]);

      const resolved: Array<{
        tag: string;
        fromCount: number;
        toCount: number;
      }> = [];
      const persistent: Array<{
        tag: string;
        fromCount: number;
        toCount: number;
      }> = [];
      const newThemes: Array<{ tag: string; count: number }> = [];

      for (const tag of allTags) {
        const fromCount = fromThemes[tag] ?? 0;
        const toCount = toThemes[tag] ?? 0;

        if (fromCount > 0 && toCount === 0) {
          resolved.push({ tag, fromCount, toCount });
        } else if (fromCount > 0 && toCount < fromCount * 0.5) {
          resolved.push({ tag, fromCount, toCount });
        } else if (fromCount === 0 && toCount > 0) {
          newThemes.push({ tag, count: toCount });
        } else {
          persistent.push({ tag, fromCount, toCount });
        }
      }

      // Look up resulting version
      let resultingVersionNumber: number | null = null;
      if (fromCycle.resultingVersionId) {
        const rv = await ctx.db.get(fromCycle.resultingVersionId);
        resultingVersionNumber = rv?.versionNumber ?? null;
      }

      trail.push({
        fromCycle: {
          cycleId: fromCycle._id,
          name: fromCycle.name,
          closedAt: fromCycle.closedAt,
        },
        toCycle: {
          cycleId: toCycle._id,
          name: toCycle.name,
          openedAt: toCycle.openedAt,
        },
        actionTaken: fromCycle.closedAction ?? null,
        resultingVersionNumber,
        resolved,
        persistent,
        new: newThemes,
      });
    }

    return { trail };
  },
});

// ===========================================================================
// #69: Solo eval integration
// ===========================================================================

export const toggleSoloEval = mutation({
  args: {
    cycleId: v.id("reviewCycles"),
    includeSoloEval: v.boolean(),
  },
  handler: async (ctx, args) => {
    const cycle = await ctx.db.get(args.cycleId);
    if (!cycle) throw new Error("Cycle not found");

    const { userId } = await requireProjectRole(ctx, cycle.projectId, [
      "owner",
      "editor",
    ]);

    await ctx.db.patch(args.cycleId, {
      includeSoloEval: args.includeSoloEval,
    });

    if (args.includeSoloEval) {
      // Import matching solo eval preferences as cyclePreferences
      const cycleOutputs = await ctx.db
        .query("cycleOutputs")
        .withIndex("by_cycle", (q) => q.eq("cycleId", args.cycleId))
        .take(26);

      let importedCount = 0;
      for (const co of cycleOutputs) {
        // Find outputPreferences for this source output by the cycle creator
        const prefs = await ctx.db
          .query("outputPreferences")
          .withIndex("by_output", (q) =>
            q.eq("outputId", co.sourceOutputId),
          )
          .take(50);

        const soloPrefs = prefs.filter((p) => p.userId === userId);

        for (const pref of soloPrefs) {
          // Check if already imported
          const existing = await ctx.db
            .query("cyclePreferences")
            .withIndex("by_cycle_output", (q) =>
              q.eq("cycleOutputId", co._id),
            )
            .take(100);
          const alreadyExists = existing.some(
            (e) => e.source === "solo" && e.userId === userId,
          );
          if (alreadyExists) continue;

          await ctx.db.insert("cyclePreferences", {
            cycleId: args.cycleId,
            cycleOutputId: co._id,
            userId,
            rating: pref.rating,
            source: "solo",
          });
          importedCount++;
        }
      }

      return { importedCount };
    } else {
      // Remove imported solo preferences
      const soloPrefs = await ctx.db
        .query("cyclePreferences")
        .withIndex("by_cycle_and_source", (q) =>
          q.eq("cycleId", args.cycleId).eq("source", "solo"),
        )
        .take(200);

      for (const pref of soloPrefs) {
        await ctx.db.delete(pref._id);
      }

      return { importedCount: 0 };
    }
  },
});

// ===========================================================================
// #70: Retroactive migration — wrap existing runs into closed cycles
// ===========================================================================

export const createFromExistingRun = mutation({
  args: { runId: v.id("promptRuns") },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run) throw new Error("Run not found");
    if (run.status !== "completed") {
      throw new Error("Run must be completed");
    }

    const { userId } = await requireProjectRole(ctx, run.projectId, [
      "owner",
      "editor",
    ]);

    // Check if already migrated
    const outputs = await ctx.db
      .query("runOutputs")
      .withIndex("by_run", (q) => q.eq("runId", args.runId))
      .take(10);

    for (const output of outputs) {
      const existing = await ctx.db
        .query("cycleOutputs")
        .withIndex("by_source_output", (q) =>
          q.eq("sourceOutputId", output._id),
        )
        .take(1);
      if (existing.length > 0) {
        throw new Error("This run has already been imported into a cycle");
      }
    }

    const version = await ctx.db.get(run.promptVersionId);

    // Create a closed cycle
    const cycleId = await ctx.db.insert("reviewCycles", {
      projectId: run.projectId,
      primaryVersionId: run.promptVersionId,
      name: `Legacy — v${version?.versionNumber ?? "?"}`,
      status: "closed",
      includeSoloEval: false,
      createdById: userId,
      closedAt: run.completedAt ?? run._creationTime,
    });

    // Pool run outputs (use original blind labels since this is closed)
    for (const output of outputs) {
      await ctx.db.insert("cycleOutputs", {
        cycleId,
        sourceOutputId: output._id,
        sourceRunId: args.runId,
        sourceVersionId: run.promptVersionId,
        cycleBlindLabel: output.blindLabel,
        outputContentSnapshot: output.outputContent,
      });
    }

    // Import existing outputPreferences as cyclePreferences
    const allPrefs = await ctx.db
      .query("outputPreferences")
      .withIndex("by_run", (q) => q.eq("runId", args.runId))
      .take(200);

    for (const pref of allPrefs) {
      // Find the corresponding cycleOutput
      const co = await ctx.db
        .query("cycleOutputs")
        .withIndex("by_source_output", (q) =>
          q.eq("sourceOutputId", pref.outputId),
        )
        .unique();
      if (!co) continue;

      // Determine source based on user's role
      const collab = await ctx.db
        .query("projectCollaborators")
        .withIndex("by_project_and_user", (q) =>
          q.eq("projectId", run.projectId).eq("userId", pref.userId),
        )
        .unique();
      const source =
        collab?.role === "evaluator" ? "evaluator" : "author";

      await ctx.db.insert("cyclePreferences", {
        cycleId,
        cycleOutputId: co._id,
        userId: pref.userId,
        rating: pref.rating,
        source: source as "evaluator" | "author",
      });
    }

    // Import outputFeedback as cycleFeedback
    for (const output of outputs) {
      const feedback = await ctx.db
        .query("outputFeedback")
        .withIndex("by_output", (q) => q.eq("outputId", output._id))
        .take(200);

      const co = await ctx.db
        .query("cycleOutputs")
        .withIndex("by_source_output", (q) =>
          q.eq("sourceOutputId", output._id),
        )
        .unique();
      if (!co) continue;

      for (const fb of feedback) {
        const collab = await ctx.db
          .query("projectCollaborators")
          .withIndex("by_project_and_user", (q) =>
            q.eq("projectId", run.projectId).eq("userId", fb.userId),
          )
          .unique();
        const source =
          collab?.role === "evaluator" ? "evaluator" : "author";

        await ctx.db.insert("cycleFeedback", {
          cycleId,
          cycleOutputId: co._id,
          userId: fb.userId,
          annotationData: fb.annotationData,
          tags: fb.tags,
          source: source as "evaluator" | "author",
        });
      }
    }

    return { cycleId };
  },
});

// ===========================================================================
// Pre-validation: check available runs for output pooling
// ===========================================================================

export const getAvailableRunsForPooling = query({
  args: {
    projectId: v.id("projects"),
    primaryVersionId: v.id("promptVersions"),
    controlVersionId: v.optional(v.id("promptVersions")),
  },
  handler: async (ctx, args) => {
    await requireProjectRole(ctx, args.projectId, ["owner", "editor"]);

    const versionIds: Id<"promptVersions">[] = [args.primaryVersionId];
    if (args.controlVersionId) {
      versionIds.push(args.controlVersionId);
    }

    const versionRuns: Array<{
      versionId: Id<"promptVersions">;
      versionNumber: number | null;
      completedRunCount: number;
      totalOutputCount: number;
    }> = [];

    for (const versionId of versionIds) {
      const version = await ctx.db.get(versionId);

      const runs = await ctx.db
        .query("promptRuns")
        .withIndex("by_version", (q) =>
          q.eq("promptVersionId", versionId),
        )
        .take(200);

      const completedRuns = runs.filter((r) => r.status === "completed");

      let totalOutputs = 0;
      for (const run of completedRuns) {
        const outputs = await ctx.db
          .query("runOutputs")
          .withIndex("by_run", (q) => q.eq("runId", run._id))
          .take(10);
        totalOutputs += outputs.length;
      }

      versionRuns.push({
        versionId,
        versionNumber: version?.versionNumber ?? null,
        completedRunCount: completedRuns.length,
        totalOutputCount: totalOutputs,
      });
    }

    return {
      versionRuns,
      totalCompletedRuns: versionRuns.reduce(
        (sum, v) => sum + v.completedRunCount,
        0,
      ),
      totalOutputs: versionRuns.reduce(
        (sum, v) => sum + v.totalOutputCount,
        0,
      ),
    };
  },
});

// ===========================================================================
// Evaluator inbox: list pending/in-progress cycles for the current user
// ===========================================================================

export const listMyCyclesToEvaluate = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireAuth(ctx);

    const assignments = await ctx.db
      .query("cycleEvaluators")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(100);

    const pendingOrInProgress = assignments.filter(
      (a) => a.status === "pending" || a.status === "in_progress",
    );

    const result = [];
    for (const assignment of pendingOrInProgress) {
      const cycle = await ctx.db.get(assignment.cycleId);
      if (!cycle || cycle.status !== "open") continue;

      const project = await ctx.db.get(cycle.projectId);

      // Get the eval token
      const tokenDoc = await ctx.db
        .query("cycleEvalTokens")
        .withIndex("by_cycle", (q) => q.eq("cycleId", cycle._id))
        .take(1);

      if (!tokenDoc[0]) continue;

      const outputCount = (
        await ctx.db
          .query("cycleOutputs")
          .withIndex("by_cycle", (q) => q.eq("cycleId", cycle._id))
          .take(26)
      ).length;

      // Count rated outputs
      const ratings = await ctx.db
        .query("cyclePreferences")
        .withIndex("by_cycle_user", (q) =>
          q.eq("cycleId", cycle._id).eq("userId", userId),
        )
        .take(26);
      const ratedCount = ratings.filter(
        (r) => r.source === "evaluator",
      ).length;

      result.push({
        cycleId: cycle._id,
        cycleName: cycle.name,
        projectName: project?.name ?? "Unknown",
        cycleEvalToken: tokenDoc[0].token,
        outputCount,
        ratedCount,
        assignedAt: assignment.assignedAt,
        status: assignment.status,
      });
    }

    return result.sort((a, b) => b.assignedAt - a.assignedAt);
  },
});

// ===========================================================================
// #63: Count open cycles for a project (used for ProjectTabs badge)
// ===========================================================================

export const countOpenForProject = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    await requireProjectRole(ctx, args.projectId, ["owner", "editor"]);

    const openCycles = await ctx.db
      .query("reviewCycles")
      .withIndex("by_project_and_status", (q) =>
        q.eq("projectId", args.projectId).eq("status", "open"),
      )
      .take(100);

    return { count: openCycles.length };
  },
});

// ===========================================================================
// #71: Check if a version has completed runs and/or cycles (for VersionEditor CTAs)
// ===========================================================================

export const hasDataForVersion = query({
  args: { versionId: v.id("promptVersions") },
  handler: async (ctx, args) => {
    const version = await ctx.db.get(args.versionId);
    if (!version) return { hasCompletedRun: false, hasCycle: false };

    await requireProjectRole(ctx, version.projectId, ["owner", "editor"]);

    const completedRuns = await ctx.db
      .query("promptRuns")
      .withIndex("by_version", (q) =>
        q.eq("promptVersionId", args.versionId),
      )
      .take(200);
    const hasCompletedRun = completedRuns.some((r) => r.status === "completed");

    const cycles = await ctx.db
      .query("reviewCycles")
      .withIndex("by_primary_version", (q) =>
        q.eq("primaryVersionId", args.versionId),
      )
      .take(1);
    const hasCycle = cycles.length > 0;

    return { hasCompletedRun, hasCycle };
  },
});

// ===========================================================================
// #70: Retroactive migration — count and batch-migrate existing runs
// ===========================================================================

export const countMigratableRuns = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    await requireProjectRole(ctx, args.projectId, ["owner"]);

    const runs = await ctx.db
      .query("promptRuns")
      .withIndex("by_project_and_status", (q) =>
        q.eq("projectId", args.projectId).eq("status", "completed"),
      )
      .take(500);

    let count = 0;
    for (const run of runs) {
      // Check if already migrated via first output
      const outputs = await ctx.db
        .query("runOutputs")
        .withIndex("by_run", (q) => q.eq("runId", run._id))
        .take(1);
      if (outputs.length === 0) continue;
      const firstOutput = outputs[0]!;

      const existing = await ctx.db
        .query("cycleOutputs")
        .withIndex("by_source_output", (q) =>
          q.eq("sourceOutputId", firstOutput._id),
        )
        .take(1);
      if (existing.length === 0) count++;
    }

    return { count };
  },
});

export const startMigrateAllRuns = mutation({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const { userId } = await requireProjectRole(ctx, args.projectId, [
      "owner",
    ]);

    // Collect eligible run IDs
    const runs = await ctx.db
      .query("promptRuns")
      .withIndex("by_project_and_status", (q) =>
        q.eq("projectId", args.projectId).eq("status", "completed"),
      )
      .take(500);

    const eligibleRunIds: Id<"promptRuns">[] = [];
    for (const run of runs) {
      const outputs = await ctx.db
        .query("runOutputs")
        .withIndex("by_run", (q) => q.eq("runId", run._id))
        .take(1);
      if (outputs.length === 0) continue;
      const firstOutput = outputs[0]!;

      const existing = await ctx.db
        .query("cycleOutputs")
        .withIndex("by_source_output", (q) =>
          q.eq("sourceOutputId", firstOutput._id),
        )
        .take(1);
      if (existing.length === 0) eligibleRunIds.push(run._id);
    }

    if (eligibleRunIds.length === 0) {
      return { eligibleCount: 0 };
    }

    // Schedule the internal mutation to process in batches
    await ctx.scheduler.runAfter(
      0,
      internal.reviewCycles.migrateRunsBatch,
      { runIds: eligibleRunIds, projectId: args.projectId, userId },
    );

    return { eligibleCount: eligibleRunIds.length };
  },
});

export const migrateRunsBatch = internalMutation({
  args: {
    runIds: v.array(v.id("promptRuns")),
    projectId: v.id("projects"),
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    for (const runId of args.runIds) {
      const run = await ctx.db.get(runId);
      if (!run || run.status !== "completed") continue;

      // Check not already migrated
      const outputs = await ctx.db
        .query("runOutputs")
        .withIndex("by_run", (q) => q.eq("runId", runId))
        .take(10);
      if (outputs.length === 0) continue;
      const firstOutput = outputs[0]!;

      const existing = await ctx.db
        .query("cycleOutputs")
        .withIndex("by_source_output", (q) =>
          q.eq("sourceOutputId", firstOutput._id),
        )
        .take(1);
      if (existing.length > 0) continue;

      const version = await ctx.db.get(run.promptVersionId);

      // Create closed cycle
      const cycleId = await ctx.db.insert("reviewCycles", {
        projectId: args.projectId,
        primaryVersionId: run.promptVersionId,
        name: `Legacy — v${version?.versionNumber ?? "?"}`,
        status: "closed",
        includeSoloEval: false,
        createdById: args.userId,
        closedAt: run.completedAt ?? run._creationTime,
      });

      // Pool outputs
      for (const output of outputs) {
        await ctx.db.insert("cycleOutputs", {
          cycleId,
          sourceOutputId: output._id,
          sourceRunId: runId,
          sourceVersionId: run.promptVersionId,
          cycleBlindLabel: output.blindLabel,
          outputContentSnapshot: output.outputContent,
        });
      }

      // Import preferences
      const allPrefs = await ctx.db
        .query("outputPreferences")
        .withIndex("by_run", (q) => q.eq("runId", runId))
        .take(200);

      for (const pref of allPrefs) {
        const co = await ctx.db
          .query("cycleOutputs")
          .withIndex("by_source_output", (q) =>
            q.eq("sourceOutputId", pref.outputId),
          )
          .unique();
        if (!co) continue;

        const collab = await ctx.db
          .query("projectCollaborators")
          .withIndex("by_project_and_user", (q) =>
            q.eq("projectId", args.projectId).eq("userId", pref.userId),
          )
          .unique();
        const source = collab?.role === "evaluator" ? "evaluator" : "author";

        await ctx.db.insert("cyclePreferences", {
          cycleId,
          cycleOutputId: co._id,
          userId: pref.userId,
          rating: pref.rating,
          source: source as "evaluator" | "author",
        });
      }

      // Import feedback
      for (const output of outputs) {
        const feedback = await ctx.db
          .query("outputFeedback")
          .withIndex("by_output", (q) => q.eq("outputId", output._id))
          .take(200);

        const co = await ctx.db
          .query("cycleOutputs")
          .withIndex("by_source_output", (q) =>
            q.eq("sourceOutputId", output._id),
          )
          .unique();
        if (!co) continue;

        for (const fb of feedback) {
          const collab = await ctx.db
            .query("projectCollaborators")
            .withIndex("by_project_and_user", (q) =>
              q.eq("projectId", args.projectId).eq("userId", fb.userId),
            )
            .unique();
          const source = collab?.role === "evaluator" ? "evaluator" : "author";

          await ctx.db.insert("cycleFeedback", {
            cycleId,
            cycleOutputId: co._id,
            userId: fb.userId,
            annotationData: fb.annotationData,
            tags: [],
            source: source as "evaluator" | "author",
          });
        }
      }
    }
  },
});
