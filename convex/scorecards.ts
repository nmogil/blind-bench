import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { requireOrgRole } from "./lib/auth";
import {
  foldScorecardResults,
  type ScorecardResultRow,
} from "./lib/scorecardAggregation";
import { consumeEvalCredit } from "./lib/billingCredits";

// ===========================================================================
// #259: Per-org scorecard runs.
//
// Grades every eval case in the org (across all its projects) that has a
// captured production output against its assigned deterministic scorers.
// SECURITY: client-facing functions here return ids, products, scorer keys, and
// numbers only — never messages / outputText / prompt content.
// ===========================================================================

const summaryValidator = v.object({
  cases: v.number(),
  passed: v.number(),
  hardFailed: v.number(),
  meanScore: v.number(),
  skippedNoOutput: v.number(),
});

/**
 * Kick off a scorecard run for an org. Inserts a pending run and schedules the
 * grading action; returns the run id so the client can subscribe via `latest`.
 * If a run is already pending/running for the org, returns that run's id
 * instead of starting an overlapping one (concurrent clients / stale UI).
 */
export const start = mutation({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args): Promise<Id<"scorecardRuns">> => {
    const { userId } = await requireOrgRole(ctx, args.orgId, ["owner", "admin"]);
    const inFlight = await ctx.db
      .query("scorecardRuns")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .filter((q) =>
        q.or(
          q.eq(q.field("status"), "pending"),
          q.eq(q.field("status"), "running"),
        ),
      )
      .first();
    if (inFlight) return inFlight._id;
    const runId = await ctx.db.insert("scorecardRuns", {
      orgId: args.orgId,
      status: "pending",
      triggeredById: userId,
      startedAt: Date.now(),
    });
    await consumeEvalCredit(ctx, args.orgId, {
      kind: "scorecard_run",
      scorecardRunId: runId,
    });
    await ctx.scheduler.runAfter(0, internal.scorecardsActions.runScorecard, {
      runId,
    });
    return runId;
  },
});

/**
 * Latest scorecard run for the org (by startedAt) plus its rolled-up results.
 * Returns null when the org has never run one. Content-free: ids, products,
 * scorer keys, and numbers only.
 */
export const latest = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireOrgRole(ctx, args.orgId, ["owner", "admin", "member"]);
    const runs = await ctx.db
      .query("scorecardRuns")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();
    if (runs.length === 0) return null;
    const run = runs.reduce((a, b) => (b.startedAt > a.startedAt ? b : a));

    const resultRows = await ctx.db
      .query("scorecardResults")
      .withIndex("by_run", (q) => q.eq("runId", run._id))
      .collect();
    const fold = foldScorecardResults(
      resultRows.map((r): ScorecardResultRow => ({
        caseId: r.caseId,
        product: r.product,
        score: r.score,
        passed: r.passed,
        hardFailed: r.hardFailed,
        failingScorers: r.failingScorers,
      })),
    );

    return {
      runId: run._id,
      status: run.status,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      errorMessage: run.errorMessage,
      summary: run.summary,
      products: fold.products,
      softFailuresByScorer: fold.softFailuresByScorer,
      hardFailFindings: fold.hardFailFindings,
    };
  },
});

// ---------------------------------------------------------------------------
// Internal helpers (invoked by the scheduled grading action; no auth — the
// public `start` mutation is the gate, and scheduled actions run as system).
// ---------------------------------------------------------------------------

type ScorecardCaseRow = {
  caseId: Id<"evalCases">;
  product: string;
  scorerIds: string[];
  outputText?: string;
};

/** Fetch a run row for the grading action (org id + status). */
export const getRun = internalQuery({
  args: { runId: v.id("scorecardRuns") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.runId);
  },
});

/** Every eval case across the org's projects, with just the grading fields. */
export const loadOrgEvalCases = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args): Promise<ScorecardCaseRow[]> => {
    const projects = await ctx.db
      .query("projects")
      .withIndex("by_org", (q) => q.eq("organizationId", args.orgId))
      .collect();
    const cases: ScorecardCaseRow[] = [];
    for (const project of projects) {
      const rows = await ctx.db
        .query("evalCases")
        .withIndex("by_project", (q) => q.eq("projectId", project._id))
        .collect();
      for (const r of rows) {
        cases.push({
          caseId: r._id,
          product: r.product,
          scorerIds: r.scorerIds,
          outputText: r.outputText,
        });
      }
    }
    return cases;
  },
});

/** Flip a run's status (pending -> running, or -> failed with a sanitized message). */
export const setRunStatus = internalMutation({
  args: {
    runId: v.id("scorecardRuns"),
    status: v.union(
      v.literal("running"),
      v.literal("failed"),
      v.literal("completed"),
    ),
    errorMessage: v.optional(v.string()),
    completedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const updates: Record<string, unknown> = { status: args.status };
    if (args.errorMessage !== undefined) updates.errorMessage = args.errorMessage;
    if (args.completedAt !== undefined) updates.completedAt = args.completedAt;
    await ctx.db.patch(args.runId, updates);
  },
});

/** Persist graded result rows + the run summary and mark the run completed. */
export const writeResults = internalMutation({
  args: {
    runId: v.id("scorecardRuns"),
    results: v.array(
      v.object({
        caseId: v.id("evalCases"),
        product: v.string(),
        score: v.number(),
        passed: v.boolean(),
        hardFailed: v.boolean(),
        failingScorers: v.array(v.string()),
      }),
    ),
    summary: summaryValidator,
    completedAt: v.number(),
  },
  handler: async (ctx, args) => {
    for (const r of args.results) {
      await ctx.db.insert("scorecardResults", { runId: args.runId, ...r });
    }
    await ctx.db.patch(args.runId, {
      status: "completed",
      summary: args.summary,
      completedAt: args.completedAt,
    });
  },
});
