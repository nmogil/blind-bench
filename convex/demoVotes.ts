import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

export const castVote = internalMutation({
  args: { choice: v.union(v.literal("A"), v.literal("B")) },
  handler: async (ctx, args) => {
    await ctx.db.insert("demoVotes", { choice: args.choice });

    const stats = await ctx.db.query("demoVoteStats").first();
    if (stats) {
      await ctx.db.patch(stats._id, {
        countA: stats.countA + (args.choice === "A" ? 1 : 0),
        countB: stats.countB + (args.choice === "B" ? 1 : 0),
      });
    } else {
      await ctx.db.insert("demoVoteStats", {
        countA: args.choice === "A" ? 1 : 0,
        countB: args.choice === "B" ? 1 : 0,
      });
    }
  },
});

export const getStats = internalQuery({
  args: {},
  handler: async (ctx) => {
    const stats = await ctx.db.query("demoVoteStats").first();
    if (!stats) {
      return { totalVotes: 0, percentA: 0, percentB: 0 };
    }
    const total = stats.countA + stats.countB;
    return {
      totalVotes: total,
      percentA: total > 0 ? Math.round((stats.countA / total) * 100) : 0,
      percentB: total > 0 ? Math.round((stats.countB / total) * 100) : 0,
    };
  },
});
