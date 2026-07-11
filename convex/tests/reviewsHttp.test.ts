/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

async function seed() {
  const t = convexTest(schema);
  const ids = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Owner", email: "owner@example.test" });
    const org = await ctx.db.insert("organizations", { name: "Example", slug: "example", createdById: owner });
    await ctx.db.insert("organizationMembers", { organizationId: org, userId: owner, role: "owner" });
    const project = await ctx.db.insert("projects", { organizationId: org, name: "Evaluation", createdById: owner });
    const otherProject = await ctx.db.insert("projects", { organizationId: org, name: "Other", createdById: owner });
    await ctx.db.insert("projectCollaborators", { projectId: project, userId: owner, role: "owner", invitedById: owner, invitedAt: 1 });
    await ctx.db.insert("projectCollaborators", { projectId: otherProject, userId: owner, role: "owner", invitedById: owner, invitedAt: 1 });
    const ready = await insertTrace(ctx, project, owner, "trace-ready", "ready");
    await insertTrace(ctx, project, owner, "trace-pending", "pending");
    await insertTrace(ctx, otherProject, owner, "trace-other", "ready");
    return { owner, project, ready };
  });
  const asOwner = t.withIdentity({ subject: `${ids.owner}|session`, tokenIdentifier: `test|${ids.owner}` });
  return { t, ids, asOwner };
}

type SeedCtx = Parameters<Parameters<ReturnType<typeof convexTest>["run"]>[0]>[0];

async function insertTrace(
  ctx: SeedCtx,
  projectId: Id<"projects">,
  owner: Id<"users">,
  traceId: string,
  status: "pending" | "ready",
) {
  return await ctx.db.insert("agentTraces", {
    projectId,
    traceId,
    source: "agent_harness",
    harnessName: "synthetic",
    product: "example",
    stepCount: 1,
    status,
    privacyClass: "internal",
    importedById: owner,
  });
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });

async function json(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json();
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object response");
  return value as Record<string, unknown>;
}

function safeObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected object");
  }
  return value as Record<string, unknown>;
}

