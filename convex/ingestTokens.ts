/**
 * #263: per-project ingest tokens for the OTLP push endpoint. Opaque 128-bit
 * bearer tokens (generateToken), stored plaintext with a by_token index — the
 * house pattern (invitations); a bearer token only needs comparison. The full
 * token is returned ONCE at creation (the customer configures it in their
 * gateway); the list surface only ever returns a masked prefix. Revoke by
 * setting `revokedAt`. Owner/editor only.
 */
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireProjectRole } from "./lib/auth";
import { generateToken } from "./lib/crypto";

export const issueIngestToken = mutation({
  args: { projectId: v.id("projects"), label: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{ tokenId: Id<"ingestTokens">; token: string }> => {
    const { userId } = await requireProjectRole(ctx, args.projectId, ["owner", "editor"]);
    const label = args.label.trim() || "Ingest token";
    const token = generateToken();
    const tokenId = await ctx.db.insert("ingestTokens", {
      projectId: args.projectId,
      token,
      label,
      createdById: userId,
    });
    // Full token returned ONCE — never surfaced again.
    return { tokenId, token };
  },
});

export const revokeIngestToken = mutation({
  args: { tokenId: v.id("ingestTokens") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.tokenId);
    if (!row) return;
    await requireProjectRole(ctx, row.projectId, ["owner", "editor"]);
    if (!row.revokedAt) await ctx.db.patch(args.tokenId, { revokedAt: Date.now() });
  },
});

export const listIngestTokens = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    await requireProjectRole(ctx, args.projectId, ["owner", "editor"]);
    const rows = await ctx.db
      .query("ingestTokens")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .order("desc")
      .collect();
    return rows.map((r) => ({
      _id: r._id,
      label: r.label,
      // Masked — the full token is only ever shown at creation.
      preview: `${r.token.slice(0, 6)}…${r.token.slice(-4)}`,
      createdAt: r._creationTime,
      lastUsedAt: r.lastUsedAt,
      revoked: r.revokedAt !== undefined,
    }));
  },
});
