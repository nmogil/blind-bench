import { MutationCtx, QueryCtx } from "../_generated/server";
import { Id } from "../_generated/dataModel";

const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

/** Generate a URL-safe random token that cannot contain Convex IDs as substrings. */
function generateToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // Convert to hex — contains only [0-9a-f], safe from Convex ID substrings
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Mint a new eval token for a completed run. Internal use only. */
export async function mintEvalToken(
  ctx: MutationCtx,
  runId: Id<"promptRuns">,
  projectId: Id<"projects">,
): Promise<string> {
  const token = generateToken();
  await ctx.db.insert("evalTokens", {
    token,
    runId,
    projectId,
    expiresAt: Date.now() + TOKEN_TTL_MS,
  });
  return token;
}

/** Resolve an opaque token to its run and project. Returns null if not found. */
export async function resolveEvalToken(
  ctx: QueryCtx,
  token: string,
): Promise<{ runId: Id<"promptRuns">; projectId: Id<"projects"> } | null> {
  const doc = await ctx.db
    .query("evalTokens")
    .withIndex("by_token", (q) => q.eq("token", token))
    .unique();
  if (!doc) return null;
  return { runId: doc.runId, projectId: doc.projectId };
}

/** Refresh an expired token: generate new token string and update expiry. */
export async function refreshEvalToken(
  ctx: MutationCtx,
  runId: Id<"promptRuns">,
): Promise<string> {
  const existing = await ctx.db
    .query("evalTokens")
    .withIndex("by_run", (q) => q.eq("runId", runId))
    .unique();

  const newToken = generateToken();
  const newExpiry = Date.now() + TOKEN_TTL_MS;

  if (existing) {
    await ctx.db.patch(existing._id, {
      token: newToken,
      expiresAt: newExpiry,
    });
  } else {
    // Should not happen, but handle gracefully
    const run = await ctx.db.get(runId);
    if (!run) throw new Error("Run not found");
    await ctx.db.insert("evalTokens", {
      token: newToken,
      runId,
      projectId: run.projectId,
      expiresAt: newExpiry,
    });
  }

  return newToken;
}
