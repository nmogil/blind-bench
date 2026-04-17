/**
 * Shared review-cycle helpers for the public /api/v1/* surface.
 *
 * PUBLIC API: source of truth for cycle creation, evaluator-task fetching,
 * and submission flows used by service-token clients.
 *
 * These helpers DO NOT enforce auth — the caller (HTTP layer or user-facing
 * mutation) must validate the service token / user role first.
 *
 * SECURITY: cycleEvalTaskCore must NEVER include sourceOutputId, sourceRunId,
 * sourceVersionId, model, temperature, or any field that could de-anonymize
 * outputs. See UX Spec §10 — the 13 blind-eval rules apply equally to API
 * callers (human or agent).
 */

import { MutationCtx, QueryCtx } from "../_generated/server";
import { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { fisherYatesShuffle } from "./shuffle";
import { getCycleBlindLabels } from "./slotConfig";

const FEEDBACK_TAGS = [
  "accuracy",
  "tone",
  "length",
  "relevance",
  "safety",
  "format",
  "clarity",
  "other",
] as const;

type FeedbackTag = (typeof FEEDBACK_TAGS)[number];

function coerceTag(t: string): FeedbackTag {
  if ((FEEDBACK_TAGS as readonly string[]).includes(t)) return t as FeedbackTag;
  return "other";
}

// =========================================================================
// Create a cycle in one shot (used by the API; UI splits this into
// create + addOutputs + assignEvaluators + start mutations)
// =========================================================================

export interface CreateCycleFromRunsInput {
  projectId: Id<"projects">;
  name: string;
  primaryVersionId: Id<"promptVersions">;
  sourceRunIds: Id<"promptRuns">[];
  evaluatorUserIds: Id<"users">[];
  includeSoloEval: boolean;
  open: boolean;
  userId: Id<"users">;
}

export interface CreateCycleFromRunsResult {
  cycleId: Id<"reviewCycles">;
  outputCount: number;
  evaluatorCount: number;
  cycleEvalToken: string | null;
}

export async function createCycleFromRunsCore(
  ctx: MutationCtx,
  args: CreateCycleFromRunsInput,
): Promise<CreateCycleFromRunsResult> {
  const primary = await ctx.db.get(args.primaryVersionId);
  if (!primary || primary.projectId !== args.projectId) {
    throw new Error("Primary version not found in this project");
  }

  // 1. Insert cycle
  const cycleId = await ctx.db.insert("reviewCycles", {
    projectId: args.projectId,
    primaryVersionId: args.primaryVersionId,
    name: args.name,
    status: "draft",
    includeSoloEval: args.includeSoloEval,
    createdById: args.userId,
  });

  // 2. Pool outputs from the supplied runs
  const entries: {
    sourceOutputId: Id<"runOutputs">;
    sourceRunId: Id<"promptRuns">;
    sourceVersionId: Id<"promptVersions">;
    content: string;
  }[] = [];

  for (const runId of args.sourceRunIds) {
    const run = await ctx.db.get(runId);
    if (!run) throw new Error(`Run ${runId} not found`);
    if (run.projectId !== args.projectId) {
      throw new Error("Run does not belong to this project");
    }
    if (run.status !== "completed") {
      throw new Error("Run must be completed before pooling into a cycle");
    }
    const outputs = await ctx.db
      .query("runOutputs")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .take(10);
    for (const o of outputs) {
      entries.push({
        sourceOutputId: o._id,
        sourceRunId: runId,
        sourceVersionId: run.promptVersionId,
        content: o.outputContent,
      });
    }
  }

  if (entries.length === 0) {
    throw new Error("No outputs found in the supplied runs");
  }
  if (entries.length > 26) {
    throw new Error(`Cannot exceed 26 outputs per cycle (got ${entries.length})`);
  }

  const shuffled = fisherYatesShuffle(entries);
  const labels = getCycleBlindLabels(shuffled.length);
  for (let i = 0; i < shuffled.length; i++) {
    const e = shuffled[i]!;
    await ctx.db.insert("cycleOutputs", {
      cycleId,
      sourceOutputId: e.sourceOutputId,
      sourceRunId: e.sourceRunId,
      sourceVersionId: e.sourceVersionId,
      cycleBlindLabel: labels[i]!,
      outputContentSnapshot: e.content,
    });
  }

  // 3. Assign evaluators (if any). Skip non-evaluator users silently — the API
  //    won't be able to add arbitrary humans as evaluators on the fly.
  let evaluatorCount = 0;
  for (const evalId of args.evaluatorUserIds) {
    const collab = await ctx.db
      .query("projectCollaborators")
      .withIndex("by_project_and_user", (q) =>
        q.eq("projectId", args.projectId).eq("userId", evalId),
      )
      .unique();
    if (!collab || collab.role !== "evaluator") continue;

    const dup = await ctx.db
      .query("cycleEvaluators")
      .withIndex("by_cycle_and_user", (q) =>
        q.eq("cycleId", cycleId).eq("userId", evalId),
      )
      .unique();
    if (dup) continue;

    await ctx.db.insert("cycleEvaluators", {
      cycleId,
      userId: evalId,
      status: "pending",
      assignedAt: Date.now(),
      reminderCount: 0,
    });
    evaluatorCount++;
  }

  // 4. Optionally open the cycle
  let cycleEvalToken: string | null = null;
  if (args.open) {
    const tokenBytes = new Uint8Array(16);
    crypto.getRandomValues(tokenBytes);
    cycleEvalToken = Array.from(tokenBytes, (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");

    await ctx.db.insert("cycleEvalTokens", {
      token: cycleEvalToken,
      cycleId,
      projectId: args.projectId,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    });

    await ctx.db.patch(cycleId, {
      status: "open",
      openedAt: Date.now(),
    });

    if (evaluatorCount > 0) {
      await ctx.scheduler.runAfter(
        0,
        internal.evaluatorNotifications.notifyCycleEvaluators,
        {
          cycleId,
          projectId: args.projectId,
          type: "cycle_assigned" as const,
          message: `You've been assigned to review "${args.name}"`,
        },
      );
    }
  }

  return {
    cycleId,
    outputCount: shuffled.length,
    evaluatorCount,
    cycleEvalToken,
  };
}

// =========================================================================
// Aggregated feedback for a cycle (post-evaluation)
// =========================================================================

export interface CycleFeedbackSummary {
  cycleId: Id<"reviewCycles">;
  status: "draft" | "open" | "closed";
  outputs: {
    cycleBlindLabel: string;
    sourceVersionId: Id<"promptVersions">;
    versionNumber: number | null;
    bestCount: number;
    acceptableCount: number;
    weakCount: number;
    bySource: {
      evaluator: number;
      anonymous: number;
      solo: number;
      author: number;
    };
    byEvaluatorType: { human: number; agent: number };
    annotations: {
      from: number;
      to: number;
      highlightedText: string;
      comment: string;
      tags: string[];
      source: "evaluator" | "anonymous" | "solo" | "author";
      evaluatorType: "human" | "agent";
      createdAt: number;
    }[];
  }[];
}

export async function cycleFeedbackSummaryCore(
  ctx: QueryCtx,
  cycleId: Id<"reviewCycles">,
): Promise<CycleFeedbackSummary | null> {
  const cycle = await ctx.db.get(cycleId);
  if (!cycle) return null;

  const outputs = await ctx.db
    .query("cycleOutputs")
    .withIndex("by_cycle", (q) => q.eq("cycleId", cycleId))
    .take(26);

  const result: CycleFeedbackSummary["outputs"] = [];
  for (const output of outputs) {
    const version = await ctx.db.get(output.sourceVersionId);
    const preferences = await ctx.db
      .query("cyclePreferences")
      .withIndex("by_cycle_output", (q) => q.eq("cycleOutputId", output._id))
      .take(200);
    const feedback = await ctx.db
      .query("cycleFeedback")
      .withIndex("by_cycle_output", (q) => q.eq("cycleOutputId", output._id))
      .take(200);

    result.push({
      cycleBlindLabel: output.cycleBlindLabel,
      sourceVersionId: output.sourceVersionId,
      versionNumber: version?.versionNumber ?? null,
      bestCount: preferences.filter((p) => p.rating === "best").length,
      acceptableCount: preferences.filter((p) => p.rating === "acceptable").length,
      weakCount: preferences.filter((p) => p.rating === "weak").length,
      bySource: {
        evaluator: preferences.filter((p) => p.source === "evaluator").length,
        anonymous: preferences.filter((p) => p.source === "anonymous").length,
        solo: preferences.filter((p) => p.source === "solo").length,
        author: preferences.filter((p) => p.source === "author").length,
      },
      byEvaluatorType: {
        human: preferences.filter((p) => (p.evaluatorType ?? "human") === "human")
          .length,
        agent: preferences.filter((p) => p.evaluatorType === "agent").length,
      },
      annotations: feedback.map((fb) => ({
        from: fb.annotationData.from,
        to: fb.annotationData.to,
        highlightedText: fb.annotationData.highlightedText,
        comment: fb.annotationData.comment,
        tags: fb.tags ?? [],
        source: fb.source,
        evaluatorType: fb.evaluatorType ?? "human",
        createdAt: fb._creationTime,
      })),
    });
  }

  return {
    cycleId,
    status: cycle.status,
    outputs: result.sort((a, b) =>
      a.cycleBlindLabel.localeCompare(b.cycleBlindLabel),
    ),
  };
}

// =========================================================================
// Evaluator task fetch (BLIND — strict whitelist)
// =========================================================================

export interface CycleEvalTask {
  cycleId: Id<"reviewCycles">;
  cycleName: string;
  outputs: {
    cycleBlindLabel: string;
    outputContentSnapshot: string;
  }[];
}

export async function cycleEvalTaskCore(
  ctx: QueryCtx,
  cycleId: Id<"reviewCycles">,
): Promise<CycleEvalTask> {
  const cycle = await ctx.db.get(cycleId);
  if (!cycle) throw new Error("Cycle not found");

  const outputs = await ctx.db
    .query("cycleOutputs")
    .withIndex("by_cycle", (q) => q.eq("cycleId", cycleId))
    .take(26);

  // SECURITY: explicit whitelist. NO sourceOutputId, sourceRunId,
  // sourceVersionId. NO model/temperature. NO _id.
  return {
    cycleId,
    cycleName: cycle.name,
    outputs: outputs
      .map((o) => ({
        cycleBlindLabel: o.cycleBlindLabel,
        outputContentSnapshot: o.outputContentSnapshot,
      }))
      .sort((a, b) => a.cycleBlindLabel.localeCompare(b.cycleBlindLabel)),
  };
}

// =========================================================================
// Bulk submit ratings + annotations (used by the agent-evaluator API)
// =========================================================================

export interface CycleRatingInput {
  cycleBlindLabel: string;
  rating: "best" | "acceptable" | "weak";
}

export interface CycleAnnotationInput {
  cycleBlindLabel: string;
  from: number;
  to: number;
  highlightedText: string;
  comment: string;
  tags?: string[];
}

export interface SubmitCycleEvaluationInput {
  cycleId: Id<"reviewCycles">;
  userId: Id<"users">;
  serviceTokenId?: Id<"serviceTokens">;
  evaluatorType: "human" | "agent";
  ratings: CycleRatingInput[];
  annotations: CycleAnnotationInput[];
}

export interface SubmitCycleEvaluationResult {
  ratingsApplied: number;
  annotationsApplied: number;
}

export async function submitCycleEvaluationCore(
  ctx: MutationCtx,
  args: SubmitCycleEvaluationInput,
): Promise<SubmitCycleEvaluationResult> {
  const cycle = await ctx.db.get(args.cycleId);
  if (!cycle) throw new Error("Cycle not found");

  // Index cycleOutputs by label so we can resolve in O(1) per submission.
  const outputs = await ctx.db
    .query("cycleOutputs")
    .withIndex("by_cycle", (q) => q.eq("cycleId", args.cycleId))
    .take(26);
  const labelToOutput = new Map(outputs.map((o) => [o.cycleBlindLabel, o]));

  let ratingsApplied = 0;
  for (const r of args.ratings) {
    const output = labelToOutput.get(r.cycleBlindLabel);
    if (!output) throw new Error(`Unknown blind label "${r.cycleBlindLabel}"`);

    const existing = await ctx.db
      .query("cyclePreferences")
      .withIndex("by_cycle_output", (q) => q.eq("cycleOutputId", output._id))
      .take(200);
    const mine = existing.find(
      (p) =>
        p.userId === args.userId && p.source === "evaluator",
    );

    if (mine) {
      await ctx.db.patch(mine._id, {
        rating: r.rating,
        evaluatorType: args.evaluatorType,
        serviceTokenId: args.serviceTokenId,
      });
    } else {
      await ctx.db.insert("cyclePreferences", {
        cycleId: args.cycleId,
        cycleOutputId: output._id,
        userId: args.userId,
        rating: r.rating,
        source: "evaluator",
        evaluatorType: args.evaluatorType,
        serviceTokenId: args.serviceTokenId,
      });
    }
    ratingsApplied++;
  }

  let annotationsApplied = 0;
  for (const a of args.annotations) {
    const output = labelToOutput.get(a.cycleBlindLabel);
    if (!output) throw new Error(`Unknown blind label "${a.cycleBlindLabel}"`);

    await ctx.db.insert("cycleFeedback", {
      cycleId: args.cycleId,
      cycleOutputId: output._id,
      userId: args.userId,
      annotationData: {
        from: a.from,
        to: a.to,
        highlightedText: a.highlightedText,
        comment: a.comment,
      },
      tags: a.tags ? a.tags.map(coerceTag) : undefined,
      source: "evaluator",
      evaluatorType: args.evaluatorType,
      serviceTokenId: args.serviceTokenId,
    });
    annotationsApplied++;
  }

  return { ratingsApplied, annotationsApplied };
}
