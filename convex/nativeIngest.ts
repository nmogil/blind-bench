/**
 * Native JSON trace ingest. A public endpoint (mounted in http.ts) authenticated
 * by the same per-project ingest token as the OTLP path (#263) — Blind Bench never
 * holds the customer's gateway credential (BYOK). Unlike OTLP, this accepts Blind
 * Bench's own versioned public schema (`eval-record` v1: one record = one model
 * interaction) directly, so a customer's harness can emit it with no OTel envelope.
 *
 * Records normalize into the same `AgentRunTrace` spine (via normalizeEvalRecordV1)
 * and persist through the shared token-authed storeTraceSteps path. Body accepts a
 * bare array, `{records:[]}`, or a single object. Dedup by (source "native",
 * sourceTraceId); a bad record is counted (`invalid`) and skipped, never failing
 * the whole batch. Counts-only response (never echoes trace content).
 */
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { MAX_BYTES, json, readToken } from "./otlpIngest";
import { normalizeEvalRecordV1 } from "./lib/agentTrace";
import { storeTraceSteps } from "./agentTraces";

// ponytail: batch caps bound per-request work (storage writes) against a token
// holder POSTing a huge/amplified body; raise if real batches legitimately exceed.
const MAX_RECORDS = 1000;
const MAX_TOTAL_STEPS = 10_000;

export const nativeIngestHandler = httpAction(async (ctx, req) => {
  const token = readToken(req);
  if (!token) return json({ error: "Missing ingest token" }, 401);
  const resolved = await ctx.runQuery(internal.otlpIngest.resolveIngestToken, { token });
  if (!resolved) return json({ error: "Invalid or revoked ingest token" }, 401);
  if (!resolved.scopes.includes("traces:write")) {
    return json({ error: "Token lacks traces:write scope" }, 403);
  }

  const body = await req.text();
  // UTF-8 byte length, not JS string length (which undercounts multibyte content).
  if (new TextEncoder().encode(body).length > MAX_BYTES) {
    return json({ error: "Payload too large" }, 413);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const asRec = (v: unknown): Record<string, unknown> | undefined =>
    v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  const envelope = asRec(payload);
  const records: unknown[] = Array.isArray(payload)
    ? payload
    : Array.isArray(envelope?.records)
      ? (envelope!.records as unknown[])
      : [payload];
  if (records.length > MAX_RECORDS) {
    return json({ error: `Too many records (max ${MAX_RECORDS} per request)` }, 413);
  }

  // Persist the raw request once for provenance / re-parse; link to new imports.
  let rawStorageId: Id<"_storage"> | undefined;
  try {
    rawStorageId = await ctx.storage.store(new Blob([body], { type: "application/json" }));
  } catch {
    rawStorageId = undefined;
  }

  let traces = 0;
  let imported = 0;
  let deduped = 0;
  let steps = 0;
  let responseMissing = 0;
  let invalid = 0;
  let truncated = false;
  // Count of new import rows created; each references rawStorageId, so the blob
  // is orphaned (safe to delete) only when this stays 0.
  let importRowsCreated = 0;
  // `requestMissing` cannot occur: normalizeEvalRecordV1 rejects an empty
  // input.messages, so such records are counted as `invalid` instead.
  const requestMissing = 0;

  for (const record of records) {
    let trace;
    try {
      trace = normalizeEvalRecordV1(record);
    } catch {
      invalid++;
      continue;
    }
    // Bound total storage writes per request regardless of record count.
    if (steps + trace.steps.length > MAX_TOTAL_STEPS) {
      truncated = true;
      break;
    }
    traces++;

    const sourceTraceId = trace.run_id ?? trace.trace_id;
    const imp = await ctx.runMutation(internal.otlpIngest.insertIngestImport, {
      projectId: resolved.projectId,
      importedById: resolved.createdById,
      source: "native",
      sourceTraceId,
      rawPayloadStorageId: rawStorageId,
    });
    if (imp.deduped) {
      deduped++;
      continue;
    }
    importRowsCreated++;
    const parent = await ctx.runMutation(internal.agentTraces.insertTraceParentForIngest, {
      projectId: resolved.projectId,
      importedById: resolved.createdById,
      traceImportId: imp.importId,
      traceId: trace.trace_id,
      harnessName: trace.harness.name,
      harnessVersion: trace.harness.version,
      harnessSdk: trace.harness.sdk,
      product: trace.product,
      module: trace.module,
      environment: trace.environment,
      model: trace.model,
      runId: trace.run_id,
      stepCount: trace.steps.length,
      privacyClass: trace.privacy.class,
      costUsd: trace.usage.cost_usd,
      durationMs: trace.usage.duration_ms,
      totalTokens: trace.usage.total_tokens,
    });
    if (parent.deduped) {
      deduped++;
      continue;
    }
    await storeTraceSteps(ctx, parent.agentTraceId, trace);
    steps += trace.steps.length;
    imported++;
    // Count only records actually imported (docs define responseMissing that way).
    if (trace.final_answer === undefined) responseMissing++;
  }

  // Drop the raw-body blob if it ended up referenced by no new import row.
  if (importRowsCreated === 0 && rawStorageId) {
    try {
      await ctx.storage.delete(rawStorageId);
    } catch {
      /* best-effort cleanup */
    }
  }

  await ctx.runMutation(internal.otlpIngest.touchIngestToken, { token });
  return json(
    { traces, imported, deduped, steps, requestMissing, responseMissing, invalid, truncated },
    200,
  );
});