describe("customer reviews HTTP API", () => {
  test("requires valid auth and exact scopes while legacy tokens remain ingest-only", async () => {
    const { t, ids, asOwner } = await seed();
    const missing = await t.fetch("/api/v1/reviews", { method: "POST", body: "{}" });
    expect(missing.status).toBe(401);
    expect(await json(missing)).toHaveProperty("error");

    const invalid = await t.fetch("/api/v1/reviews?id=x", { headers: { "x-blindbench-api-token": "invalid" } });
    expect(invalid.status).toBe(401);

    const legacy = await asOwner.mutation(api.ingestTokens.issueIngestToken, { projectId: ids.project, label: "legacy" });
    const legacyIngest = await t.fetch("/ingest/v1/traces", {
      method: "POST",
      headers: auth(legacy.token),
      body: JSON.stringify({
        version: "1",
        id: "legacy-ingest-smoke",
        input: { messages: [{ role: "user", content: "Synthetic input" }] },
        output: { content: "Synthetic output" },
      }),
    });
    expect(legacyIngest.status).toBe(200);
    expect(await json(legacyIngest)).toMatchObject({ imported: 1, invalid: 0 });
    const denied = await t.fetch("/api/v1/reviews", {
      method: "POST",
      headers: auth(legacy.token),
      body: JSON.stringify({ name: "Review", trace_ids: ["trace-ready"], idempotency_key: "key-1" }),
    });
    expect(denied.status).toBe(403);

    const readOnly = await asOwner.mutation(api.ingestTokens.issueIngestToken, {
      projectId: ids.project,
      label: "read",
      scopes: ["reviews:read"],
    });
    const readDenied = await t.fetch("/api/v1/reviews", {
      method: "POST",
      headers: auth(readOnly.token),
      body: JSON.stringify({ name: "Review", trace_ids: ["trace-ready"], idempotency_key: "key-2" }),
    });
    expect(readDenied.status).toBe(403);
    const ingestDenied = await t.fetch("/ingest/v1/traces", {
      method: "POST",
      headers: auth(readOnly.token),
      body: "{}",
    });
    expect(ingestDenied.status).toBe(403);

    const listed = await asOwner.query(api.ingestTokens.listIngestTokens, { projectId: ids.project });
    expect(listed.find((row) => row.label === "legacy")?.scopes).toEqual(["traces:write"]);
    expect(listed.find((row) => row.label === "read")?.scopes).toEqual(["reviews:read"]);
    expect(JSON.stringify(listed)).not.toContain(legacy.token);
    expect(JSON.stringify(listed)).not.toContain(readOnly.token);
  });

  test("creates and opens once by stable project trace IDs, then returns a leakage-safe status", async () => {
    const { t, ids, asOwner } = await seed();
    const issued = await asOwner.mutation(api.ingestTokens.issueIngestToken, {
      projectId: ids.project,
      label: "automation",
      scopes: ["traces:write", "reviews:write", "reviews:read"],
    });
    const body = { name: "Synthetic review", instructions: "Assess correctness.", trace_ids: ["trace-ready"], idempotency_key: "job-42" };
    const first = await t.fetch("/api/v1/reviews", { method: "POST", headers: auth(issued.token), body: JSON.stringify(body) });
    expect(first.status).toBe(200);
    const created = await json(first);
    expect(created).toMatchObject({ status: "open", item_count: 1 });
    expect(created.review_url).toMatch(/^https:\/\/blindbench\.dev\/review\/verdict\//);
    expect(Object.keys(created).sort()).toEqual(["item_count", "review_id", "review_url", "status"]);

    const replay = await t.fetch("/api/v1/reviews", { method: "POST", headers: auth(issued.token), body: JSON.stringify(body) });
    expect(await json(replay)).toEqual(created);
    const campaigns = await t.run(async (ctx) =>
      await ctx.db.query("verdictReviewCampaigns").collect()
    );
    expect(campaigns).toHaveLength(1);
    expect(campaigns[0]?.idempotencyFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(campaigns[0]?.idempotencyFingerprint).not.toContain("Assess correctness.");

    await t.run(async (ctx) => {
      const campaign = campaigns[0];
      if (!campaign) throw new Error("Missing campaign");
      const item = await ctx.db
        .query("verdictReviewItems")
        .withIndex("by_campaign", (q) => q.eq("campaignId", campaign._id))
        .unique();
      if (!item) throw new Error("Missing review item");
      const firstReviewer = await ctx.db.insert("users", {
        name: "PRIVATE-REVIEWER-ONE",
        email: "reviewer-one@example.test",
      });
      const secondReviewer = await ctx.db.insert("users", {
        name: "PRIVATE-REVIEWER-TWO",
        email: "reviewer-two@example.test",
      });
      for (const [userId, rating, note] of [
        [firstReviewer, "best", "PRIVATE-NOTE-ONE"],
        [secondReviewer, "weak", "PRIVATE-NOTE-TWO"],
      ] as const) {
        await ctx.db.insert("verdictReviewDecisions", {
          campaignId: campaign._id,
          itemId: item._id,
          projectId: ids.project,
          agentTraceId: ids.ready,
          userId,
          rating,
          note,
          decidedAt: 1,
        });
      }
    });

    const readOnly = await asOwner.mutation(api.ingestTokens.issueIngestToken, {
      projectId: ids.project,
      label: "poller",
      scopes: ["reviews:read"],
    });
    const status = await t.fetch(`/api/v1/reviews?id=${String(created.review_id)}`, { headers: { "x-blindbench-api-token": readOnly.token } });
    expect(status.status).toBe(200);
    const safe = await json(status);
    expect(safe).toMatchObject({ status: "open", item_count: 1, judgment_count: 2, reviewed_item_count: 1, aggregate: { best: 1, acceptable: 0, weak: 1, insufficient_evidence: 0, disagreement: 1 } });
    expect(Object.keys(safe).sort()).toEqual([
      "aggregate",
      "item_count",
      "judgment_count",
      "review_id",
      "reviewed_item_count",
      "status",
    ]);
    expect(Object.keys(safeObject(safe.aggregate)).sort()).toEqual([
      "acceptable",
      "best",
      "disagreement",
      "insufficient_evidence",
      "weak",
    ]);
    const serialized = JSON.stringify(safe);
    for (const secret of ["trace-ready", "synthetic", "example", "Assess correctness.", "PRIVATE-REVIEWER-ONE", "PRIVATE-REVIEWER-TWO", "PRIVATE-NOTE-ONE", "PRIVATE-NOTE-TWO", "shareToken", "share_token", "model", "harness", "source", "reviewer", "comment", String(ids.ready)]) {
      expect(serialized).not.toContain(secret);
    }
    const listedAfterRead = await asOwner.query(api.ingestTokens.listIngestTokens, {
      projectId: ids.project,
    });
    expect(listedAfterRead.find((row) => row.label === "poller")?.lastUsedAt).toEqual(
      expect.any(Number),
    );
  });

  test("rejects unknown, not-ready, cross-project, oversized, and conflicting create requests", async () => {
    const { t, ids, asOwner } = await seed();
    const { token } = await asOwner.mutation(api.ingestTokens.issueIngestToken, { projectId: ids.project, label: "automation", scopes: ["reviews:write"] });
    const create = (traceIds: string[], key: string) => t.fetch("/api/v1/reviews", { method: "POST", headers: auth(token), body: JSON.stringify({ name: "Review", trace_ids: traceIds, idempotency_key: key }) });
    expect((await create(["missing"], "missing")).status).toBe(404);
    expect((await create(["trace-pending"], "pending")).status).toBe(409);
    expect((await create(["trace-other"], "other")).status).toBe(404);
    expect((await create(Array.from({ length: 51 }, (_, i) => `trace-${i}`), "large")).status).toBe(413);
    const declaredOversize = await t.fetch("/api/v1/reviews", {
      method: "POST",
      headers: { ...auth(token), "Content-Length": String(256 * 1024 + 1) },
      body: "{}",
    });
    expect(declaredOversize.status).toBe(413);
    expect((await create(["trace-ready"], "same-key")).status).toBe(200);
    expect((await t.fetch("/api/v1/reviews", { method: "POST", headers: auth(token), body: JSON.stringify({ name: "Different", trace_ids: ["trace-ready"], idempotency_key: "same-key" }) })).status).toBe(409);
  });

  test("enforces tenancy, closes idempotently, and rejects a revoked token", async () => {
    const { t, ids, asOwner } = await seed();
    const first = await asOwner.mutation(api.ingestTokens.issueIngestToken, { projectId: ids.project, label: "automation", scopes: ["reviews:write", "reviews:read"] });
    const created = await json(await t.fetch("/api/v1/reviews", { method: "POST", headers: auth(first.token), body: JSON.stringify({ name: "Review", trace_ids: ["trace-ready"], idempotency_key: "close-me" }) }));

    const other = await t.run(async (ctx) => {
      const project = await ctx.db.query("projects").filter((q) => q.eq(q.field("name"), "Other")).unique();
      if (!project) throw new Error("Missing project");
      return project._id;
    });
    const second = await asOwner.mutation(api.ingestTokens.issueIngestToken, { projectId: other, label: "other", scopes: ["reviews:write", "reviews:read"] });
    expect((await t.fetch(`/api/v1/reviews?id=${String(created.review_id)}`, { headers: { Authorization: `Bearer ${second.token}` } })).status).toBe(404);

    const close = () => t.fetch("/api/v1/reviews/close", { method: "POST", headers: auth(first.token), body: JSON.stringify({ review_id: created.review_id }) });
    expect(await json(await close())).toMatchObject({ status: "closed" });
    expect(await json(await close())).toMatchObject({ status: "closed" });

    const listed = await asOwner.query(api.ingestTokens.listIngestTokens, { projectId: ids.project });
    const tokenId = listed.find((row) => row.label === "automation")?._id;
    if (!tokenId) throw new Error("Missing token");
    await asOwner.mutation(api.ingestTokens.revokeIngestToken, { tokenId });
    expect((await t.fetch(`/api/v1/reviews?id=${String(created.review_id)}`, { headers: { Authorization: `Bearer ${first.token}` } })).status).toBe(401);
  });
});
