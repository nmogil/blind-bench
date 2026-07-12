/** Transitional, bounded backfill for #356 full-span training task hashes. */
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { action, internalAction, internalMutation, internalQuery, type ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { deriveTrainingTaskHash, parseHarborReviewerProjection } from "../lib/harborEvidence";
import { requireProjectRole } from "../lib/auth";
import { TRAINING_EXPORT_LIMITS } from "../lib/trainingExport";

const MAX_BATCH_SIZE = 100;
const SHA256 = /^[0-9a-f]{64}$/;
type Issue =
  | "missing_projection"
  | "projection_unavailable"
  | "projection_oversized"
  | "malformed_projection"
  | "missing_task_revision"
  | "invalid_existing_hash"
  | "changed_during_backfill";

type Report = {
  readonly scanned: number;
  readonly patched: number;
  readonly wouldPatch: number;
  readonly alreadyValid: number;
  readonly issues: ReadonlyArray<{ readonly stableRunId: string; readonly reason: Issue }>;
  readonly continueCursor: string;
  readonly isDone: boolean;
  readonly dryRun: boolean;
};

/** Authorize one project owner before privileged migration internals run. */
export const authorizeProjectOwner = internalQuery({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args): Promise<void> => {
    await requireProjectRole(ctx, args.projectId, ["owner"]);
  },
});

/** Read one cursor-bounded project page; projection bytes remain in storage. */
export const listProjectBatch = internalQuery({
  args: { projectId: v.id("projects"), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => await ctx.db
    .query("fullSpanEvalRuns")
    .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
    .paginate(args.paginationOpts),
});

/** Patch only the exact still-unhashed row/projection observed by the action. */
export const patchIfUnchanged = internalMutation({
  args: {
    fullSpanRunId: v.id("fullSpanEvalRuns"),
    expectedProjectionStorageId: v.id("_storage"),
    trainingTaskHash: v.string(),
  },
  handler: async (ctx, args): Promise<"patched" | "already_valid" | "changed"> => {
    if (!SHA256.test(args.trainingTaskHash)) throw new Error("Derived training task hash is invalid.");
    const row = await ctx.db.get(args.fullSpanRunId);
    if (!row || row.reviewerProjectionStorageId !== args.expectedProjectionStorageId) return "changed";
    if (row.trainingTaskHash === args.trainingTaskHash) return "already_valid";
    if (row.trainingTaskHash !== undefined) return "changed";
    await ctx.db.patch(row._id, { trainingTaskHash: args.trainingTaskHash });
    return "patched";
  },
});

type BackfillArgs = {
  readonly projectId: Id<"projects">;
  readonly dryRun: boolean;
  readonly cursor?: string;
  readonly batchSize?: number;
};

async function runBatch(ctx: ActionCtx, args: BackfillArgs): Promise<Report> {
  const batchSize = args.batchSize ?? 25;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
    throw new Error(`Backfill batchSize must be an integer from 1 to ${MAX_BATCH_SIZE}.`);
  }
  const page = await ctx.runQuery(internal.migrations.backfillFullSpanTrainingTaskHash.listProjectBatch, {
    projectId: args.projectId,
    paginationOpts: { cursor: args.cursor ?? null, numItems: batchSize },
  });
  let patched = 0;
  let wouldPatch = 0;
  let alreadyValid = 0;
  const issues: Array<{ stableRunId: string; reason: Issue }> = [];

  for (const row of page.page) {
    const projectionStorageId = row.reviewerProjectionStorageId;
    if (!projectionStorageId) {
      issues.push({ stableRunId: row.stableRunId, reason: "missing_projection" });
      continue;
    }
    const blob = await ctx.storage.get(projectionStorageId);
    if (!blob) {
      issues.push({ stableRunId: row.stableRunId, reason: "projection_unavailable" });
      continue;
    }
    if (blob.size > TRAINING_EXPORT_LIMITS.maxProjectionBytes) {
      issues.push({ stableRunId: row.stableRunId, reason: "projection_oversized" });
      continue;
    }
    let projection: ReturnType<typeof parseHarborReviewerProjection>;
    try {
      const raw: unknown = JSON.parse(await blob.text());
      projection = parseHarborReviewerProjection(raw);
    } catch {
      issues.push({ stableRunId: row.stableRunId, reason: "malformed_projection" });
      continue;
    }
    if (!projection.taskRevision) {
      issues.push({ stableRunId: row.stableRunId, reason: "missing_task_revision" });
      continue;
    }
    const derived = await deriveTrainingTaskHash(projection.taskPrompt, projection.taskRevision);
    if (row.trainingTaskHash !== undefined) {
      if (row.trainingTaskHash === derived) alreadyValid++;
      else issues.push({ stableRunId: row.stableRunId, reason: "invalid_existing_hash" });
      continue;
    }
    if (args.dryRun) {
      wouldPatch++;
      continue;
    }
    const outcome = await ctx.runMutation(internal.migrations.backfillFullSpanTrainingTaskHash.patchIfUnchanged, {
      fullSpanRunId: row._id,
      expectedProjectionStorageId: projectionStorageId,
      trainingTaskHash: derived,
    });
    if (outcome === "patched") patched++;
    else if (outcome === "already_valid") alreadyValid++;
    else issues.push({ stableRunId: row.stableRunId, reason: "changed_during_backfill" });
  }

  return {
    scanned: page.page.length,
    patched,
    wouldPatch,
    alreadyValid,
    issues,
    continueCursor: page.continueCursor,
    isDone: page.isDone,
    dryRun: args.dryRun,
  };
}

const BACKFILL_ARGS = {
  projectId: v.id("projects"),
  dryRun: v.boolean(),
  cursor: v.optional(v.string()),
  batchSize: v.optional(v.number()),
};

/**
 * Owner-only dry-run/apply entry point. Processes at most 100 rows and returns a
 * cursor plus aggregate/content-safe issue report. It never reads raw evidence.
 */
export const backfillProjectBatch = action({
  args: BACKFILL_ARGS,
  handler: async (ctx, args): Promise<Report> => {
    await ctx.runQuery(internal.migrations.backfillFullSpanTrainingTaskHash.authorizeProjectOwner, { projectId: args.projectId });
    return await runBatch(ctx, args);
  },
});

/** Privileged CLI entry point with the same bounded, dry-run-capable contract. */
export const backfillProjectBatchInternal = internalAction({
  args: BACKFILL_ARGS,
  handler: runBatch,
});
