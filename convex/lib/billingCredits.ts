import { ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { CREDIT_COSTS, TRIAL } from "./billingPlans";

export const BILLING_REASONS = {
  trialGrant: "trial_grant",
  evalConsumption: "eval_consumption",
} as const;

type ReadBillingCtx = Pick<QueryCtx, "db">;

/** Remaining credits are the append-only sum of every ledger delta for an org. */
export async function sumBillingCredits(
  ctx: ReadBillingCtx,
  orgId: Id<"organizations">,
): Promise<number> {
  const rows = await ctx.db
    .query("billingLedger")
    .withIndex("by_org", (q) => q.eq("organizationId", orgId))
    .collect();
  return rows.reduce((acc, row) => acc + row.creditDelta, 0);
}

/** Seed the one-time free trial grant for a fresh workspace. Idempotent by org. */
export async function ensureTrialCreditGrant(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
): Promise<{ granted: boolean; creditDelta: number }> {
  const existing = await ctx.db
    .query("billingLedger")
    .withIndex("by_org", (q) => q.eq("organizationId", orgId))
    .filter((q) => q.eq(q.field("reason"), BILLING_REASONS.trialGrant))
    .first();
  if (existing) return { granted: false, creditDelta: 0 };

  await ctx.db.insert("billingLedger", {
    organizationId: orgId,
    creditDelta: TRIAL.evalCredits,
    reason: BILLING_REASONS.trialGrant,
    createdAt: Date.now(),
  });
  return { granted: true, creditDelta: TRIAL.evalCredits };
}

type ConsumptionTarget =
  | { readonly kind: "prompt_run"; readonly promptRunId: Id<"promptRuns"> }
  | { readonly kind: "scorecard_run"; readonly scorecardRunId: Id<"scorecardRuns"> };

async function alreadyConsumed(
  ctx: ReadBillingCtx,
  target: ConsumptionTarget,
) {
  if (target.kind === "prompt_run") {
    return await ctx.db
      .query("billingLedger")
      .withIndex("by_prompt_run", (q) =>
        q.eq("promptRunId", target.promptRunId),
      )
      .first();
  }

  return await ctx.db
    .query("billingLedger")
    .withIndex("by_scorecard_run", (q) =>
      q.eq("scorecardRunId", target.scorecardRunId),
    )
    .first();
}

/**
 * Consume eval credits transactionally for a product-started evaluation job.
 *
 * Convex mutations are atomic, so the check and negative ledger write cannot
 * race past zero. The target id is an idempotency key: retrying the same run or
 * scorecard does not double-charge.
 */
export async function consumeEvalCredit(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  target: ConsumptionTarget,
): Promise<{ consumed: boolean; remainingCredits: number }> {
  if (await alreadyConsumed(ctx, target)) {
    return {
      consumed: false,
      remainingCredits: await sumBillingCredits(ctx, orgId),
    };
  }

  const remaining = await sumBillingCredits(ctx, orgId);
  if (remaining < CREDIT_COSTS.evalRun) {
    throw new ConvexError(
      "Out of eval credits for this workspace. Add credits in Billing to start another evaluation.",
    );
  }

  await ctx.db.insert("billingLedger", {
    organizationId: orgId,
    creditDelta: -CREDIT_COSTS.evalRun,
    reason: BILLING_REASONS.evalConsumption,
    promptRunId: target.kind === "prompt_run" ? target.promptRunId : undefined,
    scorecardRunId:
      target.kind === "scorecard_run" ? target.scorecardRunId : undefined,
    createdAt: Date.now(),
  });

  return {
    consumed: true,
    remainingCredits: remaining - CREDIT_COSTS.evalRun,
  };
}
