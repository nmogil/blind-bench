import { v } from "convex/values";
import {
  action,
  internalMutation,
  internalQuery,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { requireProjectRole } from "./lib/auth";
import {
  DEFAULT_LIMITS,
  MAX_REPORTED_INVALID_LINES,
  normalizeGatewayLog,
  parseGatewayJsonl,
  summarizeTraces,
} from "./traceAdapters/cloudflareAiGateway";
import type { TraceAggregate } from "./traceAdapters/cloudflareAiGateway";
import { materializeEvalCase } from "./traceAdapters/materializeEvalCase";

const SOURCE = "cloudflare_ai_gateway" as const;

interface InsertImportRowsResult {
  imported: number;
  deduped: number;
  newRows: { importId: Id<"traceImports">; index: number }[];
}

type ImportGatewayLogsResult = {
  imported: number;
  deduped: number;
  parsed: number;
  invalid: number;
  invalidLines: number[];
  truncated: boolean;
} & TraceAggregate;

/**
 * Auth + dedup + identity insert for a batch of parsed traces. Runs as one
 * mutation so within-batch duplicates are caught by read-your-writes, not just
 * across prior imports. Returns the index (into the parsed list) of each newly
 * inserted row so the action can attach raw-payload storage to exactly those.
 */
export const insertImportRows = internalMutation({
  args: {
    projectId: v.id("projects"),
    sourceTraceIds: v.array(v.string()),
  },
  handler: async (ctx, args): Promise<InsertImportRowsResult> => {
    const { userId } = await requireProjectRole(ctx, args.projectId, [
      "owner",
      "editor",
    ]);

    let imported = 0;
    let deduped = 0;
    const newRows: { importId: Id<"traceImports">; index: number }[] = [];
    for (let i = 0; i < args.sourceTraceIds.length; i++) {
      const sourceTraceId = args.sourceTraceIds[i];
      const existing = await ctx.db
        .query("traceImports")
        .withIndex("by_source_trace", (q) =>
          q.eq("source", SOURCE).eq("sourceTraceId", sourceTraceId),
        )
        .filter((q) => q.eq(q.field("projectId"), args.projectId))
        .first();
      if (existing) {
        deduped++;
        continue;
      }
      const importId = await ctx.db.insert("traceImports", {
        projectId: args.projectId,
        source: SOURCE,
        sourceTraceId,
        importedById: userId,
      });
      newRows.push({ importId, index: i });
      imported++;
    }
    return { imported, deduped, newRows };
  },
});

/** Attach raw-payload storage ids to rows inserted by `insertImportRows`. */
export const attachRawPayloads = internalMutation({
  args: {
    updates: v.array(
      v.object({
        importId: v.id("traceImports"),
        storageId: v.id("_storage"),
      }),
    ),
  },
  handler: async (ctx, args) => {
    for (const { importId, storageId } of args.updates) {
      await ctx.db.patch(importId, { rawPayloadStorageId: storageId });
    }
  },
});

/**
 * Import exported Cloudflare AI Gateway logs (Logpush/API JSONL) into a
 * project as deduplicated trace-import rows.
 *
 * No external Cloudflare calls — the customer pastes/uploads JSONL they
 * exported from their own gateway. For each newly imported (non-duplicate)
 * trace we persist import identity (projectId, source, sourceTraceId) plus the
 * raw source record to access-controlled Convex storage (rawPayloadStorageId),
 * so adapter improvements / materialization into prompt versions can re-parse
 * without re-export. Raw content is never rendered back in the UI.
 *
 * An action (not a mutation) because `ctx.storage.store` is action-only;
 * auth/dedup/insert run inside `insertImportRows` so dedup stays transactional.
 *
 * Returns a management-safe summary: counts + model/provider names + time
 * bounds. Never echoes customer trace content or invalid line text.
 */
export const importGatewayLogs = action({
  args: {
    projectId: v.id("projects"),
    jsonl: v.string(),
  },
  handler: async (ctx, args): Promise<ImportGatewayLogsResult> => {
    // UTF-16 char length, not exact bytes — a cheap upper-bound guard before
    // we do any work.
    if (args.jsonl.length > DEFAULT_LIMITS.maxBytes) {
      throw new Error(
        `Payload too large (${args.jsonl.length} chars, limit ${DEFAULT_LIMITS.maxBytes}). Split the export into smaller batches.`,
      );
    }

    const { traces, invalidLines, truncated } = parseGatewayJsonl(
      args.jsonl,
      DEFAULT_LIMITS,
    );

    const { imported, deduped, newRows }: InsertImportRowsResult =
      await ctx.runMutation(internal.gatewayImport.insertImportRows, {
        projectId: args.projectId,
        sourceTraceIds: traces.map((t) => t.sourceTraceId),
      },
    );

    // Store the raw record for exactly the new (non-duplicate) rows — never
    // for dedup hits. Sequential keeps it simple and bounded by maxLines.
    const updates: { importId: Id<"traceImports">; storageId: Id<"_storage"> }[] =
      [];
    for (const { importId, index } of newRows) {
      const storageId = await ctx.storage.store(
        new Blob([traces[index]!.rawPayloadJson], { type: "application/json" }),
      );
      updates.push({ importId, storageId });
    }
    if (updates.length > 0) {
      await ctx.runMutation(internal.gatewayImport.attachRawPayloads, {
        updates,
      });
    }

    const agg = summarizeTraces(traces);
    return {
      imported,
      deduped,
      parsed: traces.length,
      invalid: invalidLines.length,
      invalidLines: invalidLines.slice(0, MAX_REPORTED_INVALID_LINES),
      truncated,
      ...agg,
    };
  },
});

// ===========================================================================
// #259: Materialize imported Cloudflare AI Gateway traces into eval cases.
// ===========================================================================

/**
 * Per-invocation cap on how many cloudflare_ai_gateway trace-import rows a
 * single `materializeImportedTraces` call considers. Materialization is
 * idempotent, so the UI can re-run to drain a backlog larger than this cap.
 */
const MATERIALIZE_CAP = 500;

type MaterializeCandidate = {
  importId: Id<"traceImports">;
  alreadyMaterialized: boolean;
  rawPayloadStorageId?: Id<"_storage">;
};

/**
 * Load up to `MATERIALIZE_CAP` cloudflare_ai_gateway import rows for the
 * project and classify each (already materialized / missing payload / ready).
 * Auth-gated so the action never touches storage for an unauthorized caller.
 */
export const loadMaterializationCandidates = internalQuery({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args): Promise<MaterializeCandidate[]> => {
    await requireProjectRole(ctx, args.projectId, ["owner", "editor"]);
    const rows = await ctx.db
      .query("traceImports")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .filter((q) => q.eq(q.field("source"), SOURCE))
      .take(MATERIALIZE_CAP);
    return rows.map((r) => ({
      importId: r._id,
      alreadyMaterialized: r.evalCaseId !== undefined,
      rawPayloadStorageId: r.rawPayloadStorageId,
    }));
  },
});

