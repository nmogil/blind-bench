import { v } from "convex/values";
import {
  mutation,
  query,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { requireProjectRole } from "./lib/auth";
import { executeRunCore, CONCURRENT_RUN_CAP } from "./lib/runsCore";

const CONCURRENT_CAP = CONCURRENT_RUN_CAP;

export const execute = mutation({
  args: {
    versionId: v.id("promptVersions"),
    testCaseId: v.optional(v.id("testCases")),
    // M12: Quick run — inline variable values when no test case
    inlineVariables: v.optional(v.record(v.string(), v.string())),
    model: v.string(),
    temperature: v.number(),
    maxTokens: v.optional(v.number()),
    // M8: per-slot configuration
    mode: v.optional(v.union(v.literal("uniform"), v.literal("mix"))),
    slotConfigs: v.optional(
      v.array(
        v.object({
          label: v.string(),
          model: v.string(),
          temperature: v.number(),
        }),
      ),
    ),
  },
  handler: async (ctx, args) => {
    const version = await ctx.db.get(args.versionId);
    if (!version) throw new Error("Version not found");

    const { userId } = await requireProjectRole(ctx, version.projectId, [
      "owner",
      "editor",
    ]);

    const runId = await executeRunCore(ctx, { ...args, userId });

    await ctx.scheduler.runAfter(0, internal.analyticsActions.track, {
      event: "run executed",
      distinctId: userId as string,
      properties: {
        run_id: runId as string,
        project_id: version.projectId as string,
        model: args.model,
        mode: args.mode === "mix" ? "mix" : "uniform",
        slot_count: args.mode === "mix" ? args.slotConfigs?.length ?? 0 : 3,
        has_test_case: !!args.testCaseId,
      },
    });

    return runId;
  },
});

export const list = query({
  args: { versionId: v.id("promptVersions") },
  handler: async (ctx, args) => {
    const version = await ctx.db.get(args.versionId);
    if (!version) return [];

    await requireProjectRole(ctx, version.projectId, ["owner", "editor"]);

    const runs = await ctx.db
      .query("promptRuns")
      .withIndex("by_version", (q) =>
        q.eq("promptVersionId", args.versionId),
      )
      .take(50);

    // Enrich with trigger user info
    const enriched = [];
    for (const run of runs) {
      const trigger = await ctx.db.get(run.triggeredById);
      enriched.push({
        ...run,
        triggeredByName: trigger?.name ?? null,
      });
    }

    return enriched.sort(
      (a, b) => (b._creationTime ?? 0) - (a._creationTime ?? 0),
    );
  },
});

export const get = query({
  args: { runId: v.id("promptRuns") },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run) return null;

    await requireProjectRole(ctx, run.projectId, ["owner", "editor"]);

    const outputs = await ctx.db
      .query("runOutputs")
      .withIndex("by_run", (q) => q.eq("runId", args.runId))
      .take(10);

    const version = await ctx.db.get(run.promptVersionId);
    const testCase = run.testCaseId
      ? await ctx.db.get(run.testCaseId)
      : null;
    const trigger = await ctx.db.get(run.triggeredById);

    return {
      ...run,
      outputs: outputs.sort((a, b) => a.blindLabel.localeCompare(b.blindLabel)),
      versionNumber: version?.versionNumber ?? null,
      testCaseName: testCase?.name ?? null,
      isQuickRun: !run.testCaseId,
      inlineVariables: run.inlineVariables ?? null,
      triggeredByName: trigger?.name ?? null,
    };
  },
});

export const countInFlightRuns = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    await requireProjectRole(ctx, args.projectId, ["owner", "editor"]);

    const pending = await ctx.db
      .query("promptRuns")
      .withIndex("by_project_and_status", (q) =>
        q.eq("projectId", args.projectId).eq("status", "pending"),
      )
      .take(11);
    const running = await ctx.db
      .query("promptRuns")
      .withIndex("by_project_and_status", (q) =>
        q.eq("projectId", args.projectId).eq("status", "running"),
      )
      .take(11);

    return { inFlight: pending.length + running.length, cap: CONCURRENT_CAP };
  },
});

// --- Cross-version comparison (M6) ---

