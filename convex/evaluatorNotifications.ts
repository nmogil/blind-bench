import { v } from "convex/values";
import { mutation, query, internalMutation } from "./_generated/server";
import { requireAuth } from "./lib/auth";

// ---------------------------------------------------------------------------
// Public queries
// ---------------------------------------------------------------------------

export const listMyNotifications = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireAuth(ctx);

    const notifications = await ctx.db
      .query("evaluatorNotifications")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(50);

    // Enrich with project name
    const enriched = [];
    for (const n of notifications) {
      const project = await ctx.db.get(n.projectId);
      enriched.push({
        _id: n._id,
        type: n.type,
        message: n.message,
        read: n.read,
        projectName: project?.name ?? null,
        createdAt: n._creationTime,
      });
    }

    return enriched.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  },
});

export const countUnread = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireAuth(ctx);

    const unread = await ctx.db
      .query("evaluatorNotifications")
      .withIndex("by_user_read", (q) =>
        q.eq("userId", userId).eq("read", false),
      )
      .take(100);

    return unread.length;
  },
});

// ---------------------------------------------------------------------------
// Public mutations
// ---------------------------------------------------------------------------

export const markRead = mutation({
  args: { notificationId: v.id("evaluatorNotifications") },
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    const notification = await ctx.db.get(args.notificationId);
    if (!notification) throw new Error("Notification not found");
    if (notification.userId !== userId) throw new Error("Permission denied");

    await ctx.db.patch(args.notificationId, { read: true });
  },
});

export const markAllRead = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await requireAuth(ctx);

    const unread = await ctx.db
      .query("evaluatorNotifications")
      .withIndex("by_user_read", (q) =>
        q.eq("userId", userId).eq("read", false),
      )
      .take(100);

    for (const n of unread) {
      await ctx.db.patch(n._id, { read: true });
    }
  },
});

// ---------------------------------------------------------------------------
// Internal mutation: create notifications for all evaluators on a project
// ---------------------------------------------------------------------------

export const notifyEvaluators = internalMutation({
  args: {
    projectId: v.id("projects"),
    type: v.union(v.literal("new_run"), v.literal("feedback_used")),
    message: v.string(),
  },
  handler: async (ctx, args) => {
    const collaborators = await ctx.db
      .query("projectCollaborators")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .take(200);

    const evaluators = collaborators.filter((c) => c.role === "evaluator");

    for (const evaluator of evaluators) {
      await ctx.db.insert("evaluatorNotifications", {
        userId: evaluator.userId,
        projectId: args.projectId,
        type: args.type,
        message: args.message,
        read: false,
      });
    }
  },
});