const evalCaseRowValidator = v.object({
  importId: v.id("traceImports"),
  product: v.string(),
  title: v.string(),
  messages: v.array(v.object({ role: v.string(), content: v.string() })),
  outputText: v.optional(v.string()),
  scorerIds: v.array(v.string()),
  requestMissing: v.boolean(),
  responseMissing: v.boolean(),
  model: v.optional(v.string()),
  provider: v.optional(v.string()),
  timestamp: v.optional(v.string()),
  inputTokens: v.optional(v.number()),
  outputTokens: v.optional(v.number()),
  costUsd: v.optional(v.number()),
  durationMs: v.optional(v.number()),
});

/**
 * Insert eval cases + link them back to their trace-import rows, transactionally.
 * Re-checks `evalCaseId` per row so a concurrent run can't double-insert
 * (idempotent). Returns how many rows were actually materialized.
 */
export const insertMaterializedCases = internalMutation({
  args: {
    projectId: v.id("projects"),
    rows: v.array(evalCaseRowValidator),
  },
  handler: async (ctx, args): Promise<{ materialized: number }> => {
    const { userId } = await requireProjectRole(ctx, args.projectId, [
      "owner",
      "editor",
    ]);
    let materialized = 0;
    for (const row of args.rows) {
      const imp = await ctx.db.get(row.importId);
      // Skip if the import vanished, moved projects, or was already linked.
      if (!imp || imp.projectId !== args.projectId || imp.evalCaseId) continue;
      const { importId, ...fields } = row;
      const evalCaseId = await ctx.db.insert("evalCases", {
        projectId: args.projectId,
        traceImportId: importId,
        source: "production_log",
        createdById: userId,
        ...fields,
      });
      await ctx.db.patch(importId, { evalCaseId });
      materialized++;
    }
    return { materialized };
  },
});

