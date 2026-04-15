import { MutationCtx, QueryCtx } from "../_generated/server";
import { Id } from "../_generated/dataModel";
import { generateToken } from "./crypto";

const CYCLE_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Mint a new cycle eval token. Internal use only. */
export async function mintCycleEvalToken(
  ctx: MutationCtx,
  cycleId: Id<"reviewCycles">,
  projectId: Id<"projects">,
): Promise<string> {
  const token = generateToken();
  await ctx.db.insert("cycleEvalTokens", {
    token,
    cycleId,
    projectId,
    expiresAt: Date.now() + CYCLE_TOKEN_TTL_MS,
  });
  return token;
}

/** Resolve an opaque cycle token. Returns null if not found or expired. */
export async function resolveCycleEvalToken(
  ctx: QueryCtx,
  token: string,
): Promise<{
  cycleId: Id<"reviewCycles">;
  projectId: Id<"projects">;
} | null> {
  const doc = await ctx.db
    .query("cycleEvalTokens")
    .withIndex("by_token", (q) => q.eq("token", token))
    .unique();
  if (!doc || doc.expiresAt < Date.now()) return null;
  return { cycleId: doc.cycleId, projectId: doc.projectId };
}

/** Refresh a cycle eval token: generate new token string and update expiry. */
export async function refreshCycleEvalToken(
  ctx: MutationCtx,
  cycleId: Id<"reviewCycles">,
): Promise<string> {
  const existing = await ctx.db
    .query("cycleEvalTokens")
    .withIndex("by_cycle", (q) => q.eq("cycleId", cycleId))
    .unique();

  const newToken = generateToken();
  const newExpiry = Date.now() + CYCLE_TOKEN_TTL_MS;

  if (existing) {
    await ctx.db.patch(existing._id, {
      token: newToken,
      expiresAt: newExpiry,
    });
  } else {
    const cycle = await ctx.db.get(cycleId);
    if (!cycle) throw new Error("Cycle not found");
    await ctx.db.insert("cycleEvalTokens", {
      token: newToken,
      cycleId,
      projectId: cycle.projectId,
      expiresAt: newExpiry,
    });
  }

  return newToken;
}
