import { v } from "convex/values";
import { mutation, query, internalQuery } from "./_generated/server";
import { requireOrgRole } from "./lib/auth";
import { encrypt, decrypt } from "./lib/crypto";

export const setKey = mutation({
  args: {
    orgId: v.id("organizations"),
    key: v.string(),
  },
  handler: async (ctx, args) => {
    const { userId } = await requireOrgRole(ctx, args.orgId, ["owner"]);

    if (!args.key.trim()) {
      throw new Error("API key cannot be empty");
    }

    const secret = process.env.OPENROUTER_KEY_ENCRYPTION_SECRET;
    if (!secret) {
      throw new Error("Encryption not configured. Contact your administrator.");
    }

    const encryptedKey = await encrypt(args.key, secret);
    const now = Date.now();

    const existing = await ctx.db
      .query("openRouterKeys")
      .withIndex("by_org", (q) => q.eq("organizationId", args.orgId))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        encryptedKey,
        lastRotatedAt: now,
        createdById: userId,
      });
    } else {
      await ctx.db.insert("openRouterKeys", {
        organizationId: args.orgId,
        encryptedKey,
        lastRotatedAt: now,
        createdById: userId,
      });
    }
  },
});

export const hasKey = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireOrgRole(ctx, args.orgId, ["owner", "admin", "member"]);

    const row = await ctx.db
      .query("openRouterKeys")
      .withIndex("by_org", (q) => q.eq("organizationId", args.orgId))
      .unique();

    return {
      hasKey: row !== null,
      lastRotatedAt: row?.lastRotatedAt ?? null,
    };
  },
});

export const getDecryptedKey = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("openRouterKeys")
      .withIndex("by_org", (q) => q.eq("organizationId", args.orgId))
      .unique();

    if (!row) {
      throw new Error("No OpenRouter key found");
    }

    const secret = process.env.OPENROUTER_KEY_ENCRYPTION_SECRET;
    if (!secret) {
      throw new Error("Encryption not configured");
    }

    return decrypt(row.encryptedKey, secret);
  },
});
