/** #354 project-scoped Mogil/Harbor full-span evidence batch ingest. */
import { httpAction, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { json, readToken } from "./otlpIngest";
import {
  HARBOR_EVIDENCE_MAX_RUNS,
  parseHarborEvidenceV1,
  type ParsedHarborEvidence,
} from "./lib/harborEvidence";
import { deleteTraceCascade, storeTraceSteps } from "./agentTraces";
import { ensureTraceSessionsForProjectReviewers } from "./lib/traceReviewSessions";

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const LEASE_MS = 5 * 60 * 1_000;
const processOutcomeValidator = v.object({
  status: v.union(v.literal("succeeded"), v.literal("failed")),
  summary: v.optional(v.string()),
});
const verifierOutcomeValidator = v.object({
  status: v.union(v.literal("passed"), v.literal("failed"), v.literal("not_run")),
  summary: v.optional(v.string()),
});
const infrastructureOutcomeValidator = processOutcomeValidator;
const qualificationValidator = v.union(
  v.literal("quality_eligible"),
  v.literal("fixture_only"),
  v.literal("insufficient"),
);
const reservationValidator = v.object({
  stableRunId: v.string(),
  attempt: v.string(),
  fingerprint: v.string(),
  runQualification: qualificationValidator,
  evidenceCompleteness: v.union(v.literal("complete"), v.literal("insufficient")),
  canJudgeTaskSuccess: v.boolean(),
  processOutcome: processOutcomeValidator,
  verifierOutcome: verifierOutcomeValidator,
  infrastructureOutcome: infrastructureOutcomeValidator,
  evidenceMissing: v.array(v.string()),
  rewards: v.record(v.string(), v.number()),
  startedAt: v.string(),
  completedAt: v.string(),
  terminationStatus: v.string(),
  terminationReason: v.string(),
});
type ReservationInput = {
  readonly stableRunId: string;
  readonly attempt: string;
  readonly fingerprint: string;
  readonly runQualification: "quality_eligible" | "fixture_only" | "insufficient";
  readonly evidenceCompleteness: "complete" | "insufficient";
  readonly canJudgeTaskSuccess: boolean;
  readonly processOutcome: { readonly status: "succeeded" | "failed"; readonly summary?: string };
  readonly verifierOutcome: { readonly status: "passed" | "failed" | "not_run"; readonly summary?: string };
  readonly infrastructureOutcome: { readonly status: "succeeded" | "failed"; readonly summary?: string };
  readonly evidenceMissing: string[];
  readonly rewards: Readonly<Record<string, number>>;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly terminationStatus: string;
  readonly terminationReason: string;
};

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(row[key])}`).join(",")}}`;
}
async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function readBodyWithLimit(req: Request): Promise<{ readonly ok: true; readonly text: string } | { readonly ok: false }> {
  if (!req.body) return { ok: true, text: "" };
  const reader = req.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel("payload too large");
        return { ok: false };
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return { ok: true, text };
  } catch {
    try { await reader.cancel("invalid request body"); } catch { /* already closed */ }
    return { ok: false };
  }
}

