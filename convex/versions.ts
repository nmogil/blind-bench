import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireProjectRole } from "./lib/auth";
import { validateTemplate } from "./lib/templateValidation";

export const list = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) return [];
    await requireProjectRole(ctx, args.projectId, ["owner", "editor"]);

    const versions = await ctx.db
      .query("promptVersions")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .take(200);

    // Enrich each row with creator, run count, and a coarse feedback count so
    // the Versions list can surface "has feedback" affordances per row.
    const enriched = [];
    for (const version of versions) {
      const creator = await ctx.db.get(version.createdById);

      const promptFb = await ctx.db
        .query("promptFeedback")
        .withIndex("by_version", (q) =>
          q.eq("promptVersionId", version._id),
        )
        .take(100);

      const runs = await ctx.db
        .query("promptRuns")
        .withIndex("by_version", (q) =>
          q.eq("promptVersionId", version._id),
        )
        .take(100);

      // Count cycle feedback that targets outputs sourced from this version's
      // runs. Capped so very active versions don't make this query quadratic.
      let cycleFeedbackCount = 0;
      for (const run of runs.slice(0, 50)) {
        const outputs = await ctx.db
          .query("runOutputs")
          .withIndex("by_run", (q) => q.eq("runId", run._id))
          .take(10);
        for (const output of outputs) {
          const cycleOutputs = await ctx.db
            .query("cycleOutputs")
            .withIndex("by_source_output", (q) =>
              q.eq("sourceOutputId", output._id),
            )
            .take(20);
          for (const co of cycleOutputs) {
            const fb = await ctx.db
              .query("cycleFeedback")
              .withIndex("by_cycle_output", (q) =>
                q.eq("cycleOutputId", co._id),
              )
              .take(100);
            cycleFeedbackCount += fb.length;
          }
        }
      }

      enriched.push({
        ...version,
        creatorName: creator?.name ?? null,
        creatorImage: creator?.image ?? null,
        runCount: runs.length,
        feedbackCount: promptFb.length + cycleFeedbackCount,
      });
    }

    return enriched.sort((a, b) => b.versionNumber - a.versionNumber);
  },
});

export const get = query({
  args: { versionId: v.id("promptVersions") },
  handler: async (ctx, args) => {
    const version = await ctx.db.get(args.versionId);
    if (!version) return null;

    await requireProjectRole(ctx, version.projectId, ["owner", "editor"]);
    return version;
  },
});

export const getCurrent = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    await requireProjectRole(ctx, args.projectId, ["owner", "editor"]);

    const versions = await ctx.db
      .query("promptVersions")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .take(200);

    // Return current version if one exists
    const current = versions.find((v) => v.status === "current");
    if (current) return current;

    // Otherwise return the latest draft (highest versionNumber)
    const drafts = versions
      .filter((v) => v.status === "draft")
      .sort((a, b) => b.versionNumber - a.versionNumber);
    return drafts[0] ?? null;
  },
});

const formatValidator = v.optional(
  v.union(v.literal("plain"), v.literal("markdown")),
);

