/**
 * #264 (M31 Trajectory Spine): storage + read spine for normalized agent-run
 * traces.
 *
 * Shape (see schema.ts + lib/agentTraceStorage.ts):
 * - A trace is NEVER one document. `agentTraces` is a tiny metadata/rollup
 *   parent; each step is its own `agentTraceSteps` row with heavy bodies in
 *   file storage. A 500-step run stays well under the ~1MiB per-doc cap.
 * - Ingestion is action-first because `ctx.storage.store` is action-only:
 *   `persistTrace` (action) inserts the parent, stores per-step body blobs,
 *   inserts step rows in chunks, then finalizes. Auth + dedup live inside the
 *   mutations so they stay transactional (same split as gatewayImport.ts).
 * - Reads are PAGINATED only (`listSteps`), never a reactive subscription over a
 *   full trace. Bodies reach the client as opaque storage URLs, not inline.
 * - Blind projection is PRECOMPUTED at ingest (full + blind body per step) and
 *   ENFORCED at the function boundary: a blind principal is handed only the
 *   blind blob's URL — the full storage id is never returned to them.
 *
 * Not in scope here (later M31 issues): richer blind projection of inline
 * scalars like tool names / harness identity (#266), and the review UI (#267).
 */
import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { action, internalMutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { requireProjectRole, isBlindReviewer } from "./lib/auth";
import type { AgentRunTrace } from "./lib/agentTrace";
import { redactValue } from "./lib/agentTrace";
import { splitStep } from "./lib/agentTraceStorage";

const STEP_INSERT_CHUNK = 100;

const privacyClassValidator = v.union(
  v.literal("public"),
  v.literal("internal"),
  v.literal("confidential"),
  v.literal("pii"),
  v.literal("phi"),
);

const stepKindValidator = v.union(
  v.literal("message"),
  v.literal("tool_call"),
  v.literal("tool_result"),
  v.literal("state"),
  v.literal("policy_event"),
);

const stepInsertValidator = v.object({
  stepIndex: v.number(),
  kind: stepKindValidator,
  role: v.optional(v.string()),
  toolName: v.optional(v.string()),
  toolCallId: v.optional(v.string()),
  label: v.optional(v.string()),
  policy: v.optional(v.string()),
  action: v.optional(v.string()),
  reason: v.optional(v.string()),
  timestamp: v.optional(v.string()),
  privacyClass: v.optional(privacyClassValidator),
  inputTokens: v.optional(v.number()),
  outputTokens: v.optional(v.number()),
  durationMs: v.optional(v.number()),
  fullBodyStorageId: v.optional(v.id("_storage")),
  blindBodyStorageId: v.optional(v.id("_storage")),
});

const storeJson = (
  ctx: { storage: { store: (b: Blob) => Promise<Id<"_storage">> } },
  body: unknown,
): Promise<Id<"_storage">> =>
  ctx.storage.store(new Blob([JSON.stringify(body)], { type: "application/json" }));

// --- mutations (auth + dedup + writes, transactional) -----------------------

/**
 * Insert the parent row (status "pending"). Auth + dedup by (projectId,
 * traceId): a re-import of the same normalized trace returns the existing id
 * instead of duplicating. A prior FAILED row with the same traceId is NOT
 * retried here — dedup is by id presence.
 * ponytail: retry-of-failed needs manual cleanup for now; add status-aware
 * dedup only if failed re-imports become common.
 */
export const insertTraceParent = internalMutation({
  args: {
    projectId: v.id("projects"),
    traceImportId: v.optional(v.id("traceImports")),
    traceId: v.string(),
    harnessName: v.string(),
    harnessVersion: v.optional(v.string()),
    harnessSdk: v.optional(v.string()),
    product: v.string(),
    module: v.optional(v.string()),
    environment: v.optional(v.string()),
    model: v.optional(v.string()),
    runId: v.optional(v.string()),
    stepCount: v.number(),
    privacyClass: privacyClassValidator,
    costUsd: v.optional(v.number()),
    durationMs: v.optional(v.number()),
    totalTokens: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ agentTraceId: Id<"agentTraces">; deduped: boolean }> => {
    const { userId } = await requireProjectRole(ctx, args.projectId, [
      "owner",
      "editor",
    ]);
    const existing = await ctx.db
      .query("agentTraces")
      .withIndex("by_trace_id", (q) => q.eq("traceId", args.traceId))
      .filter((q) => q.eq(q.field("projectId"), args.projectId))
      .first();
    if (existing) return { agentTraceId: existing._id, deduped: true };

    const agentTraceId = await ctx.db.insert("agentTraces", {
      projectId: args.projectId,
      traceImportId: args.traceImportId,
      traceId: args.traceId,
      source: "agent_harness",
      harnessName: args.harnessName,
      harnessVersion: args.harnessVersion,
      harnessSdk: args.harnessSdk,
      product: args.product,
      module: args.module,
      environment: args.environment,
      model: args.model,
      runId: args.runId,
      stepCount: args.stepCount,
      status: "pending",
      privacyClass: args.privacyClass,
      costUsd: args.costUsd,
      durationMs: args.durationMs,
      totalTokens: args.totalTokens,
      importedById: userId,
    });
    return { agentTraceId, deduped: false };
  },
});

/** Insert a chunk of step rows for an already-created parent. */
export const insertSteps = internalMutation({
  args: {
    agentTraceId: v.id("agentTraces"),
    steps: v.array(stepInsertValidator),
  },
  handler: async (ctx, args) => {
    for (const step of args.steps) {
      await ctx.db.insert("agentTraceSteps", { agentTraceId: args.agentTraceId, ...step });
    }
  },
});

/** Attach final-answer blobs and flip the parent to "ready". */
export const finalizeTrace = internalMutation({
  args: {
    agentTraceId: v.id("agentTraces"),
    finalAnswerStorageId: v.optional(v.id("_storage")),
    finalAnswerBlindStorageId: v.optional(v.id("_storage")),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.agentTraceId, {
      status: "ready",
      finalAnswerStorageId: args.finalAnswerStorageId,
      finalAnswerBlindStorageId: args.finalAnswerBlindStorageId,
    });
  },
});