/** Atomically preflight every stable id/attempt before reserving any new run. */
export const reserveBatch = internalMutation({
  args: {
    projectId: v.id("projects"),
    importedById: v.id("users"),
    leaseId: v.string(),
    leaseExpiresAt: v.number(),
    runs: v.array(reservationValidator),
  },
  handler: async (ctx, args): Promise<
    | { readonly kind: "conflict" }
    | {
        readonly kind: "reserved";
        readonly rows: ReadonlyArray<{
          readonly stableRunId: string;
          readonly fullSpanRunId: Id<"fullSpanEvalRuns">;
          readonly deduped: boolean;
        }>;
      }
  > => {
    const planned: Array<{
      readonly input: (typeof args.runs)[number];
      readonly existingId?: Id<"fullSpanEvalRuns">;
    }> = [];
    for (const input of args.runs) {
      const existing = await ctx.db
        .query("fullSpanEvalRuns")
        .withIndex("by_project_and_stable_id", (q) =>
          q.eq("projectId", args.projectId).eq("stableRunId", input.stableRunId),
        )
        .unique();
      if (existing) {
        if (existing.fingerprint !== input.fingerprint || existing.attempt !== input.attempt) return { kind: "conflict" };
        if (existing.status === "ready") {
          planned.push({ input, existingId: existing._id });
          continue;
        }
        if (existing.status === "pending" || existing.status === "staged") {
          return { kind: "conflict" };
        }
        planned.push({ input, existingId: existing._id });
        continue;
      }
      const attemptOwner = await ctx.db
        .query("fullSpanEvalRuns")
        .withIndex("by_project_and_attempt", (q) =>
          q.eq("projectId", args.projectId).eq("attempt", input.attempt),
        )
        .unique();
      if (attemptOwner) return { kind: "conflict" };
      const legacyCollision = await ctx.db
        .query("agentTraces")
        .withIndex("by_trace_id", (q) => q.eq("traceId", input.stableRunId))
        .filter((q) => q.eq(q.field("projectId"), args.projectId))
        .first();
      const namespacedCollision = await ctx.db
        .query("agentTraces")
        .withIndex("by_trace_id", (q) => q.eq("traceId", `full-span:${input.stableRunId}`))
        .filter((q) => q.eq(q.field("projectId"), args.projectId))
        .first();
      if (legacyCollision || namespacedCollision) return { kind: "conflict" };
      planned.push({ input });
    }

    const rows: Array<{
      stableRunId: string;
      fullSpanRunId: Id<"fullSpanEvalRuns">;
      deduped: boolean;
    }> = [];
    for (const plan of planned) {
      if (plan.existingId) {
        const existing = await ctx.db.get(plan.existingId);
        const deduped = existing?.status === "ready";
        if (!deduped) {
          await ctx.db.patch(plan.existingId, {
            status: "pending",
            leaseId: args.leaseId,
            leaseExpiresAt: args.leaseExpiresAt,
            errorMessage: undefined,
          });
        }
        rows.push({ stableRunId: plan.input.stableRunId, fullSpanRunId: plan.existingId, deduped });
        continue;
      }
      const fullSpanRunId = await ctx.db.insert("fullSpanEvalRuns", {
        projectId: args.projectId,
        importedById: args.importedById,
        ...plan.input,
        evidenceMissing: [...plan.input.evidenceMissing],
        rewards: { ...plan.input.rewards },
        status: "pending",
        leaseId: args.leaseId,
        leaseExpiresAt: args.leaseExpiresAt,
      });
      rows.push({ stableRunId: plan.input.stableRunId, fullSpanRunId, deduped: false });
    }
    return { kind: "reserved", rows };
  },
});

async function cleanupReservationArtifacts(
  ctx: Parameters<typeof deleteTraceCascade>[0],
  row: { readonly pendingAgentTraceId?: Id<"agentTraces">; readonly pendingStorageIds?: ReadonlyArray<Id<"_storage">> },
): Promise<void> {
  if (row.pendingAgentTraceId) await deleteTraceCascade(ctx, row.pendingAgentTraceId);
  for (const storageId of row.pendingStorageIds ?? []) {
    try { await ctx.storage.delete(storageId); } catch { /* idempotent cleanup */ }
  }
}

export const cleanupRecoverableForProject = internalMutation({
  args: { projectId: v.id("projects"), now: v.number() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("fullSpanEvalRuns")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .take(200);
    let cleaned = 0;
    for (const row of rows) {
      const recoverable = row.status === "failed" ||
        ((row.status === "pending" || row.status === "staged") &&
          (row.leaseExpiresAt ?? 0) <= args.now);
      if (!recoverable) continue;
      await cleanupReservationArtifacts(ctx, row);
      await ctx.db.patch(row._id, {
        status: "failed",
        leaseId: undefined,
        leaseExpiresAt: undefined,
        pendingAgentTraceId: undefined,
        pendingStorageIds: undefined,
        agentTraceId: undefined,
        rawEvidenceStorageId: undefined,
        reviewerProjectionStorageId: undefined,
        errorMessage: "Full-span ingest reservation expired and was cleaned.",
      });
      cleaned++;
    }
    return { cleaned };
  },
});

