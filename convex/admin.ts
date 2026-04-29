/**
 * One-off admin utilities. Manually invoked via `npx convex run`.
 *
 * DO NOT call these from the client. Every function here is destructive or
 * privileged — they're guarded by an explicit CONFIRM string to make
 * accidental fires obvious.
 */

import { internalMutation, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { TableNames } from "./_generated/dataModel";
import { v } from "convex/values";

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
];

const BATCH_SIZE = 500;

export const wipeTableBatch = internalMutation({
  args: {
    table: v.string(),
    confirm: v.string(),
  },
  handler: async (ctx, args) => {
    if (args.confirm !== "YES-WIPE-DATA") {
      throw new Error("Missing confirmation");
    }
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
    if (args.confirm !== "YES-WIPE-DATA") {
      throw new Error("Missing confirmation");
    }
    const summary: Record<string, number> = {};
    for (const table of APP_TABLES) {
      let total = 0;
      while (true) {
        const res = await ctx.runMutation(internal.admin.wipeTableBatch, {
          table,
          confirm: "YES-WIPE-DATA",
        });
        total += res.deleted;
        if (res.done) break;
      }
      summary[table] = total;
    }
    return summary;
  },
});
