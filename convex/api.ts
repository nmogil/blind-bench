/**
 * Internal mutations + queries that back the public /api/v1/* HTTP surface.
 *
 * PUBLIC API — every export here is part of the wire contract. Changes ripple
 * out to: convex/http.ts (route handlers), the MCP server in mcp/, and any
 * external agent that has a service token. Verify against
 * convex/tests/api-contract.test.ts before merging shape changes.
 *
 * Auth model:
 *   - HTTP route parses Bearer, calls internal.serviceTokens.validateAndStamp
 *   - The resulting ValidatedTokenContext (projectId, userId, scopes,
 *     actorRole) is passed verbatim to the functions below
 *   - These functions trust that the token has been validated; they only
 *     enforce that the caller's projectId matches the resource's projectId
 */

import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { createVersionCore } from "./lib/versionsCore";
import { executeRunCore, getRunSnapshotCore } from "./lib/runsCore";
import {
  createCycleFromRunsCore,
  cycleFeedbackSummaryCore,
  cycleEvalTaskCore,
  submitCycleEvaluationCore,
  type CycleRatingInput,
  type CycleAnnotationInput,
} from "./lib/reviewCyclesCore";

// Token context shape — mirrors ValidatedTokenContext but expressed as a
// validator so internal functions can take it as an arg.
const tokenContextValidator = v.object({
  tokenId: v.id("serviceTokens"),
  projectId: v.id("projects"),
  userId: v.id("users"),
  scopes: v.array(v.string()),
  actorRole: v.union(v.literal("editor"), v.literal("evaluator")),
});

type TokenContext = {
  tokenId: Id<"serviceTokens">;
  projectId: Id<"projects">;
  userId: Id<"users">;
  scopes: string[];
  actorRole: "editor" | "evaluator";
};

function assertProject(ctx_: TokenContext, projectId: Id<"projects">) {
  if (ctx_.projectId !== projectId) {
    throw new Error("Resource does not belong to this token's project");
  }
}

function assertActor(ctx_: TokenContext, allowed: ("editor" | "evaluator")[]) {
  if (!allowed.includes(ctx_.actorRole)) {
    throw new Error(`Token actor role "${ctx_.actorRole}" cannot perform this action`);
  }
}

// =========================================================================
// Phase 1: Authoring (versions + runs)
// =========================================================================

export const createVersionForToken = internalMutation({
  args: {
    tokenContext: tokenContextValidator,
    systemMessage: v.optional(v.string()),
    userMessageTemplate: v.string(),
    parentVersionId: v.optional(v.id("promptVersions")),
  },
  handler: async (ctx, args) => {
    const tc = args.tokenContext as TokenContext;
    assertActor(tc, ["editor"]);

    if (args.parentVersionId) {
      const parent = await ctx.db.get(args.parentVersionId);
      if (!parent) throw new Error("Parent version not found");
      assertProject(tc, parent.projectId);
    }

    const versionId = await createVersionCore(ctx, {
      projectId: tc.projectId,
      systemMessage: args.systemMessage,
      userMessageTemplate: args.userMessageTemplate,
      parentVersionId: args.parentVersionId,
      userId: tc.userId,
    });

    return { versionId };
  },
});

export const startRunForToken = internalMutation({
  args: {
    tokenContext: tokenContextValidator,
    versionId: v.id("promptVersions"),
    testCaseId: v.optional(v.id("testCases")),
    inlineVariables: v.optional(v.record(v.string(), v.string())),
    model: v.string(),
    temperature: v.number(),
    maxTokens: v.optional(v.number()),
    mode: v.optional(v.union(v.literal("uniform"), v.literal("mix"))),
    slotConfigs: v.optional(
      v.array(
        v.object({
          label: v.string(),
          model: v.string(),
          temperature: v.number(),
        }),
      ),
    ),
  },
  handler: async (ctx, args) => {
    const tc = args.tokenContext as TokenContext;
    assertActor(tc, ["editor"]);

    const version = await ctx.db.get(args.versionId);
    if (!version) throw new Error("Version not found");
    assertProject(tc, version.projectId);

    const runId = await executeRunCore(ctx, {
      versionId: args.versionId,
      testCaseId: args.testCaseId,
      inlineVariables: args.inlineVariables,
      model: args.model,
      temperature: args.temperature,
      maxTokens: args.maxTokens,
      mode: args.mode,
      slotConfigs: args.slotConfigs,
      userId: tc.userId,
    });

    await ctx.scheduler.runAfter(0, internal.analyticsActions.track, {
      event: "run executed via api",
      distinctId: tc.userId as string,
      properties: {
        run_id: runId as string,
        project_id: tc.projectId as string,
        token_id: tc.tokenId as string,
        model: args.model,
      },
    });

    return { runId };
  },
});

