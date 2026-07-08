import { ConvexError, v } from "convex/values";
import {
  action,
  query,
  internalQuery,
  internalMutation,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { QueryCtx, MutationCtx } from "./_generated/server";
import { requireOrgRole } from "./lib/auth";
import {
  BILLING_PACKAGES,
  CREDIT_COSTS,
  TRIAL,
  getPackage,
  resolvePackageKeyByProductId,
  resolveProductId,
  publicPackageCatalog,
} from "./lib/billingPlans";
import { sumBillingCredits } from "./lib/billingCredits";

// Webhook event types we act on. Anything else is acknowledged and ignored.
const GRANT_EVENTS = new Set(["order.paid"]);
const REFUND_EVENTS = new Set(["order.refunded", "order.refund.created"]);
const REVOKE_EVENTS = new Set([
  "subscription.revoked",
  "subscription.canceled",
  "subscription.cancelled",
]);

/** Sum of all ledger deltas for an org = remaining eval credits. */
async function sumCredits(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
): Promise<number> {
  return sumBillingCredits(ctx, orgId);
}

async function activeEntitlement(ctx: QueryCtx, orgId: Id<"organizations">) {
  return ctx.db
    .query("billingEntitlements")
    .withIndex("by_org_and_status", (q) =>
      q.eq("organizationId", orgId).eq("status", "active"),
    )
    .first();
}

// ---------------------------------------------------------------------------
// Owner-facing read
// ---------------------------------------------------------------------------

/**
 * Owner-only billing overview: catalog config, the active entitlement,
 * remaining credits, recent ledger, and portal availability. The UI consumes
 * the catalog from here rather than hard-coding product IDs or credit counts.
 */
export const getBillingOverview = query({
  args: { orgId: v.id("organizations") },
  handler: async (
    ctx,
    args,
  ): Promise<{
    packages: ReturnType<typeof publicPackageCatalog>;
    trial: typeof TRIAL;
    entitlement: { packageKey: string; status: string } | null;
    remainingCredits: number;
    ledger: Array<{
      creditDelta: number;
      reason: string;
      packageKey: string | null;
      createdAt: number;
    }>;
    portalAvailable: boolean;
    checkoutConfigured: boolean;
  }> => {
    await requireOrgRole(ctx, args.orgId, ["owner"]);

    const entitlement = await activeEntitlement(ctx, args.orgId);
    const customer = await ctx.db
      .query("billingCustomers")
      .withIndex("by_org", (q) => q.eq("organizationId", args.orgId))
      .unique();

    const ledger = await ctx.db
      .query("billingLedger")
      .withIndex("by_org", (q) => q.eq("organizationId", args.orgId))
      .order("desc")
      .take(20);

    return {
      packages: publicPackageCatalog(),
      trial: TRIAL,
      entitlement: entitlement
        ? { packageKey: entitlement.packageKey, status: entitlement.status }
        : null,
      remainingCredits: await sumCredits(ctx, args.orgId),
      ledger: ledger.map((r) => ({
        creditDelta: r.creditDelta,
        reason: r.reason,
        packageKey: r.packageKey ?? null,
        createdAt: r.createdAt,
      })),
      // Portal needs an established Polar customer; self-serve checkout needs
      // the Polar access token to be configured server-side.
      portalAvailable: !!customer,
      checkoutConfigured: !!process.env.POLAR_ACCESS_TOKEN,
    };
  },
});

export const getCreditStatus = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireOrgRole(ctx, args.orgId, ["owner", "admin", "member"]);
    return {
      remainingCredits: await sumCredits(ctx, args.orgId),
      evalRunCost: CREDIT_COSTS.evalRun,
      trialCredits: TRIAL.evalCredits,
    };
  },
});

// ---------------------------------------------------------------------------
// Internal helpers for actions (actions can't touch ctx.db directly)
// ---------------------------------------------------------------------------

export const loadBillingContext = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const { userId } = await requireOrgRole(ctx, args.orgId, ["owner"]);
    const org = await ctx.db.get(args.orgId);
    const customer = await ctx.db
      .query("billingCustomers")
      .withIndex("by_org", (q) => q.eq("organizationId", args.orgId))
      .unique();
    return {
      userId,
      orgSlug: org?.slug ?? "",
      polarCustomerId: customer?.polarCustomerId ?? null,
      externalCustomerId: customer?.externalCustomerId ?? null,
    };
  },
});

/** Create-or-resume the org's billing customer row. Idempotent. */
export const ensureBillingCustomer = internalMutation({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const externalCustomerId = args.orgId as string;
    const existing = await ctx.db
      .query("billingCustomers")
      .withIndex("by_org", (q) => q.eq("organizationId", args.orgId))
      .unique();
    if (existing) return existing.externalCustomerId;
    const now = Date.now();
    await ctx.db.insert("billingCustomers", {
      organizationId: args.orgId,
      externalCustomerId,
      createdAt: now,
      updatedAt: now,
    });
    return externalCustomerId;
  },
});