export const create = mutation({
  args: {
    projectId: v.id("projects"),
    systemMessage: v.optional(v.string()),
    userMessageTemplate: v.string(),
    systemMessageFormat: formatValidator,
    userMessageTemplateFormat: formatValidator,
    parentVersionId: v.optional(v.id("promptVersions")),
  },
  handler: async (ctx, args) => {
    const { userId } = await requireProjectRole(ctx, args.projectId, [
      "owner",
      "editor",
    ]);

    // Fetch variable names for template validation
    const variables = await ctx.db
      .query("projectVariables")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .take(200);
    const variableNames = variables.map((v) => v.name);

    // Validate templates and auto-create unknown variables
    const unknownFromUser = validateTemplate(args.userMessageTemplate, variableNames);
    const unknownFromSystem = args.systemMessage
      ? validateTemplate(args.systemMessage, variableNames)
      : [];
    const allUnknown = [...new Set([...unknownFromUser, ...unknownFromSystem])];
    const maxOrder = variables.reduce((max, v) => Math.max(max, v.order), -1);
    for (let i = 0; i < allUnknown.length; i++) {
      await ctx.db.insert("projectVariables", {
        projectId: args.projectId,
        name: allUnknown[i]!,
        required: true,
        order: maxOrder + 1 + i,
      });
    }

    // Compute next version number and archive existing current version
    const existing = await ctx.db
      .query("promptVersions")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .take(200);
    const maxVersion = existing.reduce(
      (max, v) => Math.max(max, v.versionNumber),
      0,
    );

    for (const v of existing) {
      if (v.status === "current") {
        await ctx.db.patch(v._id, { status: "archived" as const });
      }
    }

    return await ctx.db.insert("promptVersions", {
      projectId: args.projectId,
      versionNumber: maxVersion + 1,
      systemMessage: args.systemMessage,
      userMessageTemplate: args.userMessageTemplate,
      systemMessageFormat: args.systemMessageFormat,
      userMessageTemplateFormat: args.userMessageTemplateFormat,
      parentVersionId: args.parentVersionId,
      status: "draft",
      createdById: userId,
    });
  },
});

export const update = mutation({
  args: {
    versionId: v.id("promptVersions"),
    systemMessage: v.optional(v.string()),
    userMessageTemplate: v.optional(v.string()),
    systemMessageFormat: formatValidator,
    userMessageTemplateFormat: formatValidator,
  },
  handler: async (ctx, args) => {
    const version = await ctx.db.get(args.versionId);
    if (!version) throw new Error("Version not found");
    if (version.status !== "draft") {
      throw new Error("Only drafts can be edited");
    }

    await requireProjectRole(ctx, version.projectId, ["owner", "editor"]);

    // Fetch variable names for template validation
    const variables = await ctx.db
      .query("projectVariables")
      .withIndex("by_project", (q) => q.eq("projectId", version.projectId))
      .take(200);
    const variableNames = variables.map((v) => v.name);

    // Validate templates and auto-create unknown variables
    const templateToValidate =
      args.userMessageTemplate ?? version.userMessageTemplate;
    const unknownFromUser = validateTemplate(templateToValidate, variableNames);

    const systemToValidate = args.systemMessage ?? version.systemMessage;
    const unknownFromSystem = systemToValidate
      ? validateTemplate(systemToValidate, variableNames)
      : [];

    const allUnknown = [...new Set([...unknownFromUser, ...unknownFromSystem])];
    const maxOrder = variables.reduce((max, v) => Math.max(max, v.order), -1);
    for (let i = 0; i < allUnknown.length; i++) {
      await ctx.db.insert("projectVariables", {
        projectId: version.projectId,
        name: allUnknown[i]!,
        required: true,
        order: maxOrder + 1 + i,
      });
    }

    const updates: Record<string, string | undefined> = {};
    if (args.systemMessage !== undefined) updates.systemMessage = args.systemMessage;
    if (args.userMessageTemplate !== undefined)
      updates.userMessageTemplate = args.userMessageTemplate;
    if (args.systemMessageFormat !== undefined)
      updates.systemMessageFormat = args.systemMessageFormat;
    if (args.userMessageTemplateFormat !== undefined)
      updates.userMessageTemplateFormat = args.userMessageTemplateFormat;

    await ctx.db.patch(args.versionId, updates);

    // Auto-promote draft to current and archive previous current
    const allVersions = await ctx.db
      .query("promptVersions")
      .withIndex("by_project", (q) => q.eq("projectId", version.projectId))
      .take(200);
    for (const v of allVersions) {
      if (v._id !== args.versionId && v.status === "current") {
        await ctx.db.patch(v._id, { status: "archived" as const });
      }
    }
    await ctx.db.patch(args.versionId, { status: "current" as const });
  },
});

