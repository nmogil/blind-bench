import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireProjectRole } from "./lib/auth";

// Mime allowlist matching OpenRouter's OpenAI-compatible image input format.
// Anything outside this set is rejected at finalize() — never trust the client.
const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

// 5MB cap. Anthropic is the tightest of the providers OpenRouter routes to;
// staying under their floor keeps us safe across the whole catalog.
const MAX_SIZE_BYTES = 5 * 1024 * 1024;

export const generateUploadUrl = mutation({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    await requireProjectRole(ctx, args.projectId, ["owner", "editor"]);
    return ctx.storage.generateUploadUrl();
  },
});

/**
 * Validate an uploaded blob. Call after the client POSTs to the upload URL but
 * before binding the storage id into testCases.variableAttachments. Throws
 * with a user-facing reason string on rejection; the caller is responsible
 * for cleaning up the orphaned blob if validation fails.
 */
export const finalize = mutation({
  args: {
    projectId: v.id("projects"),
    storageId: v.id("_storage"),
  },
  handler: async (ctx, args) => {
    await requireProjectRole(ctx, args.projectId, ["owner", "editor"]);

    const metadata = await ctx.db.system.get(args.storageId);
    if (!metadata) {
      throw new Error("Upload not found — try uploading again");
    }

    if (metadata.size === 0) {
      await ctx.storage.delete(args.storageId);
      throw new Error("File is empty");
    }

    if (metadata.size > MAX_SIZE_BYTES) {
      await ctx.storage.delete(args.storageId);
      throw new Error("Image must be 5MB or smaller");
    }

    const mimeType = metadata.contentType ?? "";
    if (!ALLOWED_MIME_TYPES.has(mimeType)) {
      await ctx.storage.delete(args.storageId);
      throw new Error(
        `Unsupported image format. Allowed: JPEG, PNG, WebP, GIF`,
      );
    }

    return {
      storageId: args.storageId,
      mimeType,
      sizeBytes: metadata.size,
    };
  },
});

export const getUrl = query({
  args: {
    projectId: v.id("projects"),
    storageId: v.id("_storage"),
  },
  handler: async (ctx, args) => {
    // Reviewers (evaluators) need to see image variable values during blind
    // eval — they're test-case input, not prompt content.
    await requireProjectRole(ctx, args.projectId, [
      "owner",
      "editor",
      "evaluator",
    ]);
    const [url, metadata] = await Promise.all([
      ctx.storage.getUrl(args.storageId),
      ctx.db.system.get(args.storageId),
    ]);
    if (!url || !metadata) return null;
    return {
      url,
      mimeType: metadata.contentType ?? "",
      sizeBytes: metadata.size,
    };
  },
});

export const deleteAttachment = mutation({
  args: {
    projectId: v.id("projects"),
    storageId: v.id("_storage"),
  },
  handler: async (ctx, args) => {
    await requireProjectRole(ctx, args.projectId, ["owner", "editor"]);
    await ctx.storage.delete(args.storageId);
  },
});