export const cleanupExpiredReservations = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const [pending, staged] = await Promise.all([
      ctx.db
        .query("fullSpanEvalRuns")
        .withIndex("by_status_and_lease", (q) =>
          q.eq("status", "pending").lte("leaseExpiresAt", now),
        )
        .take(100),
      ctx.db
        .query("fullSpanEvalRuns")
        .withIndex("by_status_and_lease", (q) =>
          q.eq("status", "staged").lte("leaseExpiresAt", now),
        )
        .take(100),
    ]);
    const rows = [...pending, ...staged].slice(0, 100);
    for (const row of rows) {
      await cleanupReservationArtifacts(ctx, row);
      await ctx.db.patch(row._id, {
        status: "failed",
        leaseId: undefined,
        leaseExpiresAt: undefined,
        pendingAgentTraceId: undefined,
        pendingStorageIds: undefined,
        agentTraceId: undefined,
        rawEvidenceStorageId: undefined,
        reviewerProjectionStorageId: undefined,
        errorMessage: "Full-span ingest reservation expired and was cleaned.",
      });
    }
    return { cleaned: rows.length };
  },
});

export const trackPendingArtifacts = internalMutation({
  args: {
    fullSpanRunId: v.id("fullSpanEvalRuns"),
    leaseId: v.string(),
    storageIds: v.optional(v.array(v.id("_storage"))),
    agentTraceId: v.optional(v.id("agentTraces")),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.fullSpanRunId);
    if (!row || row.status !== "pending" || row.leaseId !== args.leaseId) {
      throw new Error("Full-span ingest lease is no longer owned.");
    }
    await ctx.db.patch(row._id, {
      pendingStorageIds: [...new Set([...(row.pendingStorageIds ?? []), ...(args.storageIds ?? [])])],
      pendingAgentTraceId: args.agentTraceId ?? row.pendingAgentTraceId,
    });
  },
});

/** Extend an actively owned reservation without changing its publish state. */
export const renewLease = internalMutation({
  args: {
    fullSpanRunId: v.id("fullSpanEvalRuns"),
    leaseId: v.string(),
    leaseExpiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.fullSpanRunId);
    if (
      !row ||
      (row.status !== "pending" && row.status !== "staged") ||
      row.leaseId !== args.leaseId
    ) {
      throw new Error("Full-span ingest lease is no longer owned.");
    }
    await ctx.db.patch(row._id, { leaseExpiresAt: args.leaseExpiresAt });
  },
});

/** Attach completed artifacts while keeping both run and trace unpublished. */
export const stage = internalMutation({
  args: {
    fullSpanRunId: v.id("fullSpanEvalRuns"),
    leaseId: v.string(),
    agentTraceId: v.id("agentTraces"),
    rawEvidenceStorageId: v.id("_storage"),
    reviewerProjectionStorageId: v.id("_storage"),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.fullSpanRunId);
    const trace = await ctx.db.get(args.agentTraceId);
    const trackedStorage = new Set(row?.pendingStorageIds ?? []);
    if (
      !row ||
      row.status !== "pending" ||
      row.leaseId !== args.leaseId ||
      row.pendingAgentTraceId !== args.agentTraceId ||
      !trackedStorage.has(args.rawEvidenceStorageId) ||
      !trackedStorage.has(args.reviewerProjectionStorageId) ||
      !trace ||
      trace.status !== "pending" ||
      trace.projectId !== row.projectId
    ) {
      throw new Error("Full-span run is unavailable while staging.");
    }
    await ctx.db.patch(row._id, {
      status: "staged",
      agentTraceId: args.agentTraceId,
      rawEvidenceStorageId: args.rawEvidenceStorageId,
      reviewerProjectionStorageId: args.reviewerProjectionStorageId,
      errorMessage: undefined,
    });
  },
});

const batchRowValidator = v.object({
  fullSpanRunId: v.id("fullSpanEvalRuns"),
  leaseId: v.string(),
});

