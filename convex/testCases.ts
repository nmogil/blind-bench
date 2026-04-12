import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireProjectRole } from "./lib/auth";

export const list = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    await requireProjectRole(ctx, args.projectId, ["owner", "editor"]);

    const testCases = await ctx.db
      .query("testCases")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .take(200);

    return testCases.sort((a, b) => a.order - b.order);
  },
});

export const get = query({
  args: { testCaseId: v.id("testCases") },
  handler: async (ctx, args) => {
    const testCase = await ctx.db.get(args.testCaseId);
    if (!testCase) return null;

    await requireProjectRole(ctx, testCase.projectId, ["owner", "editor"]);
    return testCase;
  },
});

export const create = mutation({
  args: {
    projectId: v.id("projects"),
    name: v.string(),
    variableValues: v.record(v.string(), v.string()),
    attachmentIds: v.optional(v.array(v.id("_storage"))),
  },
  handler: async (ctx, args) => {
    const { userId } = await requireProjectRole(ctx, args.projectId, [
      "owner",
      "editor",
    ]);

    const existing = await ctx.db
      .query("testCases")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .take(200);

    const maxOrder = existing.reduce((max, tc) => Math.max(max, tc.order), -1);

    return await ctx.db.insert("testCases", {
      projectId: args.projectId,
      name: args.name,
      variableValues: args.variableValues,
      attachmentIds: args.attachmentIds ?? [],
      order: maxOrder + 1,
      createdById: userId,
    });
  },
});

export const update = mutation({
  args: {
    testCaseId: v.id("testCases"),
    name: v.optional(v.string()),
    variableValues: v.optional(v.record(v.string(), v.string())),
  },
  handler: async (ctx, args) => {
    const testCase = await ctx.db.get(args.testCaseId);
    if (!testCase) throw new Error("Test case not found");

    await requireProjectRole(ctx, testCase.projectId, ["owner", "editor"]);

    const updates: Record<string, string | Record<string, string>> = {};
    if (args.name !== undefined) updates.name = args.name;
    if (args.variableValues !== undefined)
      updates.variableValues = args.variableValues;

    await ctx.db.patch(args.testCaseId, updates);
  },
});

export const deleteTestCase = mutation({
  args: { testCaseId: v.id("testCases") },
  handler: async (ctx, args) => {
    const testCase = await ctx.db.get(args.testCaseId);
    if (!testCase) throw new Error("Test case not found");

    await requireProjectRole(ctx, testCase.projectId, ["owner", "editor"]);
    await ctx.db.delete(args.testCaseId);
  },
});

export const reorder = mutation({
  args: {
    projectId: v.id("projects"),
    orderedIds: v.array(v.id("testCases")),
  },
  handler: async (ctx, args) => {
    await requireProjectRole(ctx, args.projectId, ["owner", "editor"]);

    for (let i = 0; i < args.orderedIds.length; i++) {
      const id = args.orderedIds[i]!;
      await ctx.db.patch(id, { order: i });
    }
  },
});
