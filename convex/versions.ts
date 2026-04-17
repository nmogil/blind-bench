import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireProjectRole } from "./lib/auth";
import { validateTemplate } from "./lib/templateValidation";
import { createVersionCore } from "./lib/versionsCore";

export const list = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    await requireProjectRole(ctx, args.projectId, ["owner", "editor"]);

    const versions = await ctx.db
      .query("promptVersions")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .take(200);

    // Enrich with creator info
    const enriched = [];
    for (const version of versions) {
      const creator = await ctx.db.get(version.createdById);
      enriched.push({
        ...version,
        creatorName: creator?.name ?? null,
        creatorImage: creator?.image ?? null,
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

export const create = mutation({
  args: {
    projectId: v.id("projects"),
    systemMessage: v.optional(v.string()),
    userMessageTemplate: v.string(),
    parentVersionId: v.optional(v.id("promptVersions")),
  },
  handler: async (ctx, args) => {
    const { userId } = await requireProjectRole(ctx, args.projectId, [
      "owner",
      "editor",
    ]);
    return await createVersionCore(ctx, { ...args, userId });
  },
});

export const update = mutation({
  args: {
    versionId: v.id("promptVersions"),
    systemMessage: v.optional(v.string()),
    userMessageTemplate: v.optional(v.string()),
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
      parentVersionId: head._id,
      sourceVersionId: target._id,
      status: "draft",
      createdById: userId,
    });
  },
});
