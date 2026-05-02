/**
 * One-off admin utilities. Manually invoked via `npx convex run`.
 *
 * DO NOT call these from the client. Every function here is destructive or
 * privileged. Wipe functions are guarded by two layers:
 *
 *   1. **Env gate** — `WIPE_ENABLED` must equal `"true"` on the deployment
 *      (set in the Convex dashboard env vars). Default-off means a freshly
 *      provisioned prod deployment cannot be wiped without an explicit
 *      opt-in. To wipe pre-launch (per the M25 no-backfill policy), set
 *      `WIPE_ENABLED=true`, run the wipe, then unset.
 *   2. **Date-stamped confirm** — `confirm` must equal `WIPE-YYYY-MM-DD`
 *      where the date is today's UTC date. Prevents copy-paste of yesterday's
 *      command and forces the operator to look up today's date before firing.
 */

import { internalMutation, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { TableNames } from "./_generated/dataModel";
import { v } from "convex/values";

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function assertWipeAllowed(confirm: string): void {
  if (process.env.WIPE_ENABLED !== "true") {
    throw new Error(
      "Wipe is disabled on this deployment. Set WIPE_ENABLED=true in the Convex dashboard env vars to permit, then unset after.",
    );
  }
  const expected = `WIPE-${todayUtc()}`;
  if (confirm !== expected) {
    throw new Error(
      `Stale or missing confirmation. Pass confirm: "${expected}" (today's UTC date).`,
    );
  }
}

// Application tables to wipe. Auth tables (users, authAccounts,
// authSessions…) are intentionally omitted so the current user stays signed
// in — they can sign out manually if they want a true clean slate.
const APP_TABLES: TableNames[] = [
  "organizations",
  "organizationMembers",
  "projects",
  "projectCollaborators",
  "projectVariables",
  "testCases",
  "promptVersions",
  "promptAttachments",
  "openRouterKeys",
  "promptRuns",
  "runOutputs",
  "outputFeedback",
  "promptFeedback",
  "evalTokens",
  "runComments",
  "outputPreferences",
  "evaluatorNotifications",
  "reviewerNotifications",
  "feedbackDigests",
  "optimizationRequests",
  "userPreferences",
  "modelCatalog",
  "runAssistantSuggestions",
  "demoVotes",
  "demoVoteStats",
  "runInsights",
  "reviewCycles",
  "cycleOutputs",
  "cycleEvaluators",
  "cyclePreferences",
  "cycleFeedback",
  "reviewSessions",
  "reviewMatchups",
  "guestIdentities",
  "invitations",
  "traceImports",
];

const BATCH_SIZE = 500;

export const wipeTableBatch = internalMutation({
  args: {
    table: v.string(),
    confirm: v.string(),
  },
  handler: async (ctx, args) => {
    assertWipeAllowed(args.confirm);
    // Cast is safe because we only ever call this with names from APP_TABLES.
    const batch = await ctx.db
      .query(args.table as TableNames)
      .take(BATCH_SIZE);
    for (const doc of batch) {
      await ctx.db.delete(doc._id);
    }
    return { deleted: batch.length, done: batch.length < BATCH_SIZE };
  },
});

export const wipeAll = internalAction({
  args: { confirm: v.string() },
  handler: async (ctx, args) => {
    assertWipeAllowed(args.confirm);
    const summary: Record<string, number> = {};
    for (const table of APP_TABLES) {
      let total = 0;
      while (true) {
        const res = await ctx.runMutation(internal.admin.wipeTableBatch, {
          table,
          confirm: args.confirm,
        });
        total += res.deleted;
        if (res.done) break;
      }
      summary[table] = total;
    }
    return summary;
  },
});
