import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireAuth, requireOrgRole } from "./lib/auth";

const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/;

export const createOrg = mutation({
  args: {
    name: v.string(),
    slug: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);

    const slug = args.slug.toLowerCase();
    if (!SLUG_REGEX.test(slug)) {
      throw new Error(
        "Slug must be 3-48 characters, lowercase alphanumeric and hyphens only",
      );
    }

    const existing = await ctx.db
      .query("organizations")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique();
    if (existing) {
      throw new Error("This URL is already taken");
    }

    const orgId = await ctx.db.insert("organizations", {
      name: args.name,
      slug,
      createdById: userId,
    });

    await ctx.db.insert("organizationMembers", {
      organizationId: orgId,
      userId,
      role: "owner",
    });

    return orgId;
  },
});

export const listMyOrgs = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireAuth(ctx);
    const memberships = await ctx.db
      .query("organizationMembers")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(100);

    const results = [];
    for (const m of memberships) {
      const org = await ctx.db.get(m.organizationId);
      if (org) {
        results.push({ org, role: m.role });
      }
    }
    return results;
  },
});

export const getOrgBySlug = query({
  args: { slug: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    const org = await ctx.db
      .query("organizations")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .unique();
    if (!org) return null;

    const membership = await ctx.db
      .query("organizationMembers")
      .withIndex("by_org_and_user", (q) =>
        q.eq("organizationId", org._id).eq("userId", userId),
      )
      .unique();
    if (!membership) return null;

    return { org, role: membership.role };
  },
});

export const getOrg = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const { membership } = await requireOrgRole(ctx, args.orgId, [
      "owner",
      "admin",
      "member",
    ]);
    const org = await ctx.db.get(args.orgId);
    return { org, role: membership.role };
  },
});

export const updateOrg = mutation({
  args: {
    orgId: v.id("organizations"),
    name: v.optional(v.string()),
    slug: v.optional(v.string()),
    logoUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOrgRole(ctx, args.orgId, ["owner"]);

    const updates: Record<string, string> = {};
    if (args.name !== undefined) updates.name = args.name;
    if (args.logoUrl !== undefined) updates.logoUrl = args.logoUrl;

    if (args.slug !== undefined) {
      const slug = args.slug.toLowerCase();
      if (!SLUG_REGEX.test(slug)) {
        throw new Error(
          "Slug must be 3-48 characters, lowercase alphanumeric and hyphens only",
        );
      }
      const existing = await ctx.db
        .query("organizations")
        .withIndex("by_slug", (q) => q.eq("slug", slug))
        .unique();
      if (existing && existing._id !== args.orgId) {
        throw new Error("This URL is already taken");
      }
      updates.slug = slug;
    }

    await ctx.db.patch(args.orgId, updates);
  },
});

export const listMembers = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireOrgRole(ctx, args.orgId, ["owner"]);
    const memberships = await ctx.db
      .query("organizationMembers")
      .withIndex("by_org", (q) => q.eq("organizationId", args.orgId))
      .take(200);

    const results = [];
    for (const m of memberships) {
      const user = await ctx.db.get(m.userId);
      if (user) {
        results.push({
          _id: m._id,
          userId: m.userId,
          role: m.role,
          name: user.name,
          email: user.email,
          image: user.image,
        });
      }
    }
    return results;
  },
});

export const inviteMember = mutation({
  args: {
    orgId: v.id("organizations"),
    userId: v.id("users"),
    role: v.union(v.literal("owner"), v.literal("admin"), v.literal("member")),
  },
  handler: async (ctx, args) => {
    await requireOrgRole(ctx, args.orgId, ["owner"]);

    const existing = await ctx.db
      .query("organizationMembers")
      .withIndex("by_org_and_user", (q) =>
        q.eq("organizationId", args.orgId).eq("userId", args.userId),
      )
      .unique();
    if (existing) {
      throw new Error("User is already a member of this organization");
    }

    await ctx.db.insert("organizationMembers", {
      organizationId: args.orgId,
      userId: args.userId,
      role: args.role,
    });
  },
});

export const updateMemberRole = mutation({
  args: {
    orgId: v.id("organizations"),
    userId: v.id("users"),
    role: v.union(v.literal("owner"), v.literal("admin"), v.literal("member")),
  },
  handler: async (ctx, args) => {
    const { userId: callerId } = await requireOrgRole(ctx, args.orgId, [
      "owner",
    ]);

    const membership = await ctx.db
      .query("organizationMembers")
      .withIndex("by_org_and_user", (q) =>
        q.eq("organizationId", args.orgId).eq("userId", args.userId),
      )
      .unique();
    if (!membership) {
      throw new Error("User is not a member of this organization");
    }

    // Prevent removing the sole owner
    if (
      membership.role === "owner" &&
      args.role !== "owner" &&
      args.userId === callerId
    ) {
      const owners = await ctx.db
        .query("organizationMembers")
        .withIndex("by_org", (q) => q.eq("organizationId", args.orgId))
        .take(200);
      const ownerCount = owners.filter((m) => m.role === "owner").length;
      if (ownerCount <= 1) {
        throw new Error("Cannot remove the sole owner");
      }
    }

    await ctx.db.patch(membership._id, { role: args.role });
  },
});

export const removeMember = mutation({
  args: {
    orgId: v.id("organizations"),
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    await requireOrgRole(ctx, args.orgId, ["owner"]);

    const membership = await ctx.db
      .query("organizationMembers")
      .withIndex("by_org_and_user", (q) =>
        q.eq("organizationId", args.orgId).eq("userId", args.userId),
      )
      .unique();
    if (!membership) {
      throw new Error("User is not a member of this organization");
    }

    // Prevent removing the sole owner
    if (membership.role === "owner") {
      const owners = await ctx.db
        .query("organizationMembers")
        .withIndex("by_org", (q) => q.eq("organizationId", args.orgId))
        .take(200);
      const ownerCount = owners.filter((m) => m.role === "owner").length;
      if (ownerCount <= 1) {
        throw new Error("Cannot remove the sole owner");
      }
    }

    // Cascade: remove from all projects in this org
    const projects = await ctx.db
      .query("projects")
      .withIndex("by_org", (q) => q.eq("organizationId", args.orgId))
      .take(500);
    for (const project of projects) {
      const collab = await ctx.db
        .query("projectCollaborators")
        .withIndex("by_project_and_user", (q) =>
          q.eq("projectId", project._id).eq("userId", args.userId),
        )
        .unique();
      if (collab) {
        await ctx.db.delete(collab._id);
      }
    }

    await ctx.db.delete(membership._id);
  },
});
