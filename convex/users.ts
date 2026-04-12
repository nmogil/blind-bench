import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireAuth } from "./lib/auth";

export const viewer = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      return null;
    }
    return await ctx.db.get(userId);
  },
});

export const findByEmail = query({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    await requireAuth(ctx);
    const user = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", args.email))
      .unique();
    if (!user) return null;
    return { _id: user._id, name: user.name, email: user.email, image: user.image };
  },
});
