import { v } from "convex/values";
import {
  query,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { requireProjectRole } from "./lib/auth";

export const getInsights = query({
  args: { runId: v.id("promptRuns") },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run) return null;

    await requireProjectRole(ctx, run.projectId, ["owner", "editor"]);

    const insights = await ctx.db
      .query("runInsights")
      .withIndex("by_run", (q) => q.eq("runId", args.runId))
      .take(1);

    return insights[0] ?? null;
  },
});

export const getInsightContext = internalQuery({
  args: { runId: v.id("promptRuns") },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run) throw new Error("Run not found");

    const version = await ctx.db.get(run.promptVersionId);
    if (!version) throw new Error("Version not found");

    const project = await ctx.db.get(run.projectId);
    if (!project) throw new Error("Project not found");

    // Load outputs with content and metrics
    const outputs = await ctx.db
      .query("runOutputs")
      .withIndex("by_run", (q) => q.eq("runId", args.runId))
      .take(10);

    // Load model pricing from catalog
    const catalogModels = await ctx.db.query("modelCatalog").take(500);
    const pricingMap = new Map(
      catalogModels.map((m) => [
        m.modelId,
        { promptPricing: m.promptPricing, completionPricing: m.completionPricing },
      ]),
    );

    const outputData = outputs
      .sort((a, b) => a.blindLabel.localeCompare(b.blindLabel))
      .map((o) => {
        const model = o.model ?? run.model;
        const pricing = pricingMap.get(model);
        return {
          blindLabel: o.blindLabel,
          model,
          temperature: o.temperature ?? run.temperature,
          outputContent: o.outputContent.slice(0, 2000), // Truncate for context window
          promptTokens: o.promptTokens,
          completionTokens: o.completionTokens,
          totalTokens: o.totalTokens,
          latencyMs: o.latencyMs,
          estimatedCost: pricing
            ? ((o.promptTokens ?? 0) * pricing.promptPricing +
               (o.completionTokens ?? 0) * pricing.completionPricing) /
              1_000_000
            : undefined,
        };
      });

    return {
      run,
      version,
      project,
      outputs: outputData,
      metaContext: project.metaContext ?? [],
      organizationId: project.organizationId,
    };
  },
});

export const completeInsights = internalMutation({
  args: {
    insightId: v.id("runInsights"),
    insightContent: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.insightId, {
      status: "completed",
      insightContent: args.insightContent,
    });
  },
});

export const failInsights = internalMutation({
  args: {
    insightId: v.id("runInsights"),
    errorMessage: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.insightId, {
      status: "failed",
      errorMessage: args.errorMessage,
    });
  },
});

export const updateInsightStatus = internalMutation({
  args: {
    insightId: v.id("runInsights"),
    status: v.union(v.literal("processing"), v.literal("failed")),
    errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const updates: Record<string, unknown> = { status: args.status };
    if (args.errorMessage !== undefined) updates.errorMessage = args.errorMessage;
    await ctx.db.patch(args.insightId, updates);
  },
});