/** Atomically publish every newly staged run and trace in one request. */
export const commitBatch = internalMutation({
  args: { rows: v.array(batchRowValidator) },
  handler: async (ctx, args) => {
    const seen = new Set<Id<"fullSpanEvalRuns">>();
    const validated: Array<{
      readonly run: Doc<"fullSpanEvalRuns">;
      readonly trace: Doc<"agentTraces">;
    }> = [];
    for (const item of args.rows) {
      if (seen.has(item.fullSpanRunId)) throw new Error("Full-span batch contains a duplicate reservation.");
      seen.add(item.fullSpanRunId);
      const run = await ctx.db.get(item.fullSpanRunId);
      if (
        !run ||
        run.status !== "staged" ||
        run.leaseId !== item.leaseId ||
        !run.agentTraceId ||
        !run.rawEvidenceStorageId ||
        !run.reviewerProjectionStorageId
      ) {
        throw new Error("Every full-span batch member must be owned and staged before commit.");
      }
      const trace = await ctx.db.get(run.agentTraceId);
      if (!trace || trace.status !== "pending" || trace.projectId !== run.projectId) {
        throw new Error("Every full-span trace must be pending and staged before commit.");
      }
      validated.push({ run, trace });
    }
    for (const { run, trace } of validated) {
      await ctx.db.patch(trace._id, { status: "ready" });
      await ctx.db.patch(run._id, {
        status: "ready",
        leaseId: undefined,
        leaseExpiresAt: undefined,
        pendingAgentTraceId: undefined,
        pendingStorageIds: undefined,
        errorMessage: undefined,
      });
      await ensureTraceSessionsForProjectReviewers(ctx, trace._id, run.projectId);
    }
    return { committed: validated.length };
  },
});

/** Cascade-clean every non-deduped reservation created by a failed request. */
export const failBatch = internalMutation({
  args: { rows: v.array(batchRowValidator) },
  handler: async (ctx, args) => {
    let cleaned = 0;
    for (const item of args.rows) {
      const row = await ctx.db.get(item.fullSpanRunId);
      if (
        !row ||
        (row.status !== "pending" && row.status !== "staged") ||
        row.leaseId !== item.leaseId
      ) {
        continue;
      }
      await cleanupReservationArtifacts(ctx, row);
      await ctx.db.patch(row._id, {
        status: "failed",
        leaseId: undefined,
        leaseExpiresAt: undefined,
        pendingAgentTraceId: undefined,
        pendingStorageIds: undefined,
        agentTraceId: undefined,
        rawEvidenceStorageId: undefined,
        reviewerProjectionStorageId: undefined,
        errorMessage: "Full-span evidence could not be stored.",
      });
      cleaned++;
    }
    return { cleaned };
  },
});

function reservationInput(parsed: ParsedHarborEvidence, fingerprint: string): ReservationInput {
  return {
    stableRunId: parsed.run.stableId,
    attempt: parsed.run.attempt,
    fingerprint,
    runQualification: parsed.projection.runQualification,
    evidenceCompleteness: parsed.projection.evidenceCompleteness,
    canJudgeTaskSuccess: parsed.projection.canJudgeTaskSuccess,
    processOutcome: parsed.objective.process as ReservationInput["processOutcome"],
    verifierOutcome: parsed.objective.verifier as ReservationInput["verifierOutcome"],
    infrastructureOutcome: parsed.objective.infrastructure as ReservationInput["infrastructureOutcome"],
    evidenceMissing: [...parsed.objective.evidence.missing],
    rewards: { ...parsed.objective.rewards },
    startedAt: parsed.projection.timing.startedAt,
    completedAt: parsed.projection.timing.completedAt,
    terminationStatus: parsed.run.status,
    terminationReason: parsed.projection.termination.reason,
  };
}

