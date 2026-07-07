/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import schema from "../schema";
import type { Id } from "../_generated/dataModel";
import { signWebhook } from "../lib/polarSignature";

// Properly-typed harness (the concrete convexTest(schema) result) so table
// queries in helpers resolve their indexes under `tsc -b`.
type Harness = Awaited<ReturnType<typeof seedBillingEnv>>["t"];

// A plain (non-`whsec_`) secret is accepted as UTF-8 bytes by verifyWebhook,
// which is fine for driving the route in tests.
const SECRET = "test-webhook-secret";
const SANDBOX_ORG = "801c0378-2a22-439e-816f-f874be389bd3";

// Seed a real org + owner exactly like billing.test.ts's seedBillingEnv.
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
  return { t, ids };
}

// Build a real-shape Polar `order.paid` webhook body (trimmed to relevant
// fields; extra fields must be harmlessly ignored).
function orderPaidBody(
  orgId: string,
  orderId: string,
  opts: { customerId?: string; subscriptionId?: string; dropMetaOrgId?: boolean } = {},
) {
  const customerId = opts.customerId ?? "cus_polar_1";
  const subscriptionId = opts.subscriptionId ?? "sub_polar_1";
  const metadata: Record<string, string> = {
    orgId,
    packageKey: "team",
    environment: "sandbox",
  };
  if (opts.dropMetaOrgId) delete metadata.orgId;
  return {
    type: "order.paid",
    data: {
      id: orderId,
      status: "paid",
      paid: true,
      billing_reason: "subscription_create",
      currency: "usd",
      total_amount: 19900,
      customer_id: customerId,
      product_id: "prod_team_x",
      subscription_id: subscriptionId,
      checkout_id: "chk_1",
      metadata,
      customer: {
        id: customerId,
        external_id: orgId,
        email: "buyer@example.com",
        organization_id: SANDBOX_ORG,
      },
      subscription: {
        id: subscriptionId,
        status: "active",
        metadata: { orgId, packageKey: "team", environment: "sandbox" },
      },
    },
  };
}

function orderRefundedBody(
  orgId: string,
  orderId: string,
  opts: { customerId?: string; subscriptionId?: string } = {},
) {
  const customerId = opts.customerId ?? "cus_polar_1";
  return {
    type: "order.refunded",
    data: {
      id: orderId,
      metadata: { orgId, packageKey: "team", environment: "sandbox" },
      customer: { id: customerId, external_id: orgId },
      customer_id: customerId,
      subscription_id: opts.subscriptionId ?? "sub_polar_1",
    },
  };
}

function subscriptionRevokedBody(
  orgId: string,
  subscriptionId: string,
  opts: { customerId?: string } = {},
) {
  const customerId = opts.customerId ?? "cus_polar_1";
  return {
    type: "subscription.revoked",
    data: {
      // NOTE: for subscription events, data.id is the SUBSCRIPTION id.
      id: subscriptionId,
      metadata: { orgId, packageKey: "team", environment: "sandbox" },
      customer: { id: customerId, external_id: orgId },
      customer_id: customerId,
    },
  };
}

// Drive the route with a valid signature over the exact body bytes.
async function postSigned(
  t: Harness,
  id: string,
  body: unknown,
) {
  const raw = JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = await signWebhook(id, timestamp, raw, SECRET);
  return t.fetch("/polar/webhook", {
    method: "POST",
    headers: {
      "webhook-id": id,
      "webhook-timestamp": timestamp,
      "webhook-signature": signature,
      "Content-Type": "application/json",
    },
    body: raw,
  });
}

async function ledgerFor(t: Harness, orgId: Id<"organizations">) {
  return t.run(async (ctx) => {
    const rows = await ctx.db
      .query("billingLedger")
      .withIndex("by_org", (q) => q.eq("organizationId", orgId))
      .collect();
    return rows;
  });
}

