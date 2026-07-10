import { internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

const ORPHAN_TTL_MS = 24 * 60 * 60 * 1000;
const BATCH_SIZE = 200;

/**
 * M30: reap orphan guest accounts. `signIn("anonymous")` is reachable from the
 * public invite page, so a bot — or a user who bails before accepting — can
 * mint empty anonymous users. An anon user that never accepted a reviewer
 * invite has no projectCollaborators row: it is inert (can see and do nothing)
 * and safe to delete. We keep any anon user that became an evaluator or
 * redeemed an opaque review session so their in-flight campaign, comments,
 * identity label, and judgments survive.
 *
 * Deleting a Convex Auth user means cascading its auth rows by hand
 * (authSessions → authRefreshTokens, authAccounts → authVerificationCodes);
 * the library exposes no destroy helper.
 */
export const cleanupAnonUsers = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - ORPHAN_TTL_MS;
    // Oldest-first: once we reach a user newer than the cutoff, the rest are
    // newer too, so we can stop.
    const candidates = await ctx.db
      .query("users")
      .withIndex("by_anonymous", (q) => q.eq("isAnonymous", true))
      .order("asc")
      .take(BATCH_SIZE);

    let deleted = 0;
    for (const user of candidates) {
      if (user._creationTime >= cutoff) break;
      const collaborator = await ctx.db
        .query("projectCollaborators")
        .withIndex("by_user", (q) => q.eq("userId", user._id))
        .first();
      if (collaborator) continue; // active project reviewer — keep
      const reviewSession = await ctx.db
        .query("agentTraceReviewSessions")
        .withIndex("by_reviewer", (q) => q.eq("reviewerUserId", user._id))
        .first();
      if (reviewSession) continue; // opaque/campaign reviewer — keep

      await deleteAuthUser(ctx, user._id);
      deleted++;
    }
    return { scanned: candidates.length, deleted };
  },
});

async function deleteAuthUser(
  ctx: MutationCtx,
  userId: Id<"users">,
): Promise<void> {
  const sessions = await ctx.db
    .query("authSessions")
    .withIndex("userId", (q) => q.eq("userId", userId))
    .collect();
  for (const session of sessions) {
    const tokens = await ctx.db
      .query("authRefreshTokens")
      .withIndex("sessionId", (q) => q.eq("sessionId", session._id))
      .collect();
    for (const token of tokens) await ctx.db.delete(token._id);
    await ctx.db.delete(session._id);
  }

  const accounts = await ctx.db
    .query("authAccounts")
    .withIndex("userIdAndProvider", (q) => q.eq("userId", userId))
    .collect();
  for (const account of accounts) {
    const codes = await ctx.db
      .query("authVerificationCodes")
      .withIndex("accountId", (q) => q.eq("accountId", account._id))
      .collect();
    for (const code of codes) await ctx.db.delete(code._id);
    await ctx.db.delete(account._id);
  }

  await ctx.db.delete(userId);
}