// ---------------------------------------------------------------------------
// Checkout + portal actions
// ---------------------------------------------------------------------------

function polarBaseUrl(): string {
  return process.env.POLAR_API_URL ?? "https://api.polar.sh";
}

function appBaseUrl(): string {
  return process.env.APP_BASE_URL ?? "http://localhost:5173";
}

/**
 * Begin a self-serve checkout. Resolves the package's product ID from env and
 * sends only org id / package key / environment as metadata — never any trace
 * or eval data. Fails closed (ConvexError) when billing isn't configured.
 */
export const createCheckout = action({
  args: { orgId: v.id("organizations"), packageKey: v.string() },
  handler: async (ctx, args) => {
    const pkg = getPackage(args.packageKey);
    if (!pkg) throw new ConvexError("Unknown package.");
    if (pkg.manualEnterprise) {
      throw new ConvexError(
        "Enterprise is sales-assisted. Contact us to get set up.",
      );
    }

    const ctxData: { userId: Id<"users">; orgSlug: string } =
      await ctx.runQuery(internal.billing.loadBillingContext, {
        orgId: args.orgId,
      });

    const productId = resolveProductId(pkg);
    const accessToken = process.env.POLAR_ACCESS_TOKEN;
    if (!productId || !accessToken) {
      throw new ConvexError("Billing is not configured. Contact support.");
    }

    // Create-or-resume the local customer so the same external id is reused.
    const externalCustomerId: string = await ctx.runMutation(
      internal.billing.ensureBillingCustomer,
      { orgId: args.orgId },
    );

    const environment = process.env.POLAR_ENV ?? "production";
    const successUrl = `${appBaseUrl()}/orgs/${ctxData.orgSlug}/settings/billing?checkout=success`;

    const res = await fetch(`${polarBaseUrl()}/v1/checkouts/`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        products: [productId],
        external_customer_id: externalCustomerId,
        success_url: successUrl,
        metadata: {
          orgId: args.orgId as string,
          packageKey: pkg.key,
          environment,
        },
      }),
    });

    if (!res.ok) {
      throw new ConvexError("Could not start checkout. Please try again.");
    }
    const data = (await res.json()) as { id: string; url: string };
    return { checkoutId: data.id, url: data.url };
  },
});

/**
 * Open the Polar customer portal for managing/cancelling a subscription.
 * Requires an established Polar customer; fails gracefully otherwise.
 */
export const createCustomerPortal = action({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const ctxData: { polarCustomerId: string | null; externalCustomerId: string | null } =
      await ctx.runQuery(internal.billing.loadBillingContext, { orgId: args.orgId });

    const accessToken = process.env.POLAR_ACCESS_TOKEN;
    if (!accessToken) {
      throw new ConvexError("Billing is not configured. Contact support.");
    }
    const customerRef = ctxData.polarCustomerId
      ? { customer_id: ctxData.polarCustomerId }
      : { external_customer_id: ctxData.externalCustomerId ?? (args.orgId as string) };

    const res = await fetch(`${polarBaseUrl()}/v1/customer-sessions/`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(customerRef),
    });
    if (!res.ok) {
      throw new ConvexError("Could not open billing portal. Please try again.");
    }
    const data = (await res.json()) as { customer_portal_url: string };
    return { url: data.customer_portal_url };
  },
});

// ---------------------------------------------------------------------------
// Webhook application (idempotent)
// ---------------------------------------------------------------------------

async function upsertActiveEntitlement(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  packageKey: string,
  polarSubscriptionId: string | undefined,
) {
  const now = Date.now();
  const existing = await activeEntitlement(ctx, orgId);
  if (existing) {
    await ctx.db.patch(existing._id, {
      packageKey,
      polarSubscriptionId,
      updatedAt: now,
    });
    return existing._id;
  }
  return ctx.db.insert("billingEntitlements", {
    organizationId: orgId,
    packageKey,
    status: "active",
    polarSubscriptionId,
    grantedAt: now,
    updatedAt: now,
  });
}

/**
 * Apply a verified, sanitized Polar webhook event. Idempotent by `eventId`
 * (re-delivery is a no-op) AND by `polarOrderId` (a duplicate order never
 * double-credits). Only payment/entitlement bookkeeping happens here — no
 * trace or test-case data is touched. Returns a result object for tests.
 */
