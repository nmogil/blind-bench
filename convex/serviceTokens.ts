/**
 * Service token CRUD + the internal validator that gates every /api/v1/* call.
 *
 * Owner-only mint/revoke. Plaintext is returned exactly once at mint time.
 */

import { v } from "convex/values";
import {
  mutation,
  query,
  internalMutation,
} from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { requireProjectRole } from "./lib/auth";
import {
  hashToken,
  mintToken,
  tokenPrefix,
  type Scope,
} from "./lib/serviceAuth";

const SCOPE_VALUES: Scope[] = [
  "runs:read",
  "runs:write",
  "cycles:read",
  "cycles:write",
  "evaluator:read",
  "evaluator:write",
];

const scopeUnion = v.union(
  v.literal("runs:read"),
  v.literal("runs:write"),
  v.literal("cycles:read"),
  v.literal("cycles:write"),
  v.literal("evaluator:read"),
  v.literal("evaluator:write"),
);

// ---------- User-facing CRUD ----------

export const list = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    await requireProjectRole(ctx, args.projectId, ["owner"]);

    const tokens = await ctx.db
      .query("serviceTokens")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .take(100);

    const enriched = [];
    for (const t of tokens) {
      const creator = await ctx.db.get(t.createdById);
      enriched.push({
        _id: t._id,
        name: t.name,
        prefix: t.prefix,
        scopes: t.scopes,
        actorRole: t.actorRole,
        createdAt: t.createdAt,
        expiresAt: t.expiresAt,
        revokedAt: t.revokedAt,
        lastUsedAt: t.lastUsedAt,
        creatorName: creator?.name ?? null,
      });
    }
    return enriched.sort((a, b) => b.createdAt - a.createdAt);
  },
});

export const mint = mutation({
  args: {
    projectId: v.id("projects"),
    name: v.string(),
    scopes: v.array(scopeUnion),
    actorRole: v.union(v.literal("editor"), v.literal("evaluator")),
    expiresAt: v.optional(v.number()),
    env: v.optional(v.union(v.literal("live"), v.literal("test"))),
  },
  handler: async (ctx, args) => {
    const { userId } = await requireProjectRole(ctx, args.projectId, ["owner"]);

    if (args.scopes.length === 0) {
      throw new Error("At least one scope is required");
    }
    for (const s of args.scopes) {
      if (!SCOPE_VALUES.includes(s)) {
        throw new Error(`Unknown scope: ${s}`);
      }
    }
    if (args.actorRole === "evaluator") {
      const writeScopes = args.scopes.filter(
        (s) => s === "runs:write" || s === "cycles:write",
      );
      if (writeScopes.length > 0) {
        throw new Error(
          "Evaluator-role tokens cannot hold runs:write or cycles:write scopes",
        );
      }
    }

    const plaintext = mintToken(args.env ?? "live");
    const tokenHash = await hashToken(plaintext);

    await ctx.db.insert("serviceTokens", {
      projectId: args.projectId,
      name: args.name,
      prefix: tokenPrefix(plaintext),
      tokenHash,
      scopes: args.scopes,
      actorRole: args.actorRole,
      createdById: userId,
      createdAt: Date.now(),
      expiresAt: args.expiresAt,
    });

    // Returned ONCE — the UI must surface this and tell the user to copy it.
    return { token: plaintext, prefix: tokenPrefix(plaintext) };
  },
});

export const revoke = mutation({
  args: { tokenId: v.id("serviceTokens") },
  handler: async (ctx, args) => {
    const token = await ctx.db.get(args.tokenId);
    if (!token) throw new Error("Token not found");

    const { userId } = await requireProjectRole(ctx, token.projectId, ["owner"]);

    if (token.revokedAt) return; // idempotent
    await ctx.db.patch(args.tokenId, {
      revokedAt: Date.now(),
      revokedById: userId,
    });
  },
});

// ---------- Internal: called by HTTP routes to validate Bearer tokens ----------

export type ValidatedTokenContext = {
  tokenId: Id<"serviceTokens">;
  projectId: Id<"projects">;
  userId: Id<"users">; // attribution: token's creator
  scopes: Scope[];
  actorRole: "editor" | "evaluator";
};

/**
 * Hash + look up + validate a Bearer token, then stamp lastUsedAt.
 * Returns the ValidatedTokenContext or throws "Invalid token" / "Token revoked"
 * / "Token expired". Intended to be the FIRST call inside every /api/v1/* route.
 */
export const validateAndStamp = internalMutation({
  args: { tokenHash: v.string() },
  handler: async (ctx, args): Promise<ValidatedTokenContext> => {
    const row = await ctx.db
      .query("serviceTokens")
      .withIndex("by_hash", (q) => q.eq("tokenHash", args.tokenHash))
      .unique();

    if (!row) throw new Error("Invalid token");
    if (row.revokedAt) throw new Error("Token revoked");
    if (row.expiresAt && row.expiresAt < Date.now()) {
      throw new Error("Token expired");
    }

    await ctx.db.patch(row._id, { lastUsedAt: Date.now() });

    return {
      tokenId: row._id,
      projectId: row.projectId,
      userId: row.createdById,
      scopes: row.scopes as Scope[],
      actorRole: row.actorRole,
    };
  },
});
