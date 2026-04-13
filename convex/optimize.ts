import { v } from "convex/values";
import {
  mutation,
  query,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { requireProjectRole } from "./lib/auth";
import { validateTemplate } from "./lib/templateValidation";
import { getOptimizerPromptVersion } from "./lib/optimizerPrompt";

const OPTIMIZER_MODEL = "anthropic/claude-sonnet-4";

// --- Public mutations ---

export const requestOptimization = mutation({
  args: { versionId: v.id("promptVersions") },
  handler: async (ctx, args) => {
    const version = await ctx.db.get(args.versionId);
    if (!version) throw new Error("Version not found");

    const { userId } = await requireProjectRole(ctx, version.projectId, [
      "owner",
      "editor",
    ]);

    // 1-in-flight-per-project cap
    const pendingOpts = await ctx.db
      .query("optimizationRequests")
      .withIndex("by_project_and_status", (q) =>
        q.eq("projectId", version.projectId).eq("status", "pending"),
      )
      .take(1);
    const processingOpts = await ctx.db
      .query("optimizationRequests")
      .withIndex("by_project_and_status", (q) =>
        q.eq("projectId", version.projectId).eq("status", "processing"),
      )
      .take(1);

    if (pendingOpts.length > 0 || processingOpts.length > 0) {
      throw new Error("An optimization is already in progress for this project.");
    }

    // Check that feedback exists (annotations, preferences, or run comments)
    const promptFb = await ctx.db
      .query("promptFeedback")
      .withIndex("by_version", (q) =>
        q.eq("promptVersionId", args.versionId),
      )
      .take(1);

    // For output feedback + preferences + comments, check runs for this version
    const runs = await ctx.db
      .query("promptRuns")
      .withIndex("by_version", (q) =>
        q.eq("promptVersionId", args.versionId),
      )
      .take(200);

    let hasFeedback = promptFb.length > 0;
    for (const run of runs) {
      if (hasFeedback) break;

      // Check output annotations
      const outputs = await ctx.db
        .query("runOutputs")
        .withIndex("by_run", (q) => q.eq("runId", run._id))
        .take(10);
      for (const output of outputs) {
        if (hasFeedback) break;
        const fb = await ctx.db
          .query("outputFeedback")
          .withIndex("by_output", (q) => q.eq("outputId", output._id))
          .take(1);
        if (fb.length > 0) { hasFeedback = true; break; }
      }

      // Check preference ratings
      if (!hasFeedback) {
        const prefs = await ctx.db
          .query("outputPreferences")
          .withIndex("by_run", (q) => q.eq("runId", run._id))
          .take(1);
        if (prefs.length > 0) hasFeedback = true;
      }

      // Check run comments
      if (!hasFeedback) {
        const comments = await ctx.db
          .query("runComments")
          .withIndex("by_run", (q) => q.eq("runId", run._id))
          .take(1);
        if (comments.length > 0) hasFeedback = true;
      }
    }

    if (!hasFeedback) {
      throw new Error("No feedback to optimize from. Add feedback first.");
    }

    // Create the optimization request
    const requestId = await ctx.db.insert("optimizationRequests", {
      projectId: version.projectId,
      promptVersionId: args.versionId,
      status: "pending",
      optimizerModel: OPTIMIZER_MODEL,
      optimizerPromptVersion: getOptimizerPromptVersion(),
      requestedById: userId,
    });

    // Schedule the optimizer action
    await ctx.scheduler.runAfter(
      0,
      internal.optimizeActions.runOptimizerAction,
      { requestId },
    );

    return requestId;
  },
});

export const cancelOptimization = mutation({
  args: { requestId: v.id("optimizationRequests") },
  handler: async (ctx, args) => {
    const request = await ctx.db.get(args.requestId);
    if (!request) throw new Error("Optimization request not found");

    await requireProjectRole(ctx, request.projectId, ["owner", "editor"]);

    if (request.status !== "pending") {
      throw new Error("Cannot cancel a running optimization.");
    }

    await ctx.db.patch(args.requestId, {
      status: "failed",
      errorMessage: "Cancelled by user.",
    });
  },
});

export const acceptOptimization = mutation({
  args: { requestId: v.id("optimizationRequests") },
  handler: async (ctx, args) => {
    const request = await ctx.db.get(args.requestId);
    if (!request) throw new Error("Optimization request not found");

    const { userId } = await requireProjectRole(ctx, request.projectId, [
      "owner",
      "editor",
    ]);

    if (request.status !== "completed" || request.reviewStatus !== "pending") {
      throw new Error("This optimization is not awaiting review.");
    }

    if (!request.generatedUserTemplate) {
      throw new Error("No generated content to accept.");
    }

    // Validate templates before creating the version
    const variables = await ctx.db
      .query("projectVariables")
      .withIndex("by_project", (q) => q.eq("projectId", request.projectId))
      .take(200);
    const variableNames = variables.map((v) => v.name);

    validateTemplate(request.generatedUserTemplate, variableNames);
    if (request.generatedSystemMessage) {
      validateTemplate(request.generatedSystemMessage, variableNames);
    }

    // Compute next version number
    const existing = await ctx.db
      .query("promptVersions")
      .withIndex("by_project", (q) => q.eq("projectId", request.projectId))
      .take(200);
    const maxVersion = existing.reduce(
      (max, v) => Math.max(max, v.versionNumber),
      0,
    );

    const newVersionId = await ctx.db.insert("promptVersions", {
      projectId: request.projectId,
      versionNumber: maxVersion + 1,
      systemMessage: request.generatedSystemMessage,
      userMessageTemplate: request.generatedUserTemplate,
      parentVersionId: request.promptVersionId,
      status: "draft",
      createdById: userId,
    });

    await ctx.db.patch(args.requestId, {
      reviewStatus: "accepted",
      reviewedById: userId,
      reviewedAt: Date.now(),
      resultingVersionId: newVersionId,
    });

    // M10: Notify evaluators that their feedback was used
    await ctx.scheduler.runAfter(
      0,
      internal.evaluatorNotifications.notifyEvaluators,
      {
        projectId: request.projectId,
        type: "feedback_used" as const,
        message: "Your feedback helped improve the prompt. A new version was created.",
      },
    );

    return newVersionId;
  },
});

export const rejectOptimization = mutation({
  args: {
    requestId: v.id("optimizationRequests"),
    reviewNotes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const request = await ctx.db.get(args.requestId);
    if (!request) throw new Error("Optimization request not found");

    const { userId } = await requireProjectRole(ctx, request.projectId, [
      "owner",
      "editor",
    ]);

    if (request.status !== "completed" || request.reviewStatus !== "pending") {
      throw new Error("This optimization is not awaiting review.");
    }

    await ctx.db.patch(args.requestId, {
      reviewStatus: "rejected",
      reviewedById: userId,
      reviewedAt: Date.now(),
      reviewNotes: args.reviewNotes,
    });
  },
});

export const editAndAcceptOptimization = mutation({
  args: {
    requestId: v.id("optimizationRequests"),
    systemMessage: v.optional(v.string()),
    userTemplate: v.string(),
  },
  handler: async (ctx, args) => {
    const request = await ctx.db.get(args.requestId);
    if (!request) throw new Error("Optimization request not found");

    const { userId } = await requireProjectRole(ctx, request.projectId, [
      "owner",
      "editor",
    ]);

    if (request.status !== "completed" || request.reviewStatus !== "pending") {
      throw new Error("This optimization is not awaiting review.");
    }

    // Validate edited templates
    const variables = await ctx.db
      .query("projectVariables")
      .withIndex("by_project", (q) => q.eq("projectId", request.projectId))
      .take(200);
    const variableNames = variables.map((v) => v.name);

    validateTemplate(args.userTemplate, variableNames);
    if (args.systemMessage) {
      validateTemplate(args.systemMessage, variableNames);
    }

    // Compute next version number
    const existing = await ctx.db
      .query("promptVersions")
      .withIndex("by_project", (q) => q.eq("projectId", request.projectId))
      .take(200);
    const maxVersion = existing.reduce(
      (max, v) => Math.max(max, v.versionNumber),
      0,
    );

    const newVersionId = await ctx.db.insert("promptVersions", {
      projectId: request.projectId,
      versionNumber: maxVersion + 1,
      systemMessage: args.systemMessage,
      userMessageTemplate: args.userTemplate,
      parentVersionId: request.promptVersionId,
      status: "draft",
      createdById: userId,
    });

    await ctx.db.patch(args.requestId, {
      reviewStatus: "edited",
      reviewedById: userId,
      reviewedAt: Date.now(),
      resultingVersionId: newVersionId,
    });

    return newVersionId;
  },
});

// --- Public queries ---

export const getOptimization = query({
  args: { requestId: v.id("optimizationRequests") },
  handler: async (ctx, args) => {
    const request = await ctx.db.get(args.requestId);
    if (!request) return null;

    await requireProjectRole(ctx, request.projectId, ["owner", "editor"]);

    const version = await ctx.db.get(request.promptVersionId);
    const requester = await ctx.db.get(request.requestedById);

    return {
      ...request,
      versionNumber: version?.versionNumber ?? null,
      requesterName: requester?.name ?? null,
    };
  },
});

export const listOptimizations = query({
  args: { versionId: v.id("promptVersions") },
  handler: async (ctx, args) => {
    const version = await ctx.db.get(args.versionId);
    if (!version) return [];

    await requireProjectRole(ctx, version.projectId, ["owner", "editor"]);

    const requests = await ctx.db
      .query("optimizationRequests")
      .withIndex("by_version", (q) =>
        q.eq("promptVersionId", args.versionId),
      )
      .take(50);

    return requests.sort(
      (a, b) => (b._creationTime ?? 0) - (a._creationTime ?? 0),
    );
  },
});

export const getActiveOptimization = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    await requireProjectRole(ctx, args.projectId, ["owner", "editor"]);

    const pending = await ctx.db
      .query("optimizationRequests")
      .withIndex("by_project_and_status", (q) =>
        q.eq("projectId", args.projectId).eq("status", "pending"),
      )
      .take(1);
    if (pending.length > 0) return pending[0];

    const processing = await ctx.db
      .query("optimizationRequests")
      .withIndex("by_project_and_status", (q) =>
        q.eq("projectId", args.projectId).eq("status", "processing"),
      )
      .take(1);
    return processing[0] ?? null;
  },
});