export const applyPolarEvent = internalMutation({
  args: {
    eventId: v.string(),
    eventType: v.string(),
    externalCustomerId: v.string(),
    packageKey: v.optional(v.string()),
    polarCustomerId: v.optional(v.string()),
    polarOrderId: v.optional(v.string()),
    polarProductId: v.optional(v.string()),
    polarSubscriptionId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // 1. Event-level idempotency.
    const seen = await ctx.db
      .query("polarWebhookEvents")
      .withIndex("by_event_id", (q) => q.eq("eventId", args.eventId))
      .unique();
    if (seen) return { duplicate: true, action: "duplicate" as const };

    const finish = async (result: string, extra: Record<string, unknown>) => {
      await ctx.db.insert("polarWebhookEvents", {
        eventId: args.eventId,
        eventType: args.eventType,
        processedAt: Date.now(),
        result,
      });
      return { duplicate: false, action: result, ...extra };
    };

    // 2. Resolve org safely from the external customer id (= org id).
    const orgId = ctx.db.normalizeId("organizations", args.externalCustomerId);
    if (!orgId || !(await ctx.db.get(orgId))) {
      return finish("ignored_unknown_org", {});
    }

    // 3. Create-or-resume the customer row; record the Polar customer id.
    const now = Date.now();
    const customer = await ctx.db
      .query("billingCustomers")
      .withIndex("by_org", (q) => q.eq("organizationId", orgId))
      .unique();
    if (!customer) {
      await ctx.db.insert("billingCustomers", {
        organizationId: orgId,
        externalCustomerId: args.externalCustomerId,
        polarCustomerId: args.polarCustomerId,
        createdAt: now,
        updatedAt: now,
      });
    } else if (args.polarCustomerId && !customer.polarCustomerId) {
      await ctx.db.patch(customer._id, {
        polarCustomerId: args.polarCustomerId,
        updatedAt: now,
      });
    }

    // 4. Branch on event type.
    if (GRANT_EVENTS.has(args.eventType)) {
      const packageKey =
        args.packageKey ?? resolvePackageKeyByProductId(args.polarProductId);
      const pkg = packageKey ? getPackage(packageKey) : undefined;
      if (!pkg) return finish("ignored_unknown_package", {});

      // Order-level idempotency: never double-credit the same order.
      if (args.polarOrderId) {
        const prior = await ctx.db
          .query("billingLedger")
          .withIndex("by_order", (q) =>
            q.eq("polarOrderId", args.polarOrderId),
          )
          .first();
        if (prior) {
          return finish("duplicate_order", {
            creditDelta: 0,
            entitlementStatus: "active",
          });
        }
      }

      await upsertActiveEntitlement(
        ctx,
        orgId,
        pkg.key,
        args.polarSubscriptionId,
      );
      await ctx.db.insert("billingLedger", {
        organizationId: orgId,
        creditDelta: pkg.monthlyEvalCredits,
        reason: "package_purchase",
        packageKey: pkg.key,
        polarOrderId: args.polarOrderId,
        polarSubscriptionId: args.polarSubscriptionId,
        polarEventId: args.eventId,
        createdAt: now,
      });
      return finish("granted", {
        creditDelta: pkg.monthlyEvalCredits,
        entitlementStatus: "active",
        packageKey: pkg.key,
      });
    }

    if (REFUND_EVENTS.has(args.eventType)) {
      // Reverse the exact grant for this order, once.
      if (!args.polarOrderId) return finish("ignored_no_order", {});
      const entries = await ctx.db
        .query("billingLedger")
        .withIndex("by_order", (q) => q.eq("polarOrderId", args.polarOrderId))
        .collect();
      const grant = entries.find((e) => e.creditDelta > 0);
      const alreadyRefunded = entries.some((e) => e.creditDelta < 0);
      if (!grant || alreadyRefunded) {
        return finish("ignored_no_grant", {});
      }
      await ctx.db.insert("billingLedger", {
        organizationId: orgId,
        creditDelta: -grant.creditDelta,
        reason: "refund",
        packageKey: grant.packageKey,
        polarOrderId: args.polarOrderId,
        polarSubscriptionId: args.polarSubscriptionId,
        polarEventId: args.eventId,
        createdAt: now,
      });
      const ent = await activeEntitlement(ctx, orgId);
      if (ent) await ctx.db.patch(ent._id, { status: "revoked", updatedAt: now });
      return finish("refunded", {
        creditDelta: -grant.creditDelta,
        entitlementStatus: "revoked",
      });
    }

    if (REVOKE_EVENTS.has(args.eventType)) {
      const ent = await activeEntitlement(ctx, orgId);
      if (ent) await ctx.db.patch(ent._id, { status: "revoked", updatedAt: now });
      return finish("revoked", {
        creditDelta: 0,
        entitlementStatus: "revoked",
      });
    }

    return finish("ignored_unsupported", {});
  },
});

// Re-export so callers/tests can reference the catalog symbol from this module.
export { BILLING_PACKAGES };
