/**
 * Authenticated Pi session JSONL import. Blind Bench reads Pi's saved session
 * artifact; it never launches Pi or receives model-provider credentials.
 */
import { v } from "convex/values";
import { action } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { AgentRunTrace } from "./lib/agentTrace";
import { parsePiSession, type PiSessionSummary } from "./lib/piTrace";

const MAX_BYTES = 8 * 1024 * 1024;

/** Safe result returned after importing a Pi session file. */
export interface PiImportResult {
  readonly deduped: boolean;
  readonly summary: PiSessionSummary;
}

/** Parse and persist one saved Pi session as one normalized trajectory. */
export const importPiSession = action({
  args: {
    projectId: v.id("projects"),
    jsonl: v.string(),
  },
  handler: async (ctx, args): Promise<PiImportResult> => {
    await ctx.runQuery(internal.agentTraces.authorizePersist, { projectId: args.projectId });
    const inputBytes = new TextEncoder().encode(args.jsonl).byteLength;
    if (inputBytes > MAX_BYTES) {
      throw new Error(
        `Pi session is too large (${inputBytes} bytes, limit ${MAX_BYTES}). Trim old branches and retry.`,
      );
    }

    const { sessionId, trace, summary } = parsePiSession(args.jsonl);
    if (summary.truncated) {
      throw new Error("Pi session exceeds the 50,000-line parser limit. Split the session and retry.");
    }
    const persisted = await ctx.runAction(api.agentTraces.persistTrace, {
      projectId: args.projectId,
      trace: trace as unknown as AgentRunTrace,
    });
    if (persisted.deduped) return { deduped: true, summary };

    const rawPayloadStorageId: Id<"_storage"> = await ctx.storage.store(
      new Blob([args.jsonl], { type: "application/x-ndjson" }),
    );
    const traceImportId = await ctx.runMutation(api.traceImports.createImport, {
      projectId: args.projectId,
      source: "pi",
      sourceTraceId: sessionId,
      rawPayloadStorageId,
    });
    await ctx.runMutation(internal.agentTraces.linkTraceImport, {
      agentTraceId: persisted.agentTraceId,
      traceImportId,
    });

    return { deduped: false, summary };
  },
});
