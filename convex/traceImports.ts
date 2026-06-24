import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireProjectRole } from "./lib/auth";

const SOURCE_VALIDATOR = v.union(
  v.literal("langfuse"),
  v.literal("posthog"),
  v.literal("promptlayer"),
  v.literal("manual_paste"),
  v.literal("cloudflare_ai_gateway"),
);

/**
 * M22: create or return an existing import row for a (source, sourceTraceId)
 * pair. Provider adapters call this after parsing — re-importing the same
 * trace returns the prior row so the user sees a single record per upstream
 * trace, not duplicates.
 *
 * `manual_paste` imports never have a sourceTraceId, so they always insert.
 * The dedup index treats `undefined` as a distinct slot, which is what we
 * want here.
 */
export const createImport = mutation({
  args: {
    projectId: v.id("projects"),
    source: SOURCE_VALIDATOR,
    sourceTraceId: v.optional(v.string()),
    rawPayloadStorageId: v.optional(v.id("_storage")),
    promptVersionId: v.optional(v.id("promptVersions")),
    runOutputId: v.optional(v.id("runOutputs")),
  },
  handler: async (ctx, args) => {
    const { userId } = await requireProjectRole(ctx, args.projectId, [
      "owner",
      "editor",
    ]);

    if (args.sourceTraceId !== undefined) {
      const existing = await ctx.db
        .query("traceImports")
        .withIndex("by_source_trace", (q) =>
          q.eq("source", args.source).eq("sourceTraceId", args.sourceTraceId),
        )
        .filter((q) => q.eq(q.field("projectId"), args.projectId))
        .first();
      if (existing) return existing._id;
    }

    return await ctx.db.insert("traceImports", {
      projectId: args.projectId,
      source: args.source,
      sourceTraceId: args.sourceTraceId,
      importedById: userId,
      promptVersionId: args.promptVersionId,
      runOutputId: args.runOutputId,
      rawPayloadStorageId: args.rawPayloadStorageId,
    });
  },
});

/**
 * Patch the materialization targets after the importer decides whether to
 * create a new prompt version, attach to a run output, or both. Idempotent
 * on already-set fields.
 */
export const setMaterialized = mutation({
  args: {
    importId: v.id("traceImports"),
    promptVersionId: v.optional(v.id("promptVersions")),
    runOutputId: v.optional(v.id("runOutputs")),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.importId);
    if (!row) throw new Error("Import not found");
    await requireProjectRole(ctx, row.projectId, ["owner", "editor"]);

    const updates: Record<string, unknown> = {};
    if (args.promptVersionId !== undefined)
      updates.promptVersionId = args.promptVersionId;
    if (args.runOutputId !== undefined)
      updates.runOutputId = args.runOutputId;
    if (Object.keys(updates).length > 0) {
      await ctx.db.patch(args.importId, updates);
    }
  },
});

export const list = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    await requireProjectRole(ctx, args.projectId, ["owner", "editor"]);
    const rows = await ctx.db
      .query("traceImports")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .take(200);
    return rows.sort(
      (a, b) => (b._creationTime ?? 0) - (a._creationTime ?? 0),
    );
  },
});