export const deleteVersion = mutation({
  args: { versionId: v.id("promptVersions") },
  handler: async (ctx, args) => {
    const version = await ctx.db.get(args.versionId);
    if (!version) throw new Error("Version not found");
    if (version.status !== "draft") {
      throw new Error("Only drafts can be deleted");
    }

    await requireProjectRole(ctx, version.projectId, ["owner", "editor"]);

    // Delete associated attachments
    const attachments = await ctx.db
      .query("promptAttachments")
      .withIndex("by_version", (q) =>
        q.eq("promptVersionId", args.versionId),
      )
      .take(200);
    for (const a of attachments) {
      await ctx.db.delete(a._id);
    }

    await ctx.db.delete(args.versionId);
  },
});

export const fork = mutation({
  args: { sourceVersionId: v.id("promptVersions") },
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.sourceVersionId);
    if (!source) throw new Error("Version not found");

    const { userId } = await requireProjectRole(ctx, source.projectId, [
      "owner",
      "editor",
    ]);

    // Compute next version number
    const existing = await ctx.db
      .query("promptVersions")
      .withIndex("by_project", (q) => q.eq("projectId", source.projectId))
      .take(200);
    const maxVersion = existing.reduce(
      (max, v) => Math.max(max, v.versionNumber),
      0,
    );

    // Copy attachments from source
    const sourceAttachments = await ctx.db
      .query("promptAttachments")
      .withIndex("by_version", (q) =>
        q.eq("promptVersionId", args.sourceVersionId),
      )
      .take(200);

    const newVersionId = await ctx.db.insert("promptVersions", {
      projectId: source.projectId,
      versionNumber: maxVersion + 1,
      systemMessage: source.systemMessage,
      userMessageTemplate: source.userMessageTemplate,
      systemMessageFormat: source.systemMessageFormat,
      userMessageTemplateFormat: source.userMessageTemplateFormat,
      sourceVersionId: args.sourceVersionId,
      status: "draft",
      createdById: userId,
    });

    // Copy attachments to new version
    for (const a of sourceAttachments) {
      await ctx.db.insert("promptAttachments", {
        promptVersionId: newVersionId,
        storageId: a.storageId,
        filename: a.filename,
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes,
        order: a.order,
      });
    }

    return newVersionId;
  },
});

export const archive = mutation({
  args: { versionId: v.id("promptVersions") },
  handler: async (ctx, args) => {
    const version = await ctx.db.get(args.versionId);
    if (!version) throw new Error("Version not found");

    await requireProjectRole(ctx, version.projectId, ["owner", "editor"]);
    await ctx.db.patch(args.versionId, { status: "archived" as const });
  },
});

export const rollback = mutation({
  args: { versionId: v.id("promptVersions") },
  handler: async (ctx, args) => {
    const target = await ctx.db.get(args.versionId);
    if (!target) throw new Error("Version not found");

    const { userId } = await requireProjectRole(ctx, target.projectId, [
      "owner",
      "editor",
    ]);

    // Find the head version (highest versionNumber)
    const versions = await ctx.db
      .query("promptVersions")
      .withIndex("by_project", (q) => q.eq("projectId", target.projectId))
      .take(200);
    const head = versions.reduce((h, v) =>
      v.versionNumber > h.versionNumber ? v : h,
    );

    // Create new version with target's content
    return await ctx.db.insert("promptVersions", {
      projectId: target.projectId,
      versionNumber: head.versionNumber + 1,
      systemMessage: target.systemMessage,
      userMessageTemplate: target.userMessageTemplate,
      systemMessageFormat: target.systemMessageFormat,
      userMessageTemplateFormat: target.userMessageTemplateFormat,
      parentVersionId: head._id,
      sourceVersionId: target._id,
      status: "draft",
      createdById: userId,
    });
  },
});
