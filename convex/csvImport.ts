/** Authenticated mapped-CSV upload into the normalized trajectory spine. */
import { v } from "convex/values";
import { action } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { AgentRunTrace } from "./lib/agentTrace";
import {
  CSV_IMPORT_MAX_ROWS,
  parseCsvTraceBatch,
  type CsvTraceSummary,
} from "./lib/csvTrace";

const MAX_BYTES = 8 * 1024 * 1024;
const mappingValidator = v.object({
  inputColumn: v.string(),
  outputColumn: v.string(),
  idColumn: v.optional(v.string()),
  systemColumn: v.optional(v.string()),
  timestampColumn: v.optional(v.string()),
  modelColumn: v.optional(v.string()),
  providerColumn: v.optional(v.string()),
  harnessColumn: v.optional(v.string()),
  productColumn: v.optional(v.string()),
  moduleColumn: v.optional(v.string()),
  environmentColumn: v.optional(v.string()),
  privacyClassColumn: v.optional(v.string()),
  metadataColumns: v.array(v.string()),
});

/** Content-free result returned by mapped CSV import. */
export interface CsvImportResult {
  readonly imported: number;
  readonly deduped: number;
  readonly summary: CsvTraceSummary;
}

/** Parse a mapped CSV file and persist every valid row as one trajectory. */
export const importMappedCsv = action({
  args: {
    projectId: v.id("projects"),
    csv: v.string(),
    mapping: mappingValidator,
  },
  handler: async (ctx, args): Promise<CsvImportResult> => {
    await ctx.runQuery(internal.agentTraces.authorizePersist, { projectId: args.projectId });
    if (new TextEncoder().encode(args.csv).byteLength > MAX_BYTES) {
      throw new Error("CSV is over the 8 MB upload limit. Split it into smaller batches and retry.");
    }
    const batch = parseCsvTraceBatch(args.csv, args.mapping);
    if (batch.summary.rows > CSV_IMPORT_MAX_ROWS) {
      throw new Error(
        `CSV has ${batch.summary.rows} rows; import at most ${CSV_IMPORT_MAX_ROWS} rows per batch.`,
      );
    }
    if (batch.traces.length === 0) {
      throw new Error("CSV has no valid rows with both mapped input and output values.");
    }

    const newTraces: Array<{
      readonly agentTraceId: Id<"agentTraces">;
      readonly sourceId: string;
    }> = [];
    let deduped = 0;
    for (const item of batch.traces) {
      const persisted = await ctx.runAction(api.agentTraces.persistTrace, {
        projectId: args.projectId,
        trace: item.trace as unknown as AgentRunTrace,
      });
      if (persisted.deduped) {
        deduped++;
      } else {
        newTraces.push({
          agentTraceId: persisted.agentTraceId,
          sourceId: item.sourceId,
        });
      }
    }

    if (newTraces.length > 0) {
      const rawPayloadStorageId: Id<"_storage"> = await ctx.storage.store(
        new Blob([args.csv], { type: "text/csv" }),
      );
      for (const item of newTraces) {
        const traceImportId = await ctx.runMutation(api.traceImports.createImport, {
          projectId: args.projectId,
          source: "csv",
          sourceTraceId: item.sourceId,
          rawPayloadStorageId,
        });
        await ctx.runMutation(internal.agentTraces.linkTraceImport, {
          agentTraceId: item.agentTraceId,
          traceImportId,
        });
      }
    }

    return {
      imported: newTraces.length,
      deduped,
      summary: batch.summary,
    };
  },
});
