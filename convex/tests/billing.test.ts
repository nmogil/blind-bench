import { convexTest } from "convex-test";
import { expect, test, describe } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { ensureTrialCreditGrant } from "../lib/billingCredits";
import schema from "../schema";

async function seedBillingEnv() {
  const t = convexTest(schema);
  const ids = await t.run(async (ctx) => {
    const ownerUserId = await ctx.db.insert("users", {
      name: "Owner",
      email: "owner@test.com",
    });
    const orgId = await ctx.db.insert("organizations", {
      name: "Acme",
      slug: "acme",
      createdById: ownerUserId,
    });
    await ctx.db.insert("organizationMembers", {
      organizationId: orgId,
      userId: ownerUserId,
      role: "owner",
    });
    return { ownerUserId, orgId };
  });

  const asOwner = t.withIdentity({
    subject: `${ids.ownerUserId}|s`,
    tokenIdentifier: `test|${ids.ownerUserId}`,
  });
  return { t, ids, asOwner };
}

function orderPaid(orgId: string, eventId: string, orderId: string) {
  return {
    eventId,
    eventType: "order.paid",
    externalCustomerId: orgId,
    packageKey: "team",
    polarCustomerId: "cus_123",
    polarOrderId: orderId,
    polarSubscriptionId: "sub_123",
  };
}

type BillingHarness = Awaited<ReturnType<typeof seedBillingEnv>>["t"];

async function seedRunBillingEnv(initialCredits: number) {
  const t = convexTest(schema);
  const ids = await t.run(async (ctx) => {
    const ownerUserId = await ctx.db.insert("users", {
      name: "Owner",
      email: "owner@test.com",
    });
    const orgId = await ctx.db.insert("organizations", {
      name: "Acme",
      slug: `acme-${initialCredits}`,
      createdById: ownerUserId,
    });
    await ctx.db.insert("organizationMembers", {
      organizationId: orgId,
      userId: ownerUserId,
      role: "owner",
    });
    const projectId = await ctx.db.insert("projects", {
      organizationId: orgId,
      name: "Support Agent",
      createdById: ownerUserId,
    });
    await ctx.db.insert("projectCollaborators", {
      projectId,
      userId: ownerUserId,
      role: "owner",
      invitedById: ownerUserId,
      invitedAt: Date.now(),
    });
    const versionId = await ctx.db.insert("promptVersions", {
      projectId,
      versionNumber: 1,
      userMessageTemplate: "Help {{name}}.",
      status: "current",
      messages: [
        { id: "m-system", role: "system", content: "You are a support agent." },
        { id: "m-user", role: "user", content: "Help {{name}}." },
      ],
      createdById: ownerUserId,
    });
    const testCaseId = await ctx.db.insert("testCases", {
      projectId,
      name: "Ada",
      variableValues: { name: "Ada" },
      attachmentIds: [],
      order: 0,
      createdById: ownerUserId,
    });
    if (initialCredits > 0) {
      await ctx.db.insert("billingLedger", {
        organizationId: orgId,
        creditDelta: initialCredits,
        reason: "test_grant",
        createdAt: Date.now(),
      });
    }
    return { ownerUserId, orgId, projectId, versionId, testCaseId };
  });

  const asOwner = t.withIdentity({
    subject: `${ids.ownerUserId}|s`,
    tokenIdentifier: `test|${ids.ownerUserId}`,
  });
  return { t, ids, asOwner };
}

async function remainingCredits(
  t: BillingHarness,
  orgId: Id<"organizations">,
): Promise<number> {
  return await t.run(async (ctx) => {
    const rows = await ctx.db
      .query("billingLedger")
      .withIndex("by_org", (q) => q.eq("organizationId", orgId))
      .collect();
    return rows.reduce((sum, row) => sum + row.creditDelta, 0);
  });
}