export const countFeedbackForVersion = query({
  args: { versionId: v.id("promptVersions") },
  handler: async (ctx, args) => {
    const version = await ctx.db.get(args.versionId);
    if (!version) return { outputFeedbackCount: 0, promptFeedbackCount: 0, preferenceCount: 0, commentCount: 0, total: 0 };

    await requireProjectRole(ctx, version.projectId, ["owner", "editor"]);

    // Count prompt feedback
    const promptFb = await ctx.db
      .query("promptFeedback")
      .withIndex("by_version", (q) =>
        q.eq("promptVersionId", args.versionId),
      )
      .take(200);

    // Count output feedback + preferences + comments across all runs
    let outputFeedbackCount = 0;
    let preferenceCount = 0;
    let commentCount = 0;

    const runs = await ctx.db
      .query("promptRuns")
      .withIndex("by_version", (q) =>
        q.eq("promptVersionId", args.versionId),
      )
      .take(200);

    for (const run of runs) {
      const outputs = await ctx.db
        .query("runOutputs")
        .withIndex("by_run", (q) => q.eq("runId", run._id))
        .take(10);
      for (const output of outputs) {
        const fb = await ctx.db
          .query("outputFeedback")
          .withIndex("by_output", (q) => q.eq("outputId", output._id))
          .take(200);
        outputFeedbackCount += fb.length;
      }

      // Count preferences for this run
      const prefs = await ctx.db
        .query("outputPreferences")
        .withIndex("by_run", (q) => q.eq("runId", run._id))
        .take(200);
      preferenceCount += prefs.length;

      // Count comments for this run
      const comments = await ctx.db
        .query("runComments")
        .withIndex("by_run", (q) => q.eq("runId", run._id))
        .take(100);
      commentCount += comments.length;
    }

    return {
      outputFeedbackCount,
      promptFeedbackCount: promptFb.length,
      preferenceCount,
      commentCount,
      total: outputFeedbackCount + promptFb.length + preferenceCount + commentCount,
    };
  },
});

