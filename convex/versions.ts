import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireProjectRole } from "./lib/auth";
import { validateTemplate } from "./lib/templateValidation";

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

    // Return active version if one exists
    const active = versions.find((v) => v.status === "active");
    if (active) return active;

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

    // Fetch variable names for template validation
    const variables = await ctx.db
      .query("projectVariables")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .take(200);
    const variableNames = variables.map((v) => v.name);

    // Validate templates
    validateTemplate(args.userMessageTemplate, variableNames);
    if (args.systemMessage) {
      validateTemplate(args.systemMessage, variableNames);
    }

    // Compute next version number
    const existing = await ctx.db
      .query("promptVersions")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .take(200);
    const maxVersion = existing.reduce(
      (max, v) => Math.max(max, v.versionNumber),
      0,
    );

    return await ctx.db.insert("promptVersions", {
      projectId: args.projectId,
      versionNumber: maxVersion + 1,
      systemMessage: args.systemMessage,
      userMessageTemplate: args.userMessageTemplate,
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

    // Validate any updated templates
    const templateToValidate =
      args.userMessageTemplate ?? version.userMessageTemplate;
    validateTemplate(templateToValidate, variableNames);

    const systemToValidate = args.systemMessage ?? version.systemMessage;
    if (systemToValidate) {
      validateTemplate(systemToValidate, variableNames);
    }

    const updates: Record<string, string | undefined> = {};
    if (args.systemMessage !== undefined) updates.systemMessage = args.systemMessage;
    if (args.userMessageTemplate !== undefined)
      updates.userMessageTemplate = args.userMessageTemplate;

    await ctx.db.patch(args.versionId, updates);
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

export const promoteToActive = mutation({
  args: { versionId: v.id("promptVersions") },
  handler: async (ctx, args) => {
    const version = await ctx.db.get(args.versionId);
    if (!version) throw new Error("Version not found");
    if (version.status !== "draft") {
      throw new Error("Only drafts can be promoted to active");
    }

    await requireProjectRole(ctx, version.projectId, ["owner", "editor"]);

    // Demote current active version to archived
    const versions = await ctx.db
      .query("promptVersions")
      .withIndex("by_project", (q) => q.eq("projectId", version.projectId))
      .take(200);

    for (const v of versions) {
      if (v.status === "active") {
        await ctx.db.patch(v._id, { status: "archived" as const });
      }
    }

    await ctx.db.patch(args.versionId, { status: "active" as const });
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
