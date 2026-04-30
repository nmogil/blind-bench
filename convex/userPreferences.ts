import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireAuth } from "./lib/auth";

export const get = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireAuth(ctx);
    const prefs = await ctx.db
      .query("userPreferences")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    return (
      prefs ?? {
        dismissedCallouts: [] as string[],
        tourStatus: undefined as
          | "unstarted"
          | "in_progress"
          | "skipped"
          | "completed"
          | undefined,
        tourStep: undefined as number | undefined,
        copilotCollapsed: undefined as boolean | undefined,
        copilotDismissed: undefined as boolean | undefined,
        copilotDismissedRings: [] as string[],
      }
    );
  },
});

// M28.3: co-pilot panel visibility — collapse to icon rail and full dismiss.
export const setCopilotCollapsed = mutation({
  args: { collapsed: v.boolean() },
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    const existing = await ctx.db
      .query("userPreferences")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, { copilotCollapsed: args.collapsed });
    } else {
      await ctx.db.insert("userPreferences", {
        userId,
        dismissedCallouts: [],
        copilotCollapsed: args.collapsed,
      });
    }
  },
});

export const setCopilotDismissed = mutation({
  args: { dismissed: v.boolean() },
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    const existing = await ctx.db
      .query("userPreferences")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, { copilotDismissed: args.dismissed });
    } else {
      await ctx.db.insert("userPreferences", {
        userId,
        dismissedCallouts: [],
        copilotDismissed: args.dismissed,
      });
    }
  },
});

// M28.4: append a step key to the user's dismissed-rings list. Idempotent —
// repeated dismissals for the same key are a no-op.
export const dismissCopilotRing = mutation({
  args: { target: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    const existing = await ctx.db
      .query("userPreferences")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();

    if (existing) {
      const current = existing.copilotDismissedRings ?? [];
      if (current.includes(args.target)) return;
      await ctx.db.patch(existing._id, {
        copilotDismissedRings: [...current, args.target],
      });
    } else {
      await ctx.db.insert("userPreferences", {
        userId,
        dismissedCallouts: [],
        copilotDismissedRings: [args.target],
      });
    }
  },
});

// M27.8: tour state mutations
export const setTourStatus = mutation({
  args: {
    status: v.union(
      v.literal("unstarted"),
      v.literal("in_progress"),
      v.literal("skipped"),
      v.literal("completed"),
    ),
    step: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    const existing = await ctx.db
      .query("userPreferences")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();

    const patch: Record<string, unknown> = { tourStatus: args.status };
    if (args.step !== undefined) patch.tourStep = args.step;

    if (existing) {
      await ctx.db.patch(existing._id, patch);
    } else {
      await ctx.db.insert("userPreferences", {
        userId,
        dismissedCallouts: [],
        tourStatus: args.status,
        tourStep: args.step,
      });
    }
  },
});

export const dismissCallout = mutation({
  args: { calloutKey: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    const existing = await ctx.db
      .query("userPreferences")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();

    if (existing) {
      if (!existing.dismissedCallouts.includes(args.calloutKey)) {
        await ctx.db.patch(existing._id, {
          dismissedCallouts: [...existing.dismissedCallouts, args.calloutKey],
        });
      }
    } else {
      await ctx.db.insert("userPreferences", {
        userId,
        dismissedCallouts: [args.calloutKey],
      });
    }
  },
});

export const undismissCallout = mutation({
  args: { calloutKey: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    const existing = await ctx.db
      .query("userPreferences")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        dismissedCallouts: existing.dismissedCallouts.filter(
          (k) => k !== args.calloutKey,
        ),
      });
    }
  },
});

export const resetCallouts = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await requireAuth(ctx);
    const existing = await ctx.db
      .query("userPreferences")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, { dismissedCallouts: [] });
    }
  },
});