describe("/polar/webhook end-to-end (real Polar event shapes)", () => {
  let prevSecret: string | undefined;

  beforeEach(() => {
    prevSecret = process.env.POLAR_WEBHOOK_SECRET;
    process.env.POLAR_WEBHOOK_SECRET = SECRET;
  });
  afterEach(() => {
    if (prevSecret === undefined) delete process.env.POLAR_WEBHOOK_SECRET;
    else process.env.POLAR_WEBHOOK_SECRET = prevSecret;
  });

  test("a. real-shape order.paid grants entitlement + credits + customer", async () => {
    const { t, ids } = await seedBillingEnv();
    const body = orderPaidBody(ids.orgId, "ord_real_1", {
      customerId: "cus_real_1",
    });

    const res = await postSigned(t, "evt_paid_1", body);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.result.action).toBe("granted");

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
      // polarCustomerId must match data.customer_id from the payload.
      expect(cust?.polarCustomerId).toBe("cus_real_1");
    });
  });

  test("b. fallback: no data.metadata.orgId → customer.external_id grants", async () => {
    const { t, ids } = await seedBillingEnv();
    const body = orderPaidBody(ids.orgId, "ord_fallback_2", {
      customerId: "cus_fallback_2",
      dropMetaOrgId: true,
    });

    const res = await postSigned(t, "evt_paid_2", body);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.result.action).toBe("granted");

    const ledger = await ledgerFor(t, ids.orgId);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.creditDelta).toBe(2500);
  });

  test("c. bad signature → 401 and no ledger row", async () => {
    const { t, ids } = await seedBillingEnv();
    const body = orderPaidBody(ids.orgId, "ord_bad_3");
    const raw = JSON.stringify(body);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    // A signature computed under a DIFFERENT secret must not verify.
    const badSig = await signWebhook("evt_3", timestamp, raw, "wrong-secret");

    const res = await t.fetch("/polar/webhook", {
      method: "POST",
      headers: {
        "webhook-id": "evt_3",
        "webhook-timestamp": timestamp,
        "webhook-signature": badSig,
        "Content-Type": "application/json",
      },
      body: raw,
    });
    expect(res.status).toBe(401);

    const ledger = await ledgerFor(t, ids.orgId);
    expect(ledger).toHaveLength(0);
  });

  test("d. missing signature headers → 400", async () => {
    const { t, ids } = await seedBillingEnv();
    const body = orderPaidBody(ids.orgId, "ord_missing_4");
    const res = await t.fetch("/polar/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(400);

    const ledger = await ledgerFor(t, ids.orgId);
    expect(ledger).toHaveLength(0);
  });

  test("e. POLAR_WEBHOOK_SECRET unset → 503", async () => {
    const { t, ids } = await seedBillingEnv();
    delete process.env.POLAR_WEBHOOK_SECRET; // afterEach restores it
    const body = orderPaidBody(ids.orgId, "ord_503_5");
    const res = await t.fetch("/polar/webhook", {
      method: "POST",
      headers: {
        "webhook-id": "evt_5",
        "webhook-timestamp": Math.floor(Date.now() / 1000).toString(),
        "webhook-signature": "v1,ignored",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(503);
  });

  test("f. order.refunded reverses the grant and revokes entitlement", async () => {
    const { t, ids } = await seedBillingEnv();
    const paid = await postSigned(
      t,
      "evt_paid_6",
      orderPaidBody(ids.orgId, "ord_refund_6", { customerId: "cus_6" }),
    );
    expect((await paid.json()).result.action).toBe("granted");

    const refund = await postSigned(
      t,
      "evt_refund_6",
      orderRefundedBody(ids.orgId, "ord_refund_6", { customerId: "cus_6" }),
    );
    expect(refund.status).toBe(200);
    expect((await refund.json()).result.action).toBe("refunded");

    const ledger = await ledgerFor(t, ids.orgId);
    const total = ledger.reduce((a, r) => a + r.creditDelta, 0);
    expect(total).toBe(0);

    await t.run(async (ctx) => {
      const ent = await ctx.db
        .query("billingEntitlements")
        .withIndex("by_org", (q) => q.eq("organizationId", ids.orgId))
        .collect();
      expect(ent[0]!.status).toBe("revoked");
    });
  });

  test("g. subscription.revoked (data.id = subscription id) revokes, credits intact", async () => {
    const { t, ids } = await seedBillingEnv();
    const paid = await postSigned(
      t,
      "evt_paid_7",
      orderPaidBody(ids.orgId, "ord_revoke_7", {
        customerId: "cus_7",
        subscriptionId: "sub_revoke_7",
      }),
    );
    expect((await paid.json()).result.action).toBe("granted");

    const revoke = await postSigned(
      t,
      "evt_revoke_7",
      subscriptionRevokedBody(ids.orgId, "sub_revoke_7", { customerId: "cus_7" }),
    );
    expect(revoke.status).toBe(200);
    expect((await revoke.json()).result.action).toBe("revoked");

    const ledger = await ledgerFor(t, ids.orgId);
    const total = ledger.reduce((a, r) => a + r.creditDelta, 0);
    expect(total).toBe(2500); // credits untouched on revoke

    await t.run(async (ctx) => {
      const ent = await ctx.db
        .query("billingEntitlements")
        .withIndex("by_org", (q) => q.eq("organizationId", ids.orgId))
        .collect();
      expect(ent[0]!.status).toBe("revoked");
    });
  });
});
