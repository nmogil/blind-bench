/**
 * Wire-contract test for the public /api/v1/* surface.
 *
 * If any of these assertions fail, the API shape is changing — and so is the
 * contract every external agent + the MCP wrapper relies on. Update the
 * snapshot deliberately, bump a version note in CLAUDE.md if appropriate,
 * and update mcp/ tool definitions in the same PR.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";
import { Id } from "../_generated/dataModel";
import {
  hashToken,
  mintToken,
  parseBearer,
  tokenPrefix,
  TOKEN_PREFIX,
} from "../lib/serviceAuth";

describe("service token wire format", () => {
  test("mintToken produces bbst_<env>_<48-hex>", () => {
    const live = mintToken("live");
    expect(live).toMatch(/^bbst_live_[a-f0-9]{48}$/);
    const test_ = mintToken("test");
    expect(test_).toMatch(/^bbst_test_[a-f0-9]{48}$/);
    expect(TOKEN_PREFIX).toBe("bbst_");
  });

  test("hashToken returns 64-char hex (SHA-256)", async () => {
    const t = mintToken("live");
    const h = await hashToken(t);
    expect(h).toMatch(/^[a-f0-9]{64}$/);
    // Determinism
    expect(await hashToken(t)).toBe(h);
  });

  test("tokenPrefix surfaces the first 8 hex chars after env_", () => {
    const t = "bbst_live_abcdef0123456789abcdef0123456789abcdef0123456789ab";
    expect(tokenPrefix(t)).toBe("bbst_live_abcdef01");
  });

  test("parseBearer accepts 'Bearer <token>' and rejects malformed", () => {
    const t = mintToken("live");
    const ok = new Request("https://x", {
      headers: { Authorization: `Bearer ${t}` },
    });
    expect(parseBearer(ok)).toBe(t);

    const wrongScheme = new Request("https://x", {
      headers: { Authorization: `Basic ${t}` },
    });
    expect(parseBearer(wrongScheme)).toBeNull();

    const wrongPrefix = new Request("https://x", {
      headers: { Authorization: "Bearer sk_live_abc" },
    });
    expect(parseBearer(wrongPrefix)).toBeNull();

    const wrongLen = new Request("https://x", {
      headers: { Authorization: "Bearer bbst_live_abc" },
    });
    expect(parseBearer(wrongLen)).toBeNull();
  });
});

async function seedProjectWithToken() {
  const t = convexTest(schema);

  const seed = await t.run(async (ctx) => {
    const ownerUserId = await ctx.db.insert("users", {
      name: "Owner",
      email: "owner@test.com",
    });
    const orgId = await ctx.db.insert("organizations", {
      name: "Org",
      slug: "org",
      createdById: ownerUserId,
    });
    await ctx.db.insert("organizationMembers", {
      organizationId: orgId,
      userId: ownerUserId,
      role: "owner",
    });
    const projectId = await ctx.db.insert("projects", {
      organizationId: orgId,
      name: "Project",
      createdById: ownerUserId,
    });
    await ctx.db.insert("projectCollaborators", {
      projectId,
      userId: ownerUserId,
      role: "owner",
      invitedById: ownerUserId,
      invitedAt: Date.now(),
      acceptedAt: Date.now(),
    });
    return { ownerUserId, orgId, projectId };
  });

  const { token } = await t
    .withIdentity({ subject: seed.ownerUserId })
    .mutation(api.serviceTokens.mint, {
      projectId: seed.projectId,
      name: "test token",
      scopes: ["runs:read", "runs:write", "cycles:read", "cycles:write"],
      actorRole: "editor",
    });

  return { t, ...seed, token };
}

describe("service token validation", () => {
  test("validateAndStamp returns context for a fresh token", async () => {
    const { t, projectId, ownerUserId, token } = await seedProjectWithToken();
    const tokenHash = await hashToken(token);
    const ctx_ = await t.mutation(internal.serviceTokens.validateAndStamp, {
      tokenHash,
    });
    expect(ctx_.projectId).toBe(projectId);
    expect(ctx_.userId).toBe(ownerUserId);
    expect(ctx_.actorRole).toBe("editor");
    expect(ctx_.scopes).toContain("runs:write");
  });

  test("validateAndStamp rejects unknown token", async () => {
    const { t } = await seedProjectWithToken();
    const tokenHash = await hashToken(mintToken("live"));
    await expect(
      t.mutation(internal.serviceTokens.validateAndStamp, { tokenHash }),
    ).rejects.toThrow(/Invalid token/);
  });

  test("validateAndStamp rejects revoked token", async () => {
    const { t, ownerUserId, projectId, token } = await seedProjectWithToken();
    const tokens = await t
      .withIdentity({ subject: ownerUserId })
      .query(api.serviceTokens.list, { projectId });
    const tokenId = tokens[0]!._id as Id<"serviceTokens">;
    await t
      .withIdentity({ subject: ownerUserId })
      .mutation(api.serviceTokens.revoke, { tokenId });

    const tokenHash = await hashToken(token);
    await expect(
      t.mutation(internal.serviceTokens.validateAndStamp, { tokenHash }),
    ).rejects.toThrow(/revoked/);
  });

  test("evaluator-role tokens cannot hold write scopes", async () => {
    const t = convexTest(schema);
    const { ownerUserId, projectId } = await t.run(async (ctx) => {
      const u = await ctx.db.insert("users", { email: "o@test.com" });
      const o = await ctx.db.insert("organizations", {
        name: "X",
        slug: "x",
        createdById: u,
      });
      await ctx.db.insert("organizationMembers", {
        organizationId: o,
        userId: u,
        role: "owner",
      });
      const p = await ctx.db.insert("projects", {
        organizationId: o,
        name: "P",
        createdById: u,
      });
      await ctx.db.insert("projectCollaborators", {
        projectId: p,
        userId: u,
        role: "owner",
        invitedById: u,
        invitedAt: Date.now(),
        acceptedAt: Date.now(),
      });
      return { ownerUserId: u, projectId: p };
    });

    await expect(
      t.withIdentity({ subject: ownerUserId }).mutation(api.serviceTokens.mint, {
        projectId,
        name: "bad",
        scopes: ["runs:write", "evaluator:read"],
        actorRole: "evaluator",
      }),
    ).rejects.toThrow(/Evaluator-role tokens cannot hold/);
  });
});

describe("authoring API contract", () => {
  test("createVersionForToken returns { versionId } and inserts a draft", async () => {
    const { t, projectId, token } = await seedProjectWithToken();
    const tokenHash = await hashToken(token);
    const tokenContext = await t.mutation(
      internal.serviceTokens.validateAndStamp,
      { tokenHash },
    );

    const result = await t.mutation(internal.api.createVersionForToken, {
      tokenContext,
      userMessageTemplate: "Translate {{text}}",
    });
    expect(result).toHaveProperty("versionId");

    const inserted = await t.run(async (ctx) => {
      const versions = await ctx.db
        .query("promptVersions")
        .withIndex("by_project", (q) => q.eq("projectId", projectId))
        .take(10);
      return versions;
    });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.status).toBe("draft");
    expect(inserted[0]!.userMessageTemplate).toBe("Translate {{text}}");
  });
});