// --- Internal functions (called by the optimizer action) ---

export const updateOptimizationStatus = internalMutation({
  args: {
    requestId: v.id("optimizationRequests"),
    status: v.union(
      v.literal("processing"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const updates: Record<string, unknown> = { status: args.status };
    if (args.errorMessage !== undefined) updates.errorMessage = args.errorMessage;
    await ctx.db.patch(args.requestId, updates);
  },
});

export const completeOptimization = internalMutation({
  args: {
    requestId: v.id("optimizationRequests"),
    generatedSystemMessage: v.optional(v.string()),
    generatedUserTemplate: v.string(),
    changesSummary: v.string(),
    changesReasoning: v.string(),
  },
  handler: async (ctx, args) => {
    const { requestId, ...fields } = args;
    await ctx.db.patch(requestId, {
      ...fields,
      status: "completed",
      reviewStatus: "pending",
    });
  },
});

export const failOptimization = internalMutation({
  args: {
    requestId: v.id("optimizationRequests"),
    errorMessage: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.requestId, {
      status: "failed",
      errorMessage: args.errorMessage,
    });
  },
});

export const getOptimizationContext = internalQuery({
  args: { requestId: v.id("optimizationRequests") },
  handler: async (ctx, args) => {
    const request = await ctx.db.get(args.requestId);
    if (!request) throw new Error("Optimization request not found");

    const version = await ctx.db.get(request.promptVersionId);
    if (!version) throw new Error("Version not found");

    const project = await ctx.db.get(request.projectId);
    if (!project) throw new Error("Project not found");

    // Load project variables
    const variables = await ctx.db
      .query("projectVariables")
      .withIndex("by_project", (q) => q.eq("projectId", request.projectId))
      .take(200);

    // Load prompt feedback
    const promptFeedback = await ctx.db
      .query("promptFeedback")
      .withIndex("by_version", (q) =>
        q.eq("promptVersionId", request.promptVersionId),
      )
      .take(200);

    // Load output feedback across all runs for this version
    const runs = await ctx.db
      .query("promptRuns")
      .withIndex("by_version", (q) =>
        q.eq("promptVersionId", request.promptVersionId),
      )
      .take(200);

    const outputFeedbackItems: Array<{
      blindLabel: string;
      highlightedText: string;
      comment: string;
      model?: string;
      temperature?: number;
    }> = [];

    for (const run of runs) {
      const outputs = await ctx.db
        .query("runOutputs")
        .withIndex("by_run", (q) => q.eq("runId", run._id))
        .take(10);
      for (const output of outputs) {
        const fb = await ctx.db
          .query("outputFeedback")
          .withIndex("by_output", (q) => q.eq("outputId", output._id))
          .take(200);
        for (const f of fb) {
          outputFeedbackItems.push({
            blindLabel: output.blindLabel,
            highlightedText: f.annotationData.highlightedText,
            comment: f.annotationData.comment,
            model: output.model,
            temperature: output.temperature,
          });
        }
      }
    }

    return {
      request,
      version,
      project,
      variables: variables.map((v) => ({
        name: v.name,
        description: v.description,
        required: v.required,
      })),
      outputFeedback: outputFeedbackItems,
      promptFeedback: promptFeedback.map((pf) => ({
        targetField: pf.targetField as
          | "system_message"
          | "user_message_template",
        highlightedText: pf.annotationData.highlightedText,
        comment: pf.annotationData.comment,
      })),
      metaContext: project.metaContext ?? [],
      organizationId: project.organizationId,
    };
  },
});