export const compareAcrossVersions = query({
  args: {
    projectId: v.id("projects"),
    testCaseId: v.id("testCases"),
    versionIds: v.array(v.id("promptVersions")),
  },
  handler: async (ctx, args) => {
    await requireProjectRole(ctx, args.projectId, ["owner", "editor"]);

    if (args.versionIds.length < 2 || args.versionIds.length > 5) {
      throw new Error("Select between 2 and 5 versions to compare");
    }

    const testCase = await ctx.db.get(args.testCaseId);
    if (!testCase || testCase.projectId !== args.projectId) {
      throw new Error("Test case not found");
    }

    const results = [];
    for (const versionId of args.versionIds) {
      const version = await ctx.db.get(versionId);
      if (!version || version.projectId !== args.projectId) continue;

      // Find runs for this (version, testCase) pair
      const runs = await ctx.db
        .query("promptRuns")
        .withIndex("by_version_testcase", (q) =>
          q.eq("promptVersionId", versionId).eq("testCaseId", args.testCaseId),
        )
        .take(10);

      // Prefer active (pending/running) run, then most recent completed
      const activeRun =
        runs.find((r) => r.status === "pending" || r.status === "running") ??
        null;
      const completedRuns = runs
        .filter((r) => r.status === "completed")
        .sort((a, b) => (b._creationTime ?? 0) - (a._creationTime ?? 0));
      const latestCompleted = completedRuns[0] ?? null;

      const runToShow = activeRun ?? latestCompleted;

      let outputs: Array<{
        _id: string;
        runId: string;
        blindLabel: string;
        outputContent: string;
        model?: string;
        temperature?: number;
        promptTokens?: number;
        completionTokens?: number;
        totalTokens?: number;
        latencyMs?: number;
      }> = [];
      if (runToShow) {
        const rawOutputs = await ctx.db
          .query("runOutputs")
          .withIndex("by_run", (q) => q.eq("runId", runToShow._id))
          .take(10);
        outputs = rawOutputs
          .map((o) => ({
            _id: o._id as string,
            runId: o.runId as string,
            blindLabel: o.blindLabel,
            outputContent: o.outputContent,
            model: o.model,
            temperature: o.temperature,
            promptTokens: o.promptTokens,
            completionTokens: o.completionTokens,
            totalTokens: o.totalTokens,
            latencyMs: o.latencyMs,
          }))
          .sort((a, b) => a.blindLabel.localeCompare(b.blindLabel));
      }

      results.push({
        versionId: versionId as string,
        versionNumber: version.versionNumber,
        versionStatus: version.status,
        sourceVersionId: version.sourceVersionId
          ? (version.sourceVersionId as string)
          : null,
        run: runToShow
          ? {
              _id: runToShow._id as string,
              status: runToShow.status,
              model: runToShow.model,
              temperature: runToShow.temperature,
              mode: runToShow.mode ?? undefined,
              _creationTime: runToShow._creationTime,
            }
          : null,
        outputs,
        hasCompletedRun: latestCompleted !== null,
      });
    }

    return results;
  },
});

// --- Internal functions (called by the streaming action) ---

export const getRunContext = internalQuery({
  args: { runId: v.id("promptRuns") },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run) throw new Error("Run not found");

    const version = await ctx.db.get(run.promptVersionId);
    if (!version) throw new Error("Version not found");

    // Quick run: no test case — use inline variables
    const testCase = run.testCaseId
      ? await ctx.db.get(run.testCaseId)
      : null;
    if (run.testCaseId && !testCase) throw new Error("Test case not found");

    // Construct a synthetic test case shape for quick runs
    const effectiveTestCase = testCase ?? {
      variableValues: (run.inlineVariables ?? {}) as Record<string, string>,
      attachmentIds: [] as Array<import("./_generated/dataModel").Id<"_storage">>,
    };

    const project = await ctx.db.get(version.projectId);
    if (!project) throw new Error("Project not found");

    const variables = await ctx.db
      .query("projectVariables")
      .withIndex("by_project", (q) => q.eq("projectId", version.projectId))
      .take(200);

    // Load prompt attachments
    const promptAttachments = await ctx.db
      .query("promptAttachments")
      .withIndex("by_version", (q) =>
        q.eq("promptVersionId", run.promptVersionId),
      )
      .take(50);

    return {
      run,
      version,
      testCase: effectiveTestCase,
      project,
      variables,
      promptAttachments,
      organizationId: project.organizationId,
    };
  },
});

export const appendOutputChunk = internalMutation({
  args: {
    outputId: v.id("runOutputs"),
    chunk: v.string(),
  },
  handler: async (ctx, args) => {
    const output = await ctx.db.get(args.outputId);
    if (!output) return;
    await ctx.db.patch(args.outputId, {
      outputContent: output.outputContent + args.chunk,
    });
  },
});

export const updateRunStatus = internalMutation({
  args: {
    runId: v.id("promptRuns"),
    status: v.union(
      v.literal("running"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    errorMessage: v.optional(v.string()),
    startedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const updates: Record<string, unknown> = { status: args.status };
    if (args.errorMessage !== undefined) updates.errorMessage = args.errorMessage;
    if (args.startedAt !== undefined) updates.startedAt = args.startedAt;
    if (args.completedAt !== undefined) updates.completedAt = args.completedAt;
    await ctx.db.patch(args.runId, updates);

    // Auto-trigger post-run insights for mix-mode runs
    if (args.status === "completed") {
      const run = await ctx.db.get(args.runId);
      if (run && run.mode === "mix") {
        const insightId = await ctx.db.insert("runInsights", {
          runId: args.runId,
          projectId: run.projectId,
          status: "pending",
        });
        await ctx.scheduler.runAfter(
          0,
          internal.runInsightsActions.generateInsightsAction,
          { insightId, runId: args.runId },
        );
      }
    }
  },
});

export const finalizeOutput = internalMutation({
  args: {
    outputId: v.id("runOutputs"),
    promptTokens: v.optional(v.number()),
    completionTokens: v.optional(v.number()),
    totalTokens: v.optional(v.number()),
    latencyMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { outputId, ...stats } = args;
    await ctx.db.patch(outputId, stats);
  },
});
