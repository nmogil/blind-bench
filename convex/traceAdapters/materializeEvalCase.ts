/**
 * Pure converter: a normalized Cloudflare AI Gateway trace -> the field set for
 * an `evalCases` row (see convex/schema.ts). Node-free and `_generated`-free so
 * it runs inside the Convex runtime and in plain vitest.
 *
 * Mirrors the field mapping in `src/lib/evals/cloudflareAiGateway.ts`
 * `convertTraceToEvalCase`, adapted to the Convex trace shape
 * (`NormalizedGatewayTrace`): `product` is read from the raw record's metadata
 * (the normalized trace doesn't carry it), and the request/response redaction
 * flags come straight off the trace. The importer supplies auth, storage, and
 * persistence; this module is only the pure mapping.
 */
import type { NormalizedGatewayTrace } from "./cloudflareAiGateway";

/**
 * Default deterministic scorers for a production-log case whose `expected` is
 * sparse (no curated must / must_not lists): the three HARD_FAIL safety scorers
 * — no_hallucinated_data, no_cross_context_leakage, read_only_no_destructive_tool
 * — which pass (never hard-fail) when their forbidden lists are empty, plus
 * tone_customer_fit as a standalone quality scorer that grades output tone
 * against built-in defaults. None fails vacuously on a normal captured output.
 */
export const DEFAULT_PRODUCTION_LOG_SCORER_IDS: readonly string[] = [
  "no_hallucinated_data",
  "no_cross_context_leakage",
  "read_only_no_destructive_tool",
  "tone_customer_fit",
];

/** Field set for an `evalCases` insert, minus projectId/traceImportId/createdById. */
export interface EvalCaseFields {
  source: "production_log";
  product: string;
  title: string;
  messages: { role: string; content: string }[];
  outputText?: string;
  scorerIds: string[];
  requestMissing: boolean;
  responseMissing: boolean;
  model?: string;
  provider?: string;
  timestamp?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  durationMs?: number;
}

// --- tiny readers (node-free, mirror the adapter's) --------------------------

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.length ? v : undefined;

const get = (obj: unknown, paths: string[]): unknown => {
  for (const path of paths) {
    let cur: unknown = obj;
    for (const key of path.split(".")) cur = asRecord(cur)?.[key];
    if (cur !== undefined && cur !== null) return cur;
  }
  return undefined;
};

/**
 * Read `product` from the raw source record's metadata. Matches the src
 * adapter's metadata resolution paths. Falls back to "unknown".
 */
export function readProduct(rawRecord: unknown): string {
  const metadata = asRecord(
    get(rawRecord, ["metadata", "request.metadata", "event.metadata"]),
  );
  return str(metadata?.product) ?? "unknown";
}

/**
 * Convert a normalized trace + its raw source record into `evalCases` fields.
 * `rawRecord` is the JSON-parsed source log — only its metadata is read (for
 * `product`); message/output content comes from the normalized trace.
 */
export function materializeEvalCase(
  trace: NormalizedGatewayTrace,
  rawRecord?: unknown,
): EvalCaseFields {
  const product = readProduct(rawRecord);
  return {
    source: "production_log",
    product,
    title: `${product} replay ${trace.sourceTraceId}`,
    messages: trace.messages.map((m) => ({ role: m.role, content: m.content })),
    outputText: trace.outputText,
    scorerIds: [...DEFAULT_PRODUCTION_LOG_SCORER_IDS],
    requestMissing: trace.requestMissing,
    responseMissing: trace.responseMissing,
    model: trace.model,
    provider: trace.provider,
    timestamp: trace.timestamp,
    inputTokens: trace.usage.inputTokens,
    outputTokens: trace.usage.outputTokens,
    costUsd: trace.costUsd,
    durationMs: trace.durationMs,
  };
}