describe("applyPolarEvent", () => {
  test("order.paid grants entitlement + credits", async () => {
    const { t, ids } = await seedBillingEnv();
    const res = await t.mutation(
      internal.billing.applyPolarEvent,
      orderPaid(ids.orgId, "evt_1", "ord_1"),
    );
    expect(res).toMatchObject({
      duplicate: false,
      action: "granted",
      creditDelta: 2500,
      entitlementStatus: "active",
      packageKey: "team",
    });

    await t.run(async (ctx) => {
      const ledger = await ctx.db
        .query("billingLedger")
        .withIndex("by_org", (q) => q.eq("organizationId", ids.orgId))
        .collect();
      expect(ledger).toHaveLength(1);
      expect(ledger[0]!.creditDelta).toBe(2500);

      const ent = await ctx.db
        .query("billingEntitlements")
        .withIndex("by_org", (q) => q.eq("organizationId", ids.orgId))
        .collect();
      expect(ent).toHaveLength(1);
      expect(ent[0]!.status).toBe("active");
      expect(ent[0]!.packageKey).toBe("team");

      const cust = await ctx.db
        .query("billingCustomers")
        .withIndex("by_org", (q) => q.eq("organizationId", ids.orgId))
        .unique();
      expect(cust?.polarCustomerId).toBe("cus_123");
    });
  });

  test("redelivery of same event id is a no-op", async () => {
    const { t, ids } = await seedBillingEnv();
    await t.mutation(internal.billing.applyPolarEvent, orderPaid(ids.orgId, "evt_1", "ord_1"));
    const dup = await t.mutation(
      internal.billing.applyPolarEvent,
      orderPaid(ids.orgId, "evt_1", "ord_1"),
    );
    expect(dup).toMatchObject({ duplicate: true });

    await t.run(async (ctx) => {
      const ledger = await ctx.db
        .query("billingLedger")
        .withIndex("by_org", (q) => q.eq("organizationId", ids.orgId))
        .collect();
      expect(ledger).toHaveLength(1); // not doubled
    });
  });

  test("same order via a new event id never double-credits", async () => {
    const { t, ids } = await seedBillingEnv();
    await t.mutation(internal.billing.applyPolarEvent, orderPaid(ids.orgId, "evt_1", "ord_1"));
    const second = await t.mutation(
      internal.billing.applyPolarEvent,
      orderPaid(ids.orgId, "evt_2", "ord_1"),
    );
    expect(second).toMatchObject({ action: "duplicate_order", creditDelta: 0 });

    const credits = await t.run(async (ctx) => {
      const ledger = await ctx.db
        .query("billingLedger")
        .withIndex("by_org", (q) => q.eq("organizationId", ids.orgId))
        .collect();
      return ledger.reduce((a, r) => a + r.creditDelta, 0);
    });
    expect(credits).toBe(2500);
  });

  test("refund reverses the grant and revokes entitlement", async () => {
    const { t, ids } = await seedBillingEnv();
    await t.mutation(internal.billing.applyPolarEvent, orderPaid(ids.orgId, "evt_1", "ord_1"));
    const refund = await t.mutation(internal.billing.applyPolarEvent, {
      eventId: "evt_refund",
      eventType: "order.refunded",
      externalCustomerId: ids.orgId,
      polarOrderId: "ord_1",
    });
    expect(refund).toMatchObject({
      action: "refunded",
      creditDelta: -2500,
      entitlementStatus: "revoked",
    });

    const credits = await t.run(async (ctx) => {
      const ledger = await ctx.db
        .query("billingLedger")
        .withIndex("by_org", (q) => q.eq("organizationId", ids.orgId))
        .collect();
      const ent = await ctx.db
        .query("billingEntitlements")
        .withIndex("by_org", (q) => q.eq("organizationId", ids.orgId))
        .collect();
      expect(ent[0]!.status).toBe("revoked");
      return ledger.reduce((a, r) => a + r.creditDelta, 0);
    });
    expect(credits).toBe(0);
  });

  test("subscription.revoked revokes without ledger change", async () => {
    const { t, ids } = await seedBillingEnv();
    await t.mutation(internal.billing.applyPolarEvent, orderPaid(ids.orgId, "evt_1", "ord_1"));
    const revoke = await t.mutation(internal.billing.applyPolarEvent, {
      eventId: "evt_revoke",
      eventType: "subscription.revoked",
      externalCustomerId: ids.orgId,
      polarSubscriptionId: "sub_123",
    });
    expect(revoke).toMatchObject({ action: "revoked", creditDelta: 0 });

    const credits = await t.run(async (ctx) => {
      const ledger = await ctx.db
        .query("billingLedger")
        .withIndex("by_org", (q) => q.eq("organizationId", ids.orgId))
        .collect();
      return ledger.reduce((a, r) => a + r.creditDelta, 0);
    });
    expect(credits).toBe(2500); // credits untouched on cancel
  });

  test("unknown org is ignored, not an error", async () => {
    const { t, ids } = await seedBillingEnv();
    const res = await t.mutation(internal.billing.applyPolarEvent, {
      eventId: "evt_x",
      eventType: "order.paid",
      externalCustomerId: "not-a-real-id",
      packageKey: "team",
      polarOrderId: "ord_9",
    });
    expect(res).toMatchObject({ action: "ignored_unknown_org" });
    void ids;
  });

  test("unsupported event type is acknowledged and ignored", async () => {
    const { t, ids } = await seedBillingEnv();
    const res = await t.mutation(internal.billing.applyPolarEvent, {
      eventId: "evt_unsup",
      eventType: "customer.updated",
      externalCustomerId: ids.orgId,
    });
    expect(res).toMatchObject({ action: "ignored_unsupported" });
  });

  test("metadata-less order.paid resolves package by known product id", async () => {
    const prevTeamProduct = process.env.POLAR_PRODUCT_TEAM;
    process.env.POLAR_PRODUCT_TEAM = "prod_team_known";
    try {
      const { t, ids } = await seedBillingEnv();
      const res = await t.mutation(internal.billing.applyPolarEvent, {
        eventId: "evt_product_only",
        eventType: "order.paid",
        externalCustomerId: ids.orgId,
        polarProductId: "prod_team_known",
        polarOrderId: "ord_product_only",
      });
      expect(res).toMatchObject({
        action: "granted",
        packageKey: "team",
        creditDelta: 2500,
      });
    } finally {
      if (prevTeamProduct === undefined) delete process.env.POLAR_PRODUCT_TEAM;
      else process.env.POLAR_PRODUCT_TEAM = prevTeamProduct;
    }
  });

  test("metadata-less order.paid with unknown product id is ignored", async () => {
    const prevTeamProduct = process.env.POLAR_PRODUCT_TEAM;
    process.env.POLAR_PRODUCT_TEAM = "prod_team_known";
    try {
      const { t, ids } = await seedBillingEnv();
      const res = await t.mutation(internal.billing.applyPolarEvent, {
        eventId: "evt_product_unknown",
        eventType: "order.paid",
        externalCustomerId: ids.orgId,
        polarProductId: "prod_unknown",
        polarOrderId: "ord_product_unknown",
      });
      expect(res).toMatchObject({ action: "ignored_unknown_package" });
      expect(await remainingCredits(t, ids.orgId)).toBe(0);
    } finally {
      if (prevTeamProduct === undefined) delete process.env.POLAR_PRODUCT_TEAM;
      else process.env.POLAR_PRODUCT_TEAM = prevTeamProduct;
    }
  });
});

