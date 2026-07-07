/**
 * #263: OTLP/HTTP Gen-AI trace ingest. A public endpoint (mounted in http.ts)
 * authenticated by a per-project ingest token we issue — Blind Bench never holds
 * the customer's gateway credential; the customer configures our URL + token in
 * their gateway (BYOK). Spans are grouped by trace_id into AgentRunTraces
 * (lib/otelGenAI) and persisted through the M31 spine via the shared, token-authed
 * storeTraceSteps path. Body-optional, dedup by (source "otlp", sourceTraceId),
 * counts-only response (never echoes trace content).
 */
import { v } from "convex/values";
import { httpAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { mapOtlpToTraces } from "./lib/otelGenAI";
import { storeTraceSteps } from "./agentTraces";
import type { AgentRunTrace } from "./lib/agentTrace";

const MAX_BYTES = 8 * 1024 * 1024;

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const readToken = (req: Request): string | undefined => {
  const auth = req.headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return req.headers.get("x-blindbench-ingest-token")?.trim() || undefined;
};

export const resolveIngestToken = internalQuery({
  args: { token: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{ projectId: Id<"projects">; createdById: Id<"users"> } | null> => {
    const row = await ctx.db
      .query("ingestTokens")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .unique();
    if (!row || row.revokedAt !== undefined) return null;
    return { projectId: row.projectId, createdById: row.createdById };
  },
});

export const touchIngestToken = internalMutation({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("ingestTokens")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .unique();
    if (row) await ctx.db.patch(row._id, { lastUsedAt: Date.now() });
  },
});

/** Dedup + insert an otlp traceImport for provenance/raw retention. */
export const insertOtlpImport = internalMutation({
  args: {
    projectId: v.id("projects"),
    importedById: v.id("users"),
    sourceTraceId: v.string(),
    rawPayloadStorageId: v.optional(v.id("_storage")),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ importId: Id<"traceImports">; deduped: boolean }> => {
    const existing = await ctx.db
      .query("traceImports")
      .withIndex("by_source_trace", (q) =>
        q.eq("source", "otlp").eq("sourceTraceId", args.sourceTraceId),
      )
      .filter((q) => q.eq(q.field("projectId"), args.projectId))
      .first();
    if (existing) return { importId: existing._id, deduped: true };
    const importId = await ctx.db.insert("traceImports", {
      projectId: args.projectId,
      source: "otlp",
      sourceTraceId: args.sourceTraceId,
      importedById: args.importedById,
      rawPayloadStorageId: args.rawPayloadStorageId,
    });
    return { importId, deduped: false };
  },
});

export const otlpIngestHandler = httpAction(async (ctx, req) => {
  const token = readToken(req);
  if (!token) return json({ error: "Missing ingest token" }, 401);
  const resolved = await ctx.runQuery(internal.otlpIngest.resolveIngestToken, { token });
  if (!resolved) return json({ error: "Invalid or revoked ingest token" }, 401);

  const body = await req.text();
  if (body.length > MAX_BYTES) return json({ error: "Payload too large" }, 413);
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const { traces, summary } = mapOtlpToTraces(payload);

  // Persist the raw request once for provenance / re-parse; link to new imports.
  let rawStorageId: Id<"_storage"> | undefined;
  try {
    rawStorageId = await ctx.storage.store(new Blob([body], { type: "application/json" }));
  } catch {
    rawStorageId = undefined;
  }

  let imported = 0;
  let deduped = 0;
  for (const trace of traces as AgentRunTrace[]) {
    const sourceTraceId = trace.run_id ?? trace.trace_id;
    const imp = await ctx.runMutation(internal.otlpIngest.insertOtlpImport, {
      projectId: resolved.projectId,
      importedById: resolved.createdById,
      sourceTraceId,
      rawPayloadStorageId: rawStorageId,
    });
    if (imp.deduped) {
      deduped++;
      continue;
    }
    const parent = await ctx.runMutation(internal.agentTraces.insertTraceParentForIngest, {
      projectId: resolved.projectId,
      importedById: resolved.createdById,
      traceImportId: imp.importId,
      traceId: trace.trace_id,
      harnessName: trace.harness.name,
      harnessSdk: trace.harness.sdk,
      product: trace.product,
      module: trace.module,
      model: trace.model,
      runId: trace.run_id,
      stepCount: trace.steps.length,
      privacyClass: trace.privacy.class,
      costUsd: trace.usage.cost_usd,
      totalTokens: trace.usage.total_tokens,
    });
    if (parent.deduped) {
      deduped++;
      continue;
    }
    await storeTraceSteps(ctx, parent.agentTraceId, trace);
    imported++;
  }

  await ctx.runMutation(internal.otlpIngest.touchIngestToken, { token });
  return json(
    {
      traces: summary.traces,
      imported,
      deduped,
      steps: summary.steps,
      requestMissing: summary.requestMissing,
      responseMissing: summary.responseMissing,
    },
    200,
  );
});
