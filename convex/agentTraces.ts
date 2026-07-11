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
import { action, internalMutation, internalQuery, query } from "./_generated/server";
import type { ActionCtx, MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { requireAuth, requireProjectRole, isBlindReviewer } from "./lib/auth";
import type { AgentRunTrace } from "./lib/agentTrace";
import { redactValue } from "./lib/agentTrace";
import { splitStep } from "./lib/agentTraceStorage";
import { blindStepView, blindTraceView } from "./lib/blindProjection";
import { ensureTraceSessionsForProjectReviewers } from "./lib/traceReviewSessions";

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
  prefixHash: v.string(),
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

const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
};

const sha256 = async (value: string): Promise<string> => {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

// --- mutations (auth + dedup + writes, transactional) -----------------------

/** Cheap authorization gate for actions before parsing or touching storage. */
export const authorizePersist = internalQuery({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    await requireProjectRole(ctx, args.projectId, ["owner", "editor"]);
    return null;
  },
});

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

/**
 * Parent insert for the OTLP ingest path (#263). Same dedup + insert as
 * insertTraceParent but token-authed upstream (the HTTP action verified the
 * ingest token), so it takes `importedById` explicitly instead of resolving a
 * signed-in user. Only reachable from the verified ingest action (internal).
 */
export const insertTraceParentForIngest = internalMutation({
  args: {
    projectId: v.id("projects"),
    importedById: v.id("users"),
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
    const existing = await ctx.db
      .query("agentTraces")
      .withIndex("by_trace_id", (q) => q.eq("traceId", args.traceId))
      .filter((q) => q.eq(q.field("projectId"), args.projectId))
      .first();
    if (existing) return { agentTraceId: existing._id, deduped: true };
    const { importedById, ...rest } = args;
    const agentTraceId = await ctx.db.insert("agentTraces", {
      ...rest,
      source: "agent_harness",
      status: "pending",
      importedById,
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

/** Attach final-answer blobs while keeping a trace unpublished for batch commit. */
export const stageTrace = internalMutation({
  args: {
    agentTraceId: v.id("agentTraces"),
    finalAnswerStorageId: v.optional(v.id("_storage")),
    finalAnswerBlindStorageId: v.optional(v.id("_storage")),
  },
  handler: async (ctx, args) => {
    const trace = await ctx.db.get(args.agentTraceId);
    if (!trace || trace.status !== "pending") {
      throw new Error("Pending trace not found while staging import.");
    }
    await ctx.db.patch(args.agentTraceId, {
      finalAnswerStorageId: args.finalAnswerStorageId,
      finalAnswerBlindStorageId: args.finalAnswerBlindStorageId,
    });
  },
});

/** Attach final-answer blobs and flip a standalone trace to "ready". */
export const finalizeTrace = internalMutation({
  args: {
    agentTraceId: v.id("agentTraces"),
    finalAnswerStorageId: v.optional(v.id("_storage")),
    finalAnswerBlindStorageId: v.optional(v.id("_storage")),
  },
  handler: async (ctx, args) => {
    const trace = await ctx.db.get(args.agentTraceId);
    if (!trace) throw new Error("Trace not found while finalizing import.");
    await ctx.db.patch(args.agentTraceId, {
      status: "ready",
      finalAnswerStorageId: args.finalAnswerStorageId,
      finalAnswerBlindStorageId: args.finalAnswerBlindStorageId,
    });
    await ensureTraceSessionsForProjectReviewers(ctx, args.agentTraceId, trace.projectId);
  },
});

/** Link import provenance onto an already-persisted trace (set once, when new). */
export const linkTraceImport = internalMutation({
  args: {
    agentTraceId: v.id("agentTraces"),
    traceImportId: v.id("traceImports"),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.agentTraceId, { traceImportId: args.traceImportId });
  },
});

/** Delete one newly-created trace and every child row/blob. Idempotent. */
export async function deleteTraceCascade(
  ctx: MutationCtx,
  agentTraceId: Id<"agentTraces">,
): Promise<void> {
  const trace = await ctx.db.get(agentTraceId);
  const steps = await ctx.db
    .query("agentTraceSteps")
    .withIndex("by_trace_and_index", (q) => q.eq("agentTraceId", agentTraceId))
    .collect();
  const storageIds = new Set<Id<"_storage">>();
  const [sessions, comments, verdicts] = await Promise.all([
    ctx.db.query("agentTraceReviewSessions").withIndex("by_trace_and_reviewer", (q) => q.eq("agentTraceId", agentTraceId)).collect(),
    ctx.db.query("agentTraceComments").withIndex("by_trace", (q) => q.eq("agentTraceId", agentTraceId)).collect(),
    ctx.db.query("agentTraceVerdicts").withIndex("by_trace", (q) => q.eq("agentTraceId", agentTraceId)).collect(),
  ]);
  for (const row of [...sessions, ...comments, ...verdicts]) await ctx.db.delete(row._id);
  for (const step of steps) {
    if (step.fullBodyStorageId) storageIds.add(step.fullBodyStorageId);
    if (step.blindBodyStorageId) storageIds.add(step.blindBodyStorageId);
    await ctx.db.delete(step._id);
  }
  if (trace?.finalAnswerStorageId) storageIds.add(trace.finalAnswerStorageId);
  if (trace?.finalAnswerBlindStorageId) storageIds.add(trace.finalAnswerBlindStorageId);
  for (const storageId of storageIds) {
    try { await ctx.storage.delete(storageId); } catch { /* idempotent cleanup */ }
  }
  if (trace) await ctx.db.delete(trace._id);
}

export const deleteTraceCascadeInternal = internalMutation({
  args: { agentTraceId: v.id("agentTraces") },
  handler: async (ctx, args) => await deleteTraceCascade(ctx, args.agentTraceId),
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
    await ctx.runQuery(internal.agentTraces.authorizePersist, { projectId: args.projectId });
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
    await storeTraceSteps(ctx, agentTraceId, trace);
    return { agentTraceId, deduped: false, stepCount };
  },
});

/**
 * Store a trace's step bodies (full + precomputed blind) and step rows, plus the
 * final answer, then flip the parent to "ready". Shared by persistTrace and the
 * OTLP ingest path (#263) — the only difference between them is the parent-row
 * insert (user-auth vs token-auth). On failure the parent is marked failed with
 * a sanitized message.
 */
export async function storeTraceSteps(
  ctx: ActionCtx,
  agentTraceId: Id<"agentTraces">,
  trace: AgentRunTrace,
  options: {
    readonly completion?: "ready" | "staged";
    readonly heartbeat?: () => Promise<void>;
  } = {},
): Promise<void> {
  const unlinkedStorageIds: Id<"_storage">[] = [];
  const heartbeat = options.heartbeat ?? (async () => undefined);
  try {
    const rows: Array<Record<string, unknown>> = [];
    let prefixHash = await sha256("");
    await heartbeat();
    for (let index = 0; index < trace.steps.length; index++) {
      const step = trace.steps[index];
      if (!step) throw new Error("Trace step disappeared while storing evidence.");
      const { row, fullBody, blindBody } = splitStep(step);
      const fullBodyStorageId =
        fullBody === undefined ? undefined : await storeJson(ctx, fullBody);
      if (fullBodyStorageId) unlinkedStorageIds.push(fullBodyStorageId);
      const blindBodyStorageId =
        blindBody === undefined ? undefined : await storeJson(ctx, blindBody);
      if (blindBodyStorageId) unlinkedStorageIds.push(blindBodyStorageId);
      rows.push({ ...row, prefixHash, fullBodyStorageId, blindBodyStorageId });
      prefixHash = await sha256(`${prefixHash}:${stableStringify(step)}`);
      if ((index + 1) % 25 === 0) await heartbeat();
    }
    await heartbeat();
    for (let i = 0; i < rows.length; i += STEP_INSERT_CHUNK) {
      await ctx.runMutation(internal.agentTraces.insertSteps, {
        agentTraceId,
        steps: rows.slice(i, i + STEP_INSERT_CHUNK) as never,
      });
      await heartbeat();
    }
    let finalAnswerStorageId: Id<"_storage"> | undefined;
    let finalAnswerBlindStorageId: Id<"_storage"> | undefined;
    await heartbeat();
    if (trace.final_answer !== undefined) {
      finalAnswerStorageId = await storeJson(ctx, { text: trace.final_answer });
      unlinkedStorageIds.push(finalAnswerStorageId);
      finalAnswerBlindStorageId = await storeJson(ctx, {
        text: redactValue(trace.final_answer, "blind_view"),
      });
      unlinkedStorageIds.push(finalAnswerBlindStorageId);
    }
    await heartbeat();
    await ctx.runMutation(
      options.completion === "staged"
        ? internal.agentTraces.stageTrace
        : internal.agentTraces.finalizeTrace,
      {
        agentTraceId,
        finalAnswerStorageId,
        finalAnswerBlindStorageId,
      },
    );
  } catch {
    for (const storageId of unlinkedStorageIds) {
      try { await ctx.storage.delete(storageId); } catch { /* best-effort rollback */ }
    }
    await ctx.runMutation(internal.agentTraces.deleteTraceCascadeInternal, { agentTraceId });
    throw new Error("Trace import failed while persisting steps.");
  }
}

// --- reads (auth + blind projection at the boundary) ------------------------

/**
 * Parent metadata for one trace. For blind principals the full projection
 * (#266, `blindTraceView`) strips every direct identifier — harness, model,
 * provider, real ids, product, environment. Final answer, when present, is an
 * opaque storage URL — the blind blob for blind principals, the full otherwise.
 */
export const getTrace = query({
  args: { agentTraceId: v.id("agentTraces") },
  handler: async (ctx, args) => {
    const trace = await ctx.db.get(args.agentTraceId);
    if (!trace) return null;
    await requireProjectRole(ctx, trace.projectId, ["owner", "editor", "evaluator"]);
    const blind = await isBlindReviewer(ctx, trace.projectId);
    if (blind) throw new Error("Use an opaque review session to access this trajectory.");
    const project = await ctx.db.get(trace.projectId);
    const finalAnswerId = blind
      ? trace.finalAnswerBlindStorageId
      : trace.finalAnswerStorageId;
    const view = {
      _id: trace._id as string,
      // Eval project name (not harness/model provenance) — powers the
      // "Evaluation — {project}" document title on the blind surface.
      projectName: project?.name ?? "Project",
      traceId: trace.traceId,
      product: trace.product,
      module: trace.module,
      environment: trace.environment,
      status: trace.status,
      stepCount: trace.stepCount,
      privacyClass: trace.privacyClass,
      model: trace.model,
      harnessName: trace.harnessName,
      harnessVersion: trace.harnessVersion,
      usage: {
        costUsd: trace.costUsd,
        durationMs: trace.durationMs,
        totalTokens: trace.totalTokens,
      },
      hasFinalAnswer: finalAnswerId != null,
    };
    return blind ? blindTraceView(view) : view;
  },
});

/**
 * Resolve the storage id for a step body (or the final answer, when
 * `stepIndex` is omitted), blind-selected. Auth-gated so the `getStepBody`
 * action never reads storage for an unauthorized caller — same split as the
 * gateway importer (actions have no ctx.db).
 */
export const resolveBodyStorage = internalQuery({
  args: { agentTraceId: v.id("agentTraces"), stepIndex: v.optional(v.number()) },
  handler: async (ctx, args): Promise<{ storageId: Id<"_storage"> | null }> => {
    const trace = await ctx.db.get(args.agentTraceId);
    if (!trace) return { storageId: null };
    await requireProjectRole(ctx, trace.projectId, ["owner", "editor", "evaluator"]);
    const blind = await isBlindReviewer(ctx, trace.projectId);
    if (blind) throw new Error("Use an opaque review session to access trajectory bodies.");
    if (args.stepIndex === undefined) {
      const id = blind ? trace.finalAnswerBlindStorageId : trace.finalAnswerStorageId;
      return { storageId: id ?? null };
    }
    const row = await ctx.db
      .query("agentTraceSteps")
      .withIndex("by_trace_and_index", (q) =>
        q.eq("agentTraceId", args.agentTraceId).eq("stepIndex", args.stepIndex!),
      )
      .first();
    if (!row) return { storageId: null };
    const id = blind ? row.blindBodyStorageId : row.fullBodyStorageId;
    return { storageId: id ?? null };
  },
});

/**
 * Fetch a single step body (or the final answer) on demand — the lazy-load path
 * behind the trace viewer's expandable steps. Returns the parsed body object
 * (`{content}` / `{args}` / `{result}` / `{snapshot}` / `{text}`) or null.
 *
 * Goes through the authenticated Convex channel rather than handing the client a
 * raw storage URL: no cross-origin fetch, and a blind principal is never given
 * the full blob's id or url — the internal query already blind-selected which
 * blob this returns.
 */
export const getStepBody = action({
  args: { agentTraceId: v.id("agentTraces"), stepIndex: v.optional(v.number()) },
  handler: async (ctx, args): Promise<unknown> => {
    const { storageId } = await ctx.runQuery(
      internal.agentTraces.resolveBodyStorage,
      args,
    );
    if (!storageId) return null;
    const blob = await ctx.storage.get(storageId);
    if (!blob) return null;
    try {
      return JSON.parse(await blob.text());
    } catch {
      return null;
    }
  },
});

/**
 * Traces in a project, newest first (capped). Blind principals get no
 * harness/model/product — just the opaque handle, step count, and status.
 */
export const listTraces = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    await requireProjectRole(ctx, args.projectId, ["owner", "editor", "evaluator"]);
    const blind = await isBlindReviewer(ctx, args.projectId);
    if (blind) throw new Error("Use the opaque review-session inbox.");
    const rows = await ctx.db
      .query("agentTraces")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .order("desc")
      .take(200);
    return rows.map((r) => ({
      _id: r._id,
      status: r.status,
      stepCount: r.stepCount,
      createdAt: r._creationTime,
      product: blind ? undefined : r.product,
      harnessName: blind ? undefined : r.harnessName,
      model: blind ? undefined : r.model,
    }));
  },
});

