import { v } from "convex/values";
import {
  query,
  mutation,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { requireProjectRole } from "./lib/auth";

export const requestSuggestions = mutation({
  args: {
    versionId: v.id("promptVersions"),
    slotCount: v.number(),
  },
  handler: async (ctx, args) => {
    const version = await ctx.db.get(args.versionId);
    if (!version) throw new Error("Version not found");

    const { userId } = await requireProjectRole(ctx, version.projectId, [
      "owner",
      "editor",
    ]);

    // 1-in-flight-per-project cap
    const pending = await ctx.db
      .query("runAssistantSuggestions")
      .withIndex("by_project_and_status", (q) =>
        q.eq("projectId", version.projectId).eq("status", "pending"),
      )
      .take(1);
    const processing = await ctx.db
      .query("runAssistantSuggestions")
      .withIndex("by_project_and_status", (q) =>
        q.eq("projectId", version.projectId).eq("status", "processing"),
      )
      .take(1);

    if (pending.length > 0 || processing.length > 0) {
      throw new Error("A suggestion request is already in progress.");
    }

    const requestId = await ctx.db.insert("runAssistantSuggestions", {
      projectId: version.projectId,
      promptVersionId: args.versionId,
      status: "pending",
      requestedById: userId,
    });

    await ctx.scheduler.runAfter(
      0,
      internal.runAssistantActions.generateSuggestionsAction,
      { requestId, slotCount: args.slotCount },
    );

    return requestId;
  },
});

export const getSuggestions = query({
  args: { versionId: v.id("promptVersions") },
  handler: async (ctx, args) => {
    const version = await ctx.db.get(args.versionId);
    if (!version) return null;

    await requireProjectRole(ctx, version.projectId, ["owner", "editor"]);

    // Get the most recent suggestion for this version
    const suggestions = await ctx.db
      .query("runAssistantSuggestions")
      .withIndex("by_version", (q) =>
        q.eq("promptVersionId", args.versionId),
      )
      .take(10);

    if (suggestions.length === 0) return null;

    // Return the most recent one
    return suggestions.sort(
      (a, b) => (b._creationTime ?? 0) - (a._creationTime ?? 0),
    )[0]!;
  },
});

export const getAssistantContext = internalQuery({
  args: { requestId: v.id("runAssistantSuggestions") },
  handler: async (ctx, args) => {
    const request = await ctx.db.get(args.requestId);
    if (!request) throw new Error("Suggestion request not found");

    const version = await ctx.db.get(request.promptVersionId);
    if (!version) throw new Error("Version not found");

    const project = await ctx.db.get(request.projectId);
    if (!project) throw new Error("Project not found");

    // Load model catalog
    const catalogModels = await ctx.db.query("modelCatalog").take(500);
    const models = catalogModels.map((m) => ({
      id: m.modelId,
      name: m.name,
      provider: m.provider,
      promptPricing: m.promptPricing,
      completionPricing: m.completionPricing,
    }));

    return {
      request,
      version,
      project,
      models,
      metaContext: project.metaContext ?? [],
      organizationId: project.organizationId,
    };
  },
});

export const completeSuggestions = internalMutation({
  args: {
    requestId: v.id("runAssistantSuggestions"),
    suggestions: v.array(
      v.object({
        title: v.string(),
        description: v.string(),
        slotConfigs: v.array(
          v.object({
            label: v.string(),
            model: v.string(),
            temperature: v.number(),
          }),
        ),
      }),
    ),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.requestId, {
      status: "completed",
      suggestions: args.suggestions,
    });
  },
});

export const failSuggestions = internalMutation({
  args: {
    requestId: v.id("runAssistantSuggestions"),
    errorMessage: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.requestId, {
      status: "failed",
      errorMessage: args.errorMessage,
    });
  },
});

export const updateSuggestionStatus = internalMutation({
  args: {
    requestId: v.id("runAssistantSuggestions"),
    status: v.union(v.literal("processing"), v.literal("failed")),
    errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const updates: Record<string, unknown> = { status: args.status };
    if (args.errorMessage !== undefined) updates.errorMessage = args.errorMessage;
    await ctx.db.patch(args.requestId, updates);
  },
});