export const getRunForToken = internalQuery({
  args: {
    tokenContext: tokenContextValidator,
    runId: v.id("promptRuns"),
  },
  handler: async (ctx, args) => {
    const tc = args.tokenContext as TokenContext;
    const run = await ctx.db.get(args.runId);
    if (!run) return null;
    assertProject(tc, run.projectId);
    return await getRunSnapshotCore(ctx, args.runId);
  },
});

// =========================================================================
// Phase 2: Review cycles
// =========================================================================

export const createCycleForToken = internalMutation({
  args: {
    tokenContext: tokenContextValidator,
    name: v.string(),
    primaryVersionId: v.id("promptVersions"),
    sourceRunIds: v.array(v.id("promptRuns")),
    evaluatorUserIds: v.optional(v.array(v.id("users"))),
    includeSoloEval: v.optional(v.boolean()),
    open: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const tc = args.tokenContext as TokenContext;
    assertActor(tc, ["editor"]);

    const primary = await ctx.db.get(args.primaryVersionId);
    if (!primary) throw new Error("Primary version not found");
    assertProject(tc, primary.projectId);

    return await createCycleFromRunsCore(ctx, {
      projectId: tc.projectId,
      name: args.name,
      primaryVersionId: args.primaryVersionId,
      sourceRunIds: args.sourceRunIds,
      evaluatorUserIds: args.evaluatorUserIds ?? [],
      includeSoloEval: args.includeSoloEval ?? false,
      open: args.open ?? true,
      userId: tc.userId,
    });
  },
});

export const getCycleFeedbackForToken = internalQuery({
  args: {
    tokenContext: tokenContextValidator,
    cycleId: v.id("reviewCycles"),
  },
  handler: async (ctx, args) => {
    const tc = args.tokenContext as TokenContext;
    const cycle = await ctx.db.get(args.cycleId);
    if (!cycle) return null;
    assertProject(tc, cycle.projectId);
    return await cycleFeedbackSummaryCore(ctx, args.cycleId);
  },
});

// =========================================================================
// Phase 3: Agent-as-evaluator
// =========================================================================

export const getEvalTaskForToken = internalQuery({
  args: {
    tokenContext: tokenContextValidator,
    cycleId: v.id("reviewCycles"),
  },
  handler: async (ctx, args) => {
    const tc = args.tokenContext as TokenContext;
    const cycle = await ctx.db.get(args.cycleId);
    if (!cycle) throw new Error("Cycle not found");
    assertProject(tc, cycle.projectId);
    if (cycle.status !== "open") {
      throw new Error("Cycle is not open for evaluation");
    }
    return await cycleEvalTaskCore(ctx, args.cycleId);
  },
});

export const submitEvalForToken = internalMutation({
  args: {
    tokenContext: tokenContextValidator,
    cycleId: v.id("reviewCycles"),
    ratings: v.array(
      v.object({
        cycleBlindLabel: v.string(),
        rating: v.union(
          v.literal("best"),
          v.literal("acceptable"),
          v.literal("weak"),
        ),
      }),
    ),
    annotations: v.optional(
      v.array(
        v.object({
          cycleBlindLabel: v.string(),
          from: v.number(),
          to: v.number(),
          highlightedText: v.string(),
          comment: v.string(),
          tags: v.optional(v.array(v.string())),
        }),
      ),
    ),
  },
  handler: async (ctx, args) => {
    const tc = args.tokenContext as TokenContext;
    const cycle = await ctx.db.get(args.cycleId);
    if (!cycle) throw new Error("Cycle not found");
    assertProject(tc, cycle.projectId);
    if (cycle.status !== "open") {
      throw new Error("Cycle is not open for evaluation");
    }

    return await submitCycleEvaluationCore(ctx, {
      cycleId: args.cycleId,
      userId: tc.userId,
      serviceTokenId: tc.tokenId,
      evaluatorType: "agent",
      ratings: args.ratings as CycleRatingInput[],
      annotations: (args.annotations ?? []) as CycleAnnotationInput[],
    });
  },
});

// Type re-exports so the HTTP layer doesn't have to import from lib/
export type { Doc, Id };
