import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireProjectRole } from "./lib/auth";

export const list = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    await requireProjectRole(ctx, args.projectId, ["owner", "editor"]);

    const variables = await ctx.db
      .query("projectVariables")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .take(200);

    return variables.sort((a, b) => a.order - b.order);
  },
});

export const add = mutation({
  args: {
    projectId: v.id("projects"),
    name: v.string(),
    description: v.optional(v.string()),
    defaultValue: v.optional(v.string()),
    required: v.boolean(),
  },
  handler: async (ctx, args) => {
    await requireProjectRole(ctx, args.projectId, ["owner", "editor"]);

    // Validate name uniqueness within the project
    const existing = await ctx.db
      .query("projectVariables")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .take(200);

    if (existing.some((v) => v.name === args.name)) {
      throw new Error(
        `A variable named "${args.name}" already exists in this project`,
      );
    }

    const maxOrder = existing.reduce((max, v) => Math.max(max, v.order), -1);

    return await ctx.db.insert("projectVariables", {
      projectId: args.projectId,
      name: args.name,
      description: args.description,
      defaultValue: args.defaultValue,
      required: args.required,
      order: maxOrder + 1,
    });
  },
});

export const update = mutation({
  args: {
    variableId: v.id("projectVariables"),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    defaultValue: v.optional(v.string()),
    required: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const variable = await ctx.db.get(args.variableId);
    if (!variable) throw new Error("Variable not found");

    await requireProjectRole(ctx, variable.projectId, ["owner", "editor"]);

    // If name is changing, validate uniqueness (exclude self)
    if (args.name !== undefined && args.name !== variable.name) {
      const siblings = await ctx.db
        .query("projectVariables")
        .withIndex("by_project", (q) =>
          q.eq("projectId", variable.projectId),
        )
        .take(200);

      if (siblings.some((v) => v._id !== args.variableId && v.name === args.name)) {
        throw new Error(
          `A variable named "${args.name}" already exists in this project`,
        );
      }
    }

    const updates: Record<string, string | boolean | undefined> = {};
    if (args.name !== undefined) updates.name = args.name;
    if (args.description !== undefined) updates.description = args.description;
    if (args.defaultValue !== undefined) updates.defaultValue = args.defaultValue;
    if (args.required !== undefined) updates.required = args.required;

    await ctx.db.patch(args.variableId, updates);
  },
});

export const deleteVariable = mutation({
  args: { variableId: v.id("projectVariables") },
  handler: async (ctx, args) => {
    const variable = await ctx.db.get(args.variableId);
    if (!variable) throw new Error("Variable not found");

    await requireProjectRole(ctx, variable.projectId, ["owner", "editor"]);

    // Check if any prompt version references this variable
    const versions = await ctx.db
      .query("promptVersions")
      .withIndex("by_project", (q) => q.eq("projectId", variable.projectId))
      .take(200);

    const varPattern = new RegExp(
      `(?<!\\\\)\\{\\{\\s*${variable.name}\\s*\\}\\}`,
    );
    for (const version of versions) {
      const templates = [
        version.userMessageTemplate,
        version.systemMessage ?? "",
      ].join(" ");
      if (varPattern.test(templates)) {
        throw new Error(
          `This variable is used in version ${version.versionNumber}. Remove the reference first.`,
        );
      }
    }

    await ctx.db.delete(args.variableId);
  },
});

export const reorder = mutation({
  args: {
    projectId: v.id("projects"),
    orderedIds: v.array(v.id("projectVariables")),
  },
  handler: async (ctx, args) => {
    await requireProjectRole(ctx, args.projectId, ["owner", "editor"]);

    for (let i = 0; i < args.orderedIds.length; i++) {
      const id = args.orderedIds[i]!;
      await ctx.db.patch(id, { order: i });
    }
  },
});