export const handler = httpAction(async (ctx, req) => {
  const token = readToken(req);
  if (!token) return json({ error: "Missing ingest token" }, 401);
  const resolved = await ctx.runQuery(internal.otlpIngest.resolveIngestToken, { token });
  if (!resolved) return json({ error: "Invalid or revoked ingest token" }, 401);
  if (!resolved.scopes.includes("traces:write")) return json({ error: "Token lacks traces:write scope" }, 403);

  const declaredLength = Number(req.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return json({ complete: 0, imported: 0, deduped: 0, invalid: 1, error: "Payload too large" }, 413);
  }
  const body = await readBodyWithLimit(req);
  if (!body.ok) {
    return json({ complete: 0, imported: 0, deduped: 0, invalid: 1, error: "Payload too large or invalid UTF-8" }, 413);
  }
  const textBody = body.text;
  let decoded: unknown;
  try { decoded = JSON.parse(textBody); } catch {
    return json({ complete: 0, imported: 0, deduped: 0, invalid: 1, error: "Invalid JSON" }, 400);
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    return json({ complete: 0, imported: 0, deduped: 0, invalid: 1, error: "Body must be an object with runs" }, 400);
  }
  const envelope = decoded as Record<string, unknown>;
  if (Object.keys(envelope).length !== 1 || !Array.isArray(envelope.runs)) {
    return json({ complete: 0, imported: 0, deduped: 0, invalid: 1, error: "Body must contain only runs" }, 400);
  }
  if (envelope.runs.length === 0 || envelope.runs.length > HARBOR_EVIDENCE_MAX_RUNS) {
    return json({ complete: 0, imported: 0, deduped: 0, invalid: envelope.runs.length || 1, error: `runs must contain 1 to ${HARBOR_EVIDENCE_MAX_RUNS} artifacts` }, 413);
  }

  const parsedRuns: Array<{ readonly raw: unknown; readonly parsed: ParsedHarborEvidence; readonly fingerprint: string }> = [];
  let invalid = 0;
  for (const raw of envelope.runs) {
    try {
      const parsed = await parseHarborEvidenceV1(raw);
      parsedRuns.push({ raw, parsed, fingerprint: await sha256(stableStringify(raw)) });
    } catch { invalid++; }
  }
  const stableIds = parsedRuns.map((item) => item.parsed.run.stableId);
  const attempts = parsedRuns.map((item) => item.parsed.run.attempt);
  if (invalid > 0 || parsedRuns.length !== envelope.runs.length) {
    return json({ complete: parsedRuns.length, imported: 0, deduped: 0, invalid }, 400);
  }
  if (new Set(stableIds).size !== stableIds.length || new Set(attempts).size !== attempts.length) {
    return json({ complete: 0, imported: 0, deduped: 0, invalid: envelope.runs.length }, 400);
  }

  const now = Date.now();
  await ctx.runMutation(internal.fullSpanIngest.cleanupRecoverableForProject, {
    projectId: resolved.projectId,
    now,
  });
  const leaseId = crypto.randomUUID();
  const reserved = await ctx.runMutation(internal.fullSpanIngest.reserveBatch, {
    projectId: resolved.projectId,
    importedById: resolved.createdById,
    leaseId,
    leaseExpiresAt: now + LEASE_MS,
    runs: parsedRuns.map((item) => reservationInput(item.parsed, item.fingerprint)),
  });
  if (reserved.kind === "conflict") {
    return json({ complete: 0, imported: 0, deduped: 0, invalid: 0, error: "A run id or attempt conflicts with stored evidence" }, 409);
  }

  const created = reserved.rows.filter((row) => !row.deduped);
  const deduped = reserved.rows.length - created.length;
  const heartbeat = async (fullSpanRunId: Id<"fullSpanEvalRuns">): Promise<void> => {
    await ctx.runMutation(internal.fullSpanIngest.renewLease, {
      fullSpanRunId,
      leaseId,
      leaseExpiresAt: Date.now() + LEASE_MS,
    });
  };
  let rawEvidenceStorageId: Id<"_storage"> | undefined;
  let reviewerProjectionStorageId: Id<"_storage"> | undefined;
  try {
    for (let index = 0; index < reserved.rows.length; index++) {
      const reservation = reserved.rows[index];
      const source = parsedRuns[index];
      if (!reservation || !source) throw new Error("Reserved batch ordering changed.");
      if (reservation.deduped) continue;
      rawEvidenceStorageId = undefined;
      reviewerProjectionStorageId = undefined;
      await heartbeat(reservation.fullSpanRunId);

      await heartbeat(reservation.fullSpanRunId);
      rawEvidenceStorageId = await ctx.storage.store(
        new Blob([JSON.stringify(source.raw)], { type: "application/json" }),
      );
      await heartbeat(reservation.fullSpanRunId);
      await ctx.runMutation(internal.fullSpanIngest.trackPendingArtifacts, {
        fullSpanRunId: reservation.fullSpanRunId,
        leaseId,
        storageIds: [rawEvidenceStorageId],
      });

      await heartbeat(reservation.fullSpanRunId);
      reviewerProjectionStorageId = await ctx.storage.store(
        new Blob([JSON.stringify(source.parsed.projection)], { type: "application/json" }),
      );
      await heartbeat(reservation.fullSpanRunId);
      await ctx.runMutation(internal.fullSpanIngest.trackPendingArtifacts, {
        fullSpanRunId: reservation.fullSpanRunId,
        leaseId,
        storageIds: [reviewerProjectionStorageId],
      });

      await heartbeat(reservation.fullSpanRunId);
      const parent = await ctx.runMutation(internal.agentTraces.insertTraceParentForIngest, {
        projectId: resolved.projectId,
        importedById: resolved.createdById,
        traceId: source.parsed.trace.trace_id,
        harnessName: source.parsed.trace.harness.name,
        harnessVersion: source.parsed.trace.harness.version,
        harnessSdk: source.parsed.trace.harness.sdk,
        product: source.parsed.trace.product,
        module: source.parsed.trace.module,
        environment: source.parsed.trace.environment,
        runId: source.parsed.trace.run_id,
        stepCount: source.parsed.trace.steps.length,
        privacyClass: source.parsed.trace.privacy.class,
        costUsd: source.parsed.trace.usage.cost_usd,
        durationMs: source.parsed.trace.usage.duration_ms,
        totalTokens: source.parsed.trace.usage.total_tokens,
      });
      if (parent.deduped) throw new Error("Unexpected trace collision");
      await ctx.runMutation(internal.fullSpanIngest.trackPendingArtifacts, {
        fullSpanRunId: reservation.fullSpanRunId,
        leaseId,
        agentTraceId: parent.agentTraceId,
      });
      await heartbeat(reservation.fullSpanRunId);
      await storeTraceSteps(ctx, parent.agentTraceId, source.parsed.trace, {
        completion: "staged",
        heartbeat: async () => await heartbeat(reservation.fullSpanRunId),
      });
      await heartbeat(reservation.fullSpanRunId);
      await ctx.runMutation(internal.fullSpanIngest.stage, {
        fullSpanRunId: reservation.fullSpanRunId,
        leaseId,
        agentTraceId: parent.agentTraceId,
        rawEvidenceStorageId,
        reviewerProjectionStorageId,
      });
    }

    await ctx.runMutation(internal.fullSpanIngest.commitBatch, {
      rows: created.map((row) => ({ fullSpanRunId: row.fullSpanRunId, leaseId })),
    });
  } catch {
    await ctx.runMutation(internal.fullSpanIngest.failBatch, {
      rows: created.map((row) => ({ fullSpanRunId: row.fullSpanRunId, leaseId })),
    });
    for (const storageId of [rawEvidenceStorageId, reviewerProjectionStorageId]) {
      if (storageId) {
        try { await ctx.storage.delete(storageId); } catch { /* idempotent cleanup */ }
      }
    }
    return json({ complete: 0, imported: 0, deduped, invalid: 0, error: "Full-span evidence batch could not be stored" }, 500);
  }
  await ctx.runMutation(internal.otlpIngest.touchIngestToken, { token });
  return json({ complete: created.length + deduped, imported: created.length, deduped, invalid: 0 }, 200);
});
