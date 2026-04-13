import { v } from "convex/values";
import {
  mutation,
  query,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { requireProjectRole } from "./lib/auth";
import { resolveEvalToken, mintEvalToken } from "./lib/evalTokens";

const CONCURRENT_CAP = 10;
const BLIND_LABELS = ["A", "B", "C"];

export const execute = mutation({
  args: {
    versionId: v.id("promptVersions"),
    testCaseId: v.id("testCases"),
    model: v.string(),
    temperature: v.number(),
    maxTokens: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const version = await ctx.db.get(args.versionId);
    if (!version) throw new Error("Version not found");

    const { userId } = await requireProjectRole(ctx, version.projectId, [
      "owner",
      "editor",
    ]);

    // Verify test case belongs to same project
    const testCase = await ctx.db.get(args.testCaseId);
    if (!testCase || testCase.projectId !== version.projectId) {
      throw new Error("Test case not found");
    }

    // Enforce concurrent run cap
    const pending = await ctx.db
      .query("promptRuns")
      .withIndex("by_project_and_status", (q) =>
        q.eq("projectId", version.projectId).eq("status", "pending"),
      )
      .take(11);
    const running = await ctx.db
      .query("promptRuns")
      .withIndex("by_project_and_status", (q) =>
        q.eq("projectId", version.projectId).eq("status", "running"),
      )
      .take(11);

    if (pending.length + running.length >= CONCURRENT_CAP) {
      throw new Error(
        "10 runs in flight. Wait for one to finish before starting another.",
      );
    }

    // Create run
    const runId = await ctx.db.insert("promptRuns", {
      projectId: version.projectId,
      promptVersionId: args.versionId,
      testCaseId: args.testCaseId,
      model: args.model,
      temperature: args.temperature,
      maxTokens: args.maxTokens,
      status: "pending",
      triggeredById: userId,
    });

    // Create empty output rows
    const outputIds = [];
    for (const label of BLIND_LABELS) {
      const outputId = await ctx.db.insert("runOutputs", {
        runId,
        blindLabel: label,
        outputContent: "",
      });
      outputIds.push(outputId);
    }

    // Schedule the streaming action
    await ctx.scheduler.runAfter(
      0,
      internal.runsActions.executeRunAction,
      { runId, outputIds },
    );

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
    const testCase = await ctx.db.get(run.testCaseId);
    const trigger = await ctx.db.get(run.triggeredById);

    return {
      ...run,
      outputs: outputs.sort((a, b) => a.blindLabel.localeCompare(b.blindLabel)),
      versionNumber: version?.versionNumber ?? null,
      testCaseName: testCase?.name ?? null,
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

// --- Evaluator-facing query (SECURITY BOUNDARY) ---

export const getOutputsForEvaluator = query({
  args: { opaqueToken: v.string() },
  handler: async (ctx, args) => {
    const resolved = await resolveEvalToken(ctx, args.opaqueToken);
    if (!resolved) throw new Error("Invalid eval token");

    await requireProjectRole(ctx, resolved.projectId, ["evaluator"]);

    const run = await ctx.db.get(resolved.runId);
    if (!run || run.status !== "completed") {
      throw new Error("Run not available");
    }

    const project = await ctx.db.get(resolved.projectId);

    const outputs = await ctx.db
      .query("runOutputs")
      .withIndex("by_run", (q) => q.eq("runId", resolved.runId))
      .take(10);

    const result = [];
    for (const output of outputs) {
      const feedback = await ctx.db
        .query("outputFeedback")
        .withIndex("by_output", (q) => q.eq("outputId", output._id))
        .take(200);

      result.push({
        blindLabel: output.blindLabel,
        outputContent: output.outputContent,
        annotations: feedback.map((fb) => ({
          from: fb.annotationData.from,
          to: fb.annotationData.to,
          highlightedText: fb.annotationData.highlightedText,
          comment: fb.annotationData.comment,
          createdAt: fb._creationTime,
        })),
      });
    }

    // SECURITY: Return ONLY blindLabel, outputContent, annotations + project name
    // No _id, runId, versionId, promptTokens, latencyMs, model, temperature
    return {
      projectName: project?.name ?? "Unknown",
      outputs: result.sort((a, b) => a.blindLabel.localeCompare(b.blindLabel)),
    };
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

    const testCase = await ctx.db.get(run.testCaseId);
    if (!testCase) throw new Error("Test case not found");

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
      testCase,
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

    // Mint eval token when run completes so evaluators can access it
    if (args.status === "completed") {
      const run = await ctx.db.get(args.runId);
      if (run) {
        await mintEvalToken(ctx, args.runId, run.projectId);
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