/** Mark a partially-imported trace failed with a sanitized message. */
export const markTraceFailed = internalMutation({
  args: { agentTraceId: v.id("agentTraces"), message: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.agentTraceId, {
      status: "failed",
      errorMessage: args.message,
    });
  },
});

// --- ingestion action -------------------------------------------------------

/**
 * Persist a normalized `AgentRunTrace`. Callers (importers) normalize their
 * harness-specific export into the interchange type first, then call this.
 *
 * `trace` is v.any(): it is trusted-shape output of the normalizer, not raw
 * client input, and the persist path reads only well-known fields; the mutation
 * auth (project owner/editor) is the real gate. Content stored is the caller's
 * own project data.
 */
export const persistTrace = action({
  args: {
    projectId: v.id("projects"),
    traceImportId: v.optional(v.id("traceImports")),
    trace: v.any(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ agentTraceId: Id<"agentTraces">; deduped: boolean; stepCount: number }> => {
    const trace = args.trace as AgentRunTrace;
    const stepCount = trace.steps.length;

    const { agentTraceId, deduped } = await ctx.runMutation(
      internal.agentTraces.insertTraceParent,
      {
        projectId: args.projectId,
        traceImportId: args.traceImportId,
        traceId: trace.trace_id,
        harnessName: trace.harness.name,
        harnessVersion: trace.harness.version,
        harnessSdk: trace.harness.sdk,
        product: trace.product,
        module: trace.module,
        environment: trace.environment,
        model: trace.model,
        runId: trace.run_id,
        stepCount,
        privacyClass: trace.privacy.class,
        costUsd: trace.usage.cost_usd,
        durationMs: trace.usage.duration_ms,
        totalTokens: trace.usage.total_tokens,
      },
    );
    // Idempotent: an already-imported trace keeps its stored steps untouched.
    if (deduped) return { agentTraceId, deduped: true, stepCount };

    try {
      // Store per-step body blobs, then insert rows carrying the storage ids.
      const rows: Array<Record<string, unknown>> = [];
      for (const step of trace.steps) {
        const { row, fullBody, blindBody } = splitStep(step);
        const fullBodyStorageId =
          fullBody === undefined ? undefined : await storeJson(ctx, fullBody);
        const blindBodyStorageId =
          blindBody === undefined ? undefined : await storeJson(ctx, blindBody);
        rows.push({ ...row, fullBodyStorageId, blindBodyStorageId });
      }
      for (let i = 0; i < rows.length; i += STEP_INSERT_CHUNK) {
        await ctx.runMutation(internal.agentTraces.insertSteps, {
          agentTraceId,
          steps: rows.slice(i, i + STEP_INSERT_CHUNK) as never,
        });
      }

      // Final answer → storage (full + precomputed blind), keeps parent bounded.
      let finalAnswerStorageId: Id<"_storage"> | undefined;
      let finalAnswerBlindStorageId: Id<"_storage"> | undefined;
      if (trace.final_answer !== undefined) {
        finalAnswerStorageId = await storeJson(ctx, { text: trace.final_answer });
        finalAnswerBlindStorageId = await storeJson(ctx, {
          text: redactValue(trace.final_answer, "blind_view"),
        });
      }

      await ctx.runMutation(internal.agentTraces.finalizeTrace, {
        agentTraceId,
        finalAnswerStorageId,
        finalAnswerBlindStorageId,
      });
      return { agentTraceId, deduped: false, stepCount };
    } catch {
      // Sanitized — never echo trace content.
      await ctx.runMutation(internal.agentTraces.markTraceFailed, {
        agentTraceId,
        message: "Trace import failed while persisting steps.",
      });
      throw new Error("Trace import failed while persisting steps.");
    }
  },
});

// --- reads (auth + blind projection at the boundary) ------------------------

/**
 * Parent metadata for one trace. Harness identity + model are withheld from
 * blind principals (a coarse #264 measure; #266 refines). Final answer, when
 * present, is returned as an opaque storage URL — the blind blob for blind
 * principals, the full blob otherwise.
 */
export const getTrace = query({
  args: { agentTraceId: v.id("agentTraces") },
  handler: async (ctx, args) => {
    const trace = await ctx.db.get(args.agentTraceId);
    if (!trace) return null;
    await requireProjectRole(ctx, trace.projectId, ["owner", "editor", "evaluator"]);
    const blind = await isBlindReviewer(ctx, trace.projectId);
    const finalAnswerId = blind
      ? trace.finalAnswerBlindStorageId
      : trace.finalAnswerStorageId;
    return {
      _id: trace._id,
      traceId: trace.traceId,
      product: trace.product,
      module: trace.module,
      environment: trace.environment,
      status: trace.status,
      stepCount: trace.stepCount,
      privacyClass: trace.privacyClass,
      model: blind ? undefined : trace.model,
      harnessName: blind ? undefined : trace.harnessName,
      harnessVersion: blind ? undefined : trace.harnessVersion,
      usage: {
        costUsd: trace.costUsd,
        durationMs: trace.durationMs,
        totalTokens: trace.totalTokens,
      },
      finalAnswerUrl: finalAnswerId ? await ctx.storage.getUrl(finalAnswerId) : null,
    };
  },
});

/**
 * Paginated step read — the ONLY way to read steps. Never returns a full trace.
 * Each page item carries inline scalars + a single `bodyUrl` (opaque storage
 * URL). Blind principals receive the blind blob's URL and the full storage id
 * is never in their result; reviewers receive the full blob's URL.
 */
export const listSteps = query({
  args: {
    agentTraceId: v.id("agentTraces"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const trace = await ctx.db.get(args.agentTraceId);
    if (!trace) throw new Error("Trace not found");
    await requireProjectRole(ctx, trace.projectId, ["owner", "editor", "evaluator"]);
    const blind = await isBlindReviewer(ctx, trace.projectId);

    const result = await ctx.db
      .query("agentTraceSteps")
      .withIndex("by_trace_and_index", (q) => q.eq("agentTraceId", args.agentTraceId))
      .paginate(args.paginationOpts);

    const page = await Promise.all(
      result.page.map(async (row) => {
        const bodyId = blind ? row.blindBodyStorageId : row.fullBodyStorageId;
        return {
          stepIndex: row.stepIndex,
          kind: row.kind,
          role: row.role,
          // ponytail: toolName still visible to blind reviewers — harness
          // fingerprint scrubbing is #266's job, not the spine's.
          toolName: row.toolName,
          toolCallId: row.toolCallId,
          label: row.label,
          policy: row.policy,
          action: row.action,
          reason: row.reason,
          timestamp: row.timestamp,
          privacyClass: row.privacyClass,
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          durationMs: row.durationMs,
          bodyUrl: bodyId ? await ctx.storage.getUrl(bodyId) : null,
        };
      }),
    );
    return { ...result, page };
  },
});