/**
 * Traces the caller can review across ALL projects they collaborate on — the
 * discovery list for the blind eval surface (`/eval/traces`), where the reviewer
 * has no project context. Blind-projected per project (a reviewer can be blind
 * on one project, not another). Only `ready` traces; newest first, capped.
 */
export const listReviewableTraces = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireAuth(ctx);
    const collabs = await ctx.db
      .query("projectCollaborators")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const out: Array<{
      _id: Id<"agentTraces">;
      projectName: string;
      status: string;
      stepCount: number;
      createdAt: number;
      product?: string;
      harnessName?: string;
      model?: string;
    }> = [];
    for (const c of collabs) {
      const blind = await isBlindReviewer(ctx, c.projectId);
      if (blind) continue;
      const project = await ctx.db.get(c.projectId);
      const traces = await ctx.db
        .query("agentTraces")
        .withIndex("by_project", (q) => q.eq("projectId", c.projectId))
        .order("desc")
        .take(100);
      for (const tr of traces) {
        if (tr.status !== "ready") continue;
        out.push({
          _id: tr._id,
          projectName: project?.name ?? "Project",
          status: tr.status,
          stepCount: tr.stepCount,
          createdAt: tr._creationTime,
          product: blind ? undefined : tr.product,
          harnessName: blind ? undefined : tr.harnessName,
          model: blind ? undefined : tr.model,
        });
      }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt).slice(0, 200);
  },
});

/**
 * Paginated step read — the ONLY way to read steps. Never returns a full trace.
 * Each page item carries inline scalars + a `hasBody` flag. Bodies are fetched
 * lazily via `getStepBody` (authenticated, blind-selected) — never handed out
 * as a raw storage URL, and no storage id ever appears in the result.
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
    if (blind) throw new Error("Use an opaque review session to page trajectory steps.");

    const result = await ctx.db
      .query("agentTraceSteps")
      .withIndex("by_trace_and_index", (q) => q.eq("agentTraceId", args.agentTraceId))
      .paginate(args.paginationOpts);

    const page = result.page.map((row) => {
      const bodyId = blind ? row.blindBodyStorageId : row.fullBodyStorageId;
      const item = {
        stepIndex: row.stepIndex,
        kind: row.kind,
        role: row.role,
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
        // Whether this step has a body to lazy-load (fetched via getStepBody,
        // never handed out as a raw storage URL).
        hasBody: bodyId != null,
      };
      // #266: blind principals get the identifier-scrubbed projection
      // (aliased tool name, opaque call id, no wall-clock timestamp).
      return blind ? blindStepView(item) : item;
    });
    return { ...result, page };
  },
});