/**
 * Materialize this project's imported Cloudflare AI Gateway traces into runnable
 * eval cases. Idempotent: rows already linked to an eval case are skipped, so
 * re-running materializes nothing new. Considers at most `MATERIALIZE_CAP` rows
 * per call.
 *
 * An action (not a mutation) because reading the persisted raw payload from
 * storage is action-only. Per-row parse/normalize failures are counted
 * (`failed`) and never abort the batch; error handling surfaces counts only,
 * never trace content.
 */
export const materializeImportedTraces = action({
  args: { projectId: v.id("projects") },
  handler: async (
    ctx,
    args,
  ): Promise<{
    materialized: number;
    alreadyMaterialized: number;
    missingPayload: number;
    failed: number;
  }> => {
    const candidates: MaterializeCandidate[] = await ctx.runQuery(
      internal.gatewayImport.loadMaterializationCandidates,
      { projectId: args.projectId },
    );

    let alreadyMaterialized = 0;
    let missingPayload = 0;
    let failed = 0;
    const rows: (typeof evalCaseRowValidator)["type"][] = [];

    for (const candidate of candidates) {
      if (candidate.alreadyMaterialized) {
        alreadyMaterialized++;
        continue;
      }
      if (!candidate.rawPayloadStorageId) {
        missingPayload++;
        continue;
      }
      try {
        const blob = await ctx.storage.get(candidate.rawPayloadStorageId);
        if (!blob) {
          missingPayload++;
          continue;
        }
        const raw = JSON.parse(await blob.text());
        const trace = normalizeGatewayLog(raw);
        const fields = materializeEvalCase(trace, raw);
        rows.push({ importId: candidate.importId, ...fields });
      } catch {
        // Management-safe: count only, never echo trace content.
        failed++;
      }
    }

    let materialized = 0;
    if (rows.length > 0) {
      const res: { materialized: number } = await ctx.runMutation(
        internal.gatewayImport.insertMaterializedCases,
        { projectId: args.projectId, rows },
      );
      materialized = res.materialized;
    }

    return { materialized, alreadyMaterialized, missingPayload, failed };
  },
});

/**
 * Progress of materialization over the project's cloudflare_ai_gateway imports:
 * how many exist and how many have been materialized into an eval case.
 */
export const materializationStatus = query({
  args: { projectId: v.id("projects") },
  handler: async (
    ctx,
    args,
  ): Promise<{ total: number; materialized: number }> => {
    await requireProjectRole(ctx, args.projectId, [
      "owner",
      "editor",
      "evaluator",
    ]);
    const rows = await ctx.db
      .query("traceImports")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .filter((q) => q.eq(q.field("source"), SOURCE))
      .collect();
    return {
      total: rows.length,
      materialized: rows.filter((r) => r.evalCaseId !== undefined).length,
    };
  },
});
