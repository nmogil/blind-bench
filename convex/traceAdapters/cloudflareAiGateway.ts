/**
 * Convex-safe Cloudflare AI Gateway JSONL parser.
 *
 * Mirrors the field-mapping logic in `src/lib/evals/cloudflareAiGateway.ts`,
 * but with NO `node:crypto` and NO `zod` so it runs inside the Convex query/
 * mutation runtime — and in plain vitest without any `_generated` files. Pure
 * functions only; the importer in `convex/gatewayImport.ts` handles auth,
 * dedup persistence, and limits.
 *
 * Safety posture: parse errors are reported as line numbers, never raw
 * content. Each trace carries `rawPayloadJson` (a deterministic stringify of
 * the source record) so the importer can persist it to access-controlled
 * Convex storage for later re-parse/materialization — but message/output
 * fields and the summary never surface that content back to the UI.
 */

export interface GatewayLimits {
  /** Maximum non-blank lines parsed per import; extras are dropped + flagged. */
  maxLines: number;
  /** Maximum payload size guard, applied by the importer before parsing. */
  maxBytes: number;
}

export const DEFAULT_LIMITS: GatewayLimits = {
  maxLines: 5000,
  maxBytes: 8 * 1024 * 1024,
};

/** Number of invalid line numbers surfaced in a summary (the rest are counted). */
export const MAX_REPORTED_INVALID_LINES = 50;

export interface NormalizedGatewayTrace {
  /** Stable dedup key: the gateway's own log/event id, or a content hash. */
  sourceTraceId: string;
  messages: { role: string; content: string }[];
  outputText?: string;
  model?: string;
  provider?: string;
  timestamp?: string;
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  costUsd?: number;
  durationMs?: number;
  /** Request was redacted/missing/empty (no usable input messages). */
  requestMissing: boolean;
  /** Response was redacted/missing/empty (no usable output text). */
  responseMissing: boolean;
  /**
   * Deterministic stringify of the source record. The importer persists this
   * to access-controlled Convex storage (`rawPayloadStorageId`) so adapter
   * improvements can re-parse without re-export. Never rendered in the UI nor
   * returned in summaries.
   */
  rawPayloadJson: string;
}

export interface ParseResult {
  traces: NormalizedGatewayTrace[];
  /** 1-based line numbers that failed JSON parse or normalization. */
  invalidLines: number[];
  /** True when the import hit `maxLines` and stopped early. */
  truncated: boolean;
}

// ---- tiny readers (ported, zod-free) -----------------------------------

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.length ? v : undefined;
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

const get = (obj: unknown, paths: string[]): unknown => {
  for (const path of paths) {
    let cur: unknown = obj;
    for (const key of path.split(".")) cur = asRecord(cur)?.[key];
    if (cur !== undefined && cur !== null) return cur;
  }
  return undefined;
};
const getStr = (obj: unknown, paths: string[]) => str(get(obj, paths));
const getNum = (obj: unknown, paths: string[]) => num(get(obj, paths));

// FNV-1a is enough for a dedup fallback id — not a security hash.
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

function extractMessages(request: unknown): { role: string; content: string }[] {
  const req = asRecord(request);
  if (!req) return [];
  const input = asRecord(req.input);
  const rawMessages = asArray(req.messages ?? input?.messages);
  const messages = rawMessages.flatMap((m) => {
    const rec = asRecord(m);
    const role = str(rec?.role);
    const content = str(rec?.content);
    return role && content ? [{ role, content }] : [];
  });
  if (messages.length === 0) {
    const prompt = str(req.prompt ?? req.input);
    if (prompt) messages.push({ role: "user", content: prompt });
  }
  return messages;
}

function extractOutput(response: unknown): string | undefined {
  const res = asRecord(response);
  if (!res) return undefined;
  const direct = str(res.output_text ?? res.text ?? res.content);
  if (direct) return direct;
  const choice0 = asRecord(asArray(res.choices)[0]);
  const msg = asRecord(choice0?.message);
  return str(msg?.content ?? choice0?.text);
}

