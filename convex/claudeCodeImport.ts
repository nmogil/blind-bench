/**
 * #265 (M31.2): import a Claude Code session `.jsonl` transcript as an agent
 * trajectory through the M31.1 spine.
 *
 * Privacy posture matches the Gateway importer (`gatewayImport.ts`): the raw
 * file is retained in access-controlled storage for re-parsing, the return is a
 * management-safe summary (counts / models / time bounds — never content), and
 * re-uploading the same session is idempotent.
 *
 * Action-first: parse → persist through the spine (which dedups by trace id) →
 * only if new, store the raw file + record import provenance. That ordering
 * means an idempotent re-upload does zero extra storage work.
 */
import { v } from "convex/values";
import { action } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { AgentRunTrace } from "./lib/agentTrace";
import { parseClaudeCodeSession, type ClaudeCodeSummary } from "./lib/claudeCodeTrace";

// Same order of magnitude as the Gateway importer's cap. Claude Code sessions
// can be multi-MB; larger ones must be split (an action string arg is bounded).
const MAX_BYTES = 8 * 1024 * 1024;

type ImportResult = {
  deduped: boolean;
  summary: ClaudeCodeSummary;
};

export const importClaudeCodeSession = action({
  args: {
    projectId: v.id("projects"),
    jsonl: v.string(),
  },
  handler: async (ctx, args): Promise<ImportResult> => {
    if (args.jsonl.length > MAX_BYTES) {
      throw new Error(
        `Session too large (${args.jsonl.length} chars, limit ${MAX_BYTES}). Split the transcript or trim old turns.`,
      );
    }

    const { sessionId, trace, summary } = parseClaudeCodeSession(args.jsonl);

    // Persist through the spine first — it dedups by trace id (`cc-<sessionId>`),
    // so a re-upload short-circuits before any storage write. Auth (project
    // owner/editor) is enforced inside persistTrace's parent mutation.
    const persist = await ctx.runAction(api.agentTraces.persistTrace, {
      projectId: args.projectId,
      trace: trace as unknown as AgentRunTrace,
    });
    if (persist.deduped) {
      return { deduped: true, summary };
    }

    // New trace: retain the raw file (access-controlled) and record provenance.
    const storageId: Id<"_storage"> = await ctx.storage.store(
      new Blob([args.jsonl], { type: "application/x-ndjson" }),
    );
    const traceImportId = await ctx.runMutation(api.traceImports.createImport, {
      projectId: args.projectId,
      source: "claude_code",
      sourceTraceId: sessionId,
      rawPayloadStorageId: storageId,
    });
    await ctx.runMutation(internal.agentTraces.linkTraceImport, {
      agentTraceId: persist.agentTraceId,
      traceImportId,
    });

    return { deduped: false, summary };
  },
});
