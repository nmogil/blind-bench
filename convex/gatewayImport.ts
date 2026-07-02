import { v } from "convex/values";
import { action, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { requireProjectRole } from "./lib/auth";
import {
  DEFAULT_LIMITS,
  MAX_REPORTED_INVALID_LINES,
  parseGatewayJsonl,
  summarizeTraces,
} from "./traceAdapters/cloudflareAiGateway";
import type { TraceAggregate } from "./traceAdapters/cloudflareAiGateway";

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
