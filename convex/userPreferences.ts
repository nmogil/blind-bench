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
    return prefs ?? { dismissedCallouts: [] as string[] };
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
