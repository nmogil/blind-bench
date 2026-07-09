import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { scoreCase } from "./lib/scorecardScoring";
import { foldScorecardResults } from "./lib/scorecardAggregation";

/**
 * #259: Grade every eval case in the org that has a captured production output.
 * Runs deterministic scorers only (no LLM/provider calls), so it is safe to run
 * synchronously inside a single scheduled action.
 *
 * Flow: mark running -> load cases -> score each case with an output -> write
 * results + summary -> mark completed. Cases without `outputText` are counted as
 * `skippedNoOutput`, not graded. Any unexpected error marks the run failed with
 * a generic, content-free message.
 */
export const runScorecard = internalAction({
  args: { runId: v.id("scorecardRuns") },
  handler: async (ctx, args) => {
    const { runId } = args;
    try {
      const run = await ctx.runQuery(internal.scorecards.getRun, { runId });
      if (!run) return; // Run was deleted before we started.

      await ctx.runMutation(internal.scorecards.setRunStatus, {
        runId,
        status: "running",
      });

      const cases = await ctx.runQuery(internal.scorecards.loadOrgEvalCases, {
        orgId: run.orgId,
      });

      let skippedNoOutput = 0;
      const results: {
        caseId: Id<"evalCases">;
        product: string;
        score: number;
        passed: boolean;
        hardFailed: boolean;
        failingScorers: string[];
      }[] = [];

      for (const c of cases) {
        if (c.outputText === undefined || c.outputText === "") {
          skippedNoOutput++;
          continue;
        }
        const verdict = scoreCase(
          { scorerIds: c.scorerIds, scorerConfig: c.scorerConfig },
          { text: c.outputText },
        );
        results.push({
          caseId: c.caseId,
          product: c.product,
          score: verdict.score,
          passed: verdict.passed,
          hardFailed: verdict.hardFailed,
          failingScorers: verdict.failingScorers,
        });
      }

      const { totals } = foldScorecardResults(
        results.map((r) => ({
          caseId: r.caseId,
          product: r.product,
          score: r.score,
          passed: r.passed,
          hardFailed: r.hardFailed,
          failingScorers: r.failingScorers,
        })),
      );

      await ctx.runMutation(internal.scorecards.writeResults, {
        runId,
        results,
        summary: { ...totals, skippedNoOutput },
        completedAt: Date.now(),
      });
    } catch {
      await ctx.runMutation(internal.scorecards.setRunStatus, {
        runId,
        status: "failed",
        errorMessage: "Scorecard run failed. Try again.",
        completedAt: Date.now(),
      });
    }
  },
});