describe("trial grants and credit consumption", () => {
  test("createOrg seeds exactly one trial grant promised by billing UI", async () => {
    const t = convexTest(schema);
    const userId = await t.run(async (ctx) =>
      ctx.db.insert("users", { name: "Owner", email: "owner@test.com" }),
    );
    const asOwner = t.withIdentity({
      subject: `${userId}|s`,
      tokenIdentifier: `test|${userId}`,
    });

    const orgId = await asOwner.mutation(api.organizations.createOrg, {
      name: "Trial Org",
      slug: "trial-org",
    });

    const overview = await asOwner.query(api.billing.getBillingOverview, {
      orgId,
    });
    expect(overview.remainingCredits).toBe(50);
    expect(overview.ledger).toHaveLength(1);
    expect(overview.ledger[0]).toMatchObject({
      creditDelta: 50,
      reason: "trial_grant",
    });
  });

  test("trial grant helper is idempotent for an org", async () => {
    const { t, ids } = await seedBillingEnv();
    await t.run(async (ctx) => {
      await ensureTrialCreditGrant(ctx, ids.orgId);
      await ensureTrialCreditGrant(ctx, ids.orgId);
    });

    const ledger = await t.run(async (ctx) =>
      ctx.db
        .query("billingLedger")
        .withIndex("by_org", (q) => q.eq("organizationId", ids.orgId))
        .collect(),
    );
    expect(ledger.filter((row) => row.reason === "trial_grant")).toHaveLength(1);
    expect(await remainingCredits(t, ids.orgId)).toBe(50);
  });

  test("prompt runs fail closed at zero credits", async () => {
    const { asOwner, ids } = await seedRunBillingEnv(0);
    await expect(
      asOwner.mutation(api.runs.execute, {
        versionId: ids.versionId,
        testCaseId: ids.testCaseId,
        model: "openai/gpt-4",
        temperature: 0.7,
      }),
    ).rejects.toThrow("Out of eval credits");
  });

  test("prompt runs consume one credit and are idempotent per run row", async () => {
    const { t, asOwner, ids } = await seedRunBillingEnv(2);
    const runId = await asOwner.mutation(api.runs.execute, {
      versionId: ids.versionId,
      testCaseId: ids.testCaseId,
      model: "openai/gpt-4",
      temperature: 0.7,
    });
    expect(runId).toBeTruthy();
    expect(await remainingCredits(t, ids.orgId)).toBe(1);

    const promptRunLedger = await t.run(async (ctx) =>
      ctx.db
        .query("billingLedger")
        .withIndex("by_prompt_run", (q) => q.eq("promptRunId", runId))
        .collect(),
    );
    expect(promptRunLedger).toHaveLength(1);
    expect(promptRunLedger[0]!.creditDelta).toBe(-1);
    expect(promptRunLedger[0]!.reason).toBe("eval_consumption");
  });

  test("concurrent prompt-run starts cannot overspend the last credit", async () => {
    const { t, asOwner, ids } = await seedRunBillingEnv(1);
    const attempts = await Promise.allSettled([
      asOwner.mutation(api.runs.execute, {
        versionId: ids.versionId,
        testCaseId: ids.testCaseId,
        model: "openai/gpt-4",
        temperature: 0.7,
      }),
      asOwner.mutation(api.runs.execute, {
        versionId: ids.versionId,
        testCaseId: ids.testCaseId,
        model: "openai/gpt-4",
        temperature: 0.7,
      }),
    ]);

    expect(attempts.filter((a) => a.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((a) => a.status === "rejected")).toHaveLength(1);
    expect(await remainingCredits(t, ids.orgId)).toBe(0);
  });

  test("scorecard runs consume one credit", async () => {
    const { t, asOwner, ids } = await seedRunBillingEnv(1);
    const runId = await asOwner.mutation(api.scorecards.start, {
      orgId: ids.orgId,
    });
    expect(runId).toBeTruthy();
    expect(await remainingCredits(t, ids.orgId)).toBe(0);
  });

  test("scorecard runs fail closed at zero credits", async () => {
    const { asOwner, ids } = await seedRunBillingEnv(0);
    await expect(
      asOwner.mutation(api.scorecards.start, { orgId: ids.orgId }),
    ).rejects.toThrow("Out of eval credits");
  });
});

describe("getBillingOverview", () => {
  test("owner sees catalog + remaining credits", async () => {
    const { t, ids, asOwner } = await seedBillingEnv();
    await t.mutation(internal.billing.applyPolarEvent, orderPaid(ids.orgId, "evt_1", "ord_1"));
    const overview = await asOwner.query(api.billing.getBillingOverview, {
      orgId: ids.orgId,
    });
    expect(overview.remainingCredits).toBe(2500);
    expect(overview.entitlement).toMatchObject({ packageKey: "team", status: "active" });
    expect(overview.packages.length).toBeGreaterThan(0);
    expect(overview.packages.some((p) => p.manualEnterprise)).toBe(true);
  });

  test("non-owner is denied", async () => {
    const { t, ids } = await seedBillingEnv();
    const memberId = await t.run(async (ctx) => {
      const u = await ctx.db.insert("users", { name: "M", email: "m@test.com" });
      await ctx.db.insert("organizationMembers", {
        organizationId: ids.orgId,
        userId: u,
        role: "member",
      });
      return u;
    });
    const asMember = t.withIdentity({
      subject: `${memberId}|s`,
      tokenIdentifier: `test|${memberId}`,
    });
    await expect(
      asMember.query(api.billing.getBillingOverview, { orgId: ids.orgId }),
    ).rejects.toThrow("Permission denied");
  });
});
