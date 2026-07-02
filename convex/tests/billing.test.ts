import { convexTest } from "convex-test";
import { expect, test, describe } from "vitest";
import { api, internal } from "../_generated/api";
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
