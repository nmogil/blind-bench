/** Authenticated OTLP/HTTP JSON file upload using the live endpoint's mapper. */
import { v } from "convex/values";
import { action } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { AgentRunTrace } from "./lib/agentTrace";
import {
  mapOtlpToTraces,
  type OtelIngestSummary,
} from "./lib/otelGenAI";
import { MAX_BYTES } from "./otlpIngest";

/** Content-free result returned by authenticated OTLP file import. */
export interface OtlpFileImportResult {
  readonly imported: number;
  readonly deduped: number;
  readonly summary: OtelIngestSummary;
}

/** Parse one captured OTLP JSON request and persist its GenAI trajectories. */
export const importOtlpJson = action({
  args: {
    projectId: v.id("projects"),
    json: v.string(),
  },
  handler: async (ctx, args): Promise<OtlpFileImportResult> => {
    await ctx.runQuery(internal.agentTraces.authorizePersist, { projectId: args.projectId });
    if (new TextEncoder().encode(args.json).byteLength > MAX_BYTES) {
      throw new Error("OTLP file is over the 8 MB upload limit. Split the captured batch and retry.");
    }
    let payload: unknown;
    try {
      payload = JSON.parse(args.json);
    } catch {
      throw new Error("OTLP file is not valid JSON.");
    }
    const { traces, summary } = mapOtlpToTraces(payload);
    if (traces.length === 0) {
      throw new Error(
        "OTLP file contains no GenAI spans. Check that the exporter includes gen_ai.* attributes.",
      );
    }

    const newTraces: Array<{
      readonly agentTraceId: Id<"agentTraces">;
      readonly sourceId: string;
    }> = [];
    let deduped = 0;
    for (const trace of traces) {
      const persisted = await ctx.runAction(api.agentTraces.persistTrace, {
        projectId: args.projectId,
        trace: trace as unknown as AgentRunTrace,
      });
      if (persisted.deduped) {
        deduped++;
      } else {
        newTraces.push({
          agentTraceId: persisted.agentTraceId,
          sourceId: trace.run_id ?? trace.trace_id,
        });
      }
    }

    if (newTraces.length > 0) {
      const rawPayloadStorageId: Id<"_storage"> = await ctx.storage.store(
        new Blob([args.json], { type: "application/json" }),
      );
      for (const item of newTraces) {
        const traceImportId = await ctx.runMutation(api.traceImports.createImport, {
          projectId: args.projectId,
          source: "otlp",
          sourceTraceId: item.sourceId,
          rawPayloadStorageId,
        });
        await ctx.runMutation(internal.agentTraces.linkTraceImport, {
          agentTraceId: item.agentTraceId,
          traceImportId,
        });
      }
    }

    return { imported: newTraces.length, deduped, summary };
  },
});
