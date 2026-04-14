import { v } from "convex/values";
import { action, query, internalQuery, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { requireOrgRole } from "./lib/auth";
import { encrypt, decrypt } from "./lib/crypto";

export const verifyOrgOwner = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const { userId } = await requireOrgRole(ctx, args.orgId, ["owner"]);
    return userId;
  },
});

export const storeEncryptedKey = internalMutation({
  args: {
    orgId: v.id("organizations"),
    encryptedKey: v.string(),
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("openRouterKeys")
      .withIndex("by_org", (q) => q.eq("organizationId", args.orgId))
      .unique();

    const isRotation = !!existing;
    const now = Date.now();

    if (existing) {
      await ctx.db.patch(existing._id, {
        encryptedKey: args.encryptedKey,
        lastRotatedAt: now,
        createdById: args.userId,
      });
    } else {
      await ctx.db.insert("openRouterKeys", {
        organizationId: args.orgId,
        encryptedKey: args.encryptedKey,
        lastRotatedAt: now,
        createdById: args.userId,
      });
    }

    await ctx.scheduler.runAfter(0, internal.analyticsActions.track, {
      event: "api key configured",
      distinctId: args.userId as string,
      properties: { org_id: args.orgId as string, is_rotation: isRotation },
    });
  },
});

export const setKey = action({
  args: {
    orgId: v.id("organizations"),
    key: v.string(),
  },
  handler: async (ctx, args) => {
    if (!args.key.trim()) {
      throw new Error("API key cannot be empty");
    }

    // Auth check via internal query (actions can't use ctx.db directly)
    const userId: Id<"users"> = await ctx.runQuery(
      internal.openRouterKeys.verifyOrgOwner,
      { orgId: args.orgId },
    );

    const secret = process.env.OPENROUTER_KEY_ENCRYPTION_SECRET;
    if (!secret) {
      throw new Error("Encryption not configured. Contact your administrator.");
    }

    const encryptedKey = await encrypt(args.key, secret);

    await ctx.runMutation(internal.openRouterKeys.storeEncryptedKey, {
      orgId: args.orgId,
      encryptedKey,
      userId,
    });
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