/**
 * Normalize one parsed Gateway log object. Throws only on a non-object input
 * (caller already guards), so it is safe to call per line.
 */
export function normalizeGatewayLog(record: unknown): NormalizedGatewayTrace {
  const rec = asRecord(record);
  if (!rec) throw new Error("not an object");

  const request = get(rec, [
    "request",
    "request_body",
    "payload.request",
    "event.request",
  ]);
  const response = get(rec, [
    "response",
    "response_body",
    "payload.response",
    "event.response",
  ]);

  const messages = extractMessages(request);
  const outputText = extractOutput(response);
  const timestamp = getStr(rec, ["timestamp", "created_at", "datetime"]);
  const model = getStr(rec, ["model", "request.model", "response.model"]);
  const provider = getStr(rec, [
    "provider",
    "request.provider",
    "response.provider",
  ]);

  const explicitId = getStr(rec, [
    "log_id",
    "id",
    "log.id",
    "event_id",
    "event.id",
    "cf.ray_id",
    "ray_id",
  ]);
  const seed = {
    account: getStr(rec, ["account_id", "account.id"]),
    gateway: getStr(rec, ["gateway_id", "gateway.id"]),
    ts: timestamp,
    model,
    request_hash: fnv1a(stableStringify(request ?? "missing")),
  };
  const sourceTraceId = explicitId ?? `cf-aigw-${fnv1a(stableStringify(seed))}`;

  return {
    sourceTraceId,
    messages,
    outputText,
    model,
    provider,
    timestamp,
    usage: {
      inputTokens: getNum(rec, [
        "tokens_in",
        "usage.input_tokens",
        "usage.prompt_tokens",
      ]),
      outputTokens: getNum(rec, [
        "tokens_out",
        "usage.output_tokens",
        "usage.completion_tokens",
      ]),
      totalTokens: getNum(rec, ["tokens_total", "usage.total_tokens"]),
    },
    costUsd: getNum(rec, ["cost", "cost_usd", "usage.cost_usd"]),
    durationMs: getNum(rec, ["duration", "duration_ms", "latency_ms"]),
    requestMissing: messages.length === 0,
    responseMissing: outputText === undefined,
    rawPayloadJson: stableStringify(rec),
  };
}

/**
 * Parse exported Gateway JSONL. Blank lines are skipped; malformed lines are
 * counted by line number, never by content. Stops at `maxLines`.
 */
export function parseGatewayJsonl(
  text: string,
  limits: GatewayLimits = DEFAULT_LIMITS,
): ParseResult {
  const traces: NormalizedGatewayTrace[] = [];
  const invalidLines: number[] = [];
  const lines = text.split(/\r?\n/);
  let processed = 0;
  let truncated = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    if (processed >= limits.maxLines) {
      truncated = true;
      break;
    }
    processed++;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      invalidLines.push(i + 1);
      continue;
    }
    try {
      traces.push(normalizeGatewayLog(obj));
    } catch {
      invalidLines.push(i + 1);
    }
  }

  return { traces, invalidLines, truncated };
}

export interface TraceAggregate {
  redactedRequest: number;
  redactedResponse: number;
  models: string[];
  providers: string[];
  earliest?: string;
  latest?: string;
}

/** Management-safe rollup — counts, model/provider names, time bounds only. */
export function summarizeTraces(
  traces: NormalizedGatewayTrace[],
): TraceAggregate {
  const models = new Set<string>();
  const providers = new Set<string>();
  let earliest: string | undefined;
  let latest: string | undefined;
  let redactedRequest = 0;
  let redactedResponse = 0;

  for (const t of traces) {
    if (t.model) models.add(t.model);
    if (t.provider) providers.add(t.provider);
    if (t.requestMissing) redactedRequest++;
    if (t.responseMissing) redactedResponse++;
    if (t.timestamp) {
      if (earliest === undefined || t.timestamp < earliest) earliest = t.timestamp;
      if (latest === undefined || t.timestamp > latest) latest = t.timestamp;
    }
  }

  return {
    redactedRequest,
    redactedResponse,
    models: [...models].sort(),
    providers: [...providers].sort(),
    earliest,
    latest,
  };
}
