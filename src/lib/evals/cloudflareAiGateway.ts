/**
 * Cloudflare AI Gateway exported-log adapter.
 *
 * Supported source path for this MVP: local/exported JSONL records (Logpush/API export
 * snapshots). No network calls and no Convex/UI coupling.
 */
import { createHash } from "node:crypto";
import { z } from "zod/v4";
import type { EvalCaseInput } from "./evalCase";

const JsonRecord = z.record(z.string(), z.unknown());

export const CloudflareAiGatewayLog = JsonRecord;
export type CloudflareAiGatewayLog = z.infer<typeof CloudflareAiGatewayLog>;

export const NormalizedBlindBenchTrace = z.object({
  trace_id: z.string(),
  source: z.literal("cloudflare_ai_gateway"),
  source_ids: z.object({
    account_id: z.string().optional(),
    gateway_id: z.string().optional(),
    log_id: z.string().optional(),
    event_id: z.string().optional(),
  }),
  product: z.string().optional(),
  module: z.string().optional(),
  prompt_version: z.string().optional(),
  variant: z.string().optional(),
  release: z.string().optional(),
  environment: z.string().optional(),
  timestamp: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  status: z.string().optional(),
  request_type: z.string().optional(),
  messages: z.array(z.object({ role: z.string(), content: z.string() })).default([]),
  output_text: z.string().optional(),
  usage: z.object({
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    total_tokens: z.number().optional(),
  }),
  cost_usd: z.number().optional(),
  duration_ms: z.number().optional(),
  cached: z.boolean().optional(),
  dlp: z.object({ action: z.string().optional(), flagged: z.boolean().optional() }),
  human_feedback: z.object({ value: z.string().optional(), rating: z.number().optional() }),
  redaction: z.object({ request_missing: z.boolean(), response_missing: z.boolean(), notes: z.array(z.string()) }),
  metadata: JsonRecord,
  raw_field_paths: z.object({ request: z.string().optional(), response: z.string().optional() }),
});
export type NormalizedBlindBenchTrace = z.infer<typeof NormalizedBlindBenchTrace>;

export interface NormalizeOptions {
  defaultProduct?: string;
  defaultEnvironment?: string;
  metadataSidecar?: Record<string, Record<string, unknown>>;
}

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);

const get = (obj: unknown, paths: string[]): unknown => {
  for (const path of paths) {
    let cur: unknown = obj;
    for (const key of path.split(".")) cur = asRecord(cur)?.[key];
    if (cur !== undefined && cur !== null) return cur;
  }
  return undefined;
};

const getRecord = (obj: unknown, paths: string[]) => asRecord(get(obj, paths));
const getStr = (obj: unknown, paths: string[]) => str(get(obj, paths));
const getNum = (obj: unknown, paths: string[]) => num(get(obj, paths));
const getBool = (obj: unknown, paths: string[]) => bool(get(obj, paths));

const stableHash = (value: unknown): string =>
  createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 16);

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

function extractMessages(request: unknown): { messages: { role: string; content: string }[]; notes: string[] } {
  const notes: string[] = [];
  const req = asRecord(request);
  if (!req) return { messages: [], notes: ["request_missing_or_redacted"] };
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
  if (messages.length === 0) notes.push("request_has_no_messages");
  return { messages, notes };
}

function extractOutput(response: unknown): { text?: string; notes: string[] } {
  const notes: string[] = [];
  const res = asRecord(response);
  if (!res) return { notes: ["response_missing_or_redacted"] };
  const direct = str(res.output_text ?? res.text ?? res.content);
  if (direct) return { text: direct, notes };
  const choice0 = asRecord(asArray(res.choices)[0]);
  const msg = asRecord(choice0?.message);
  const text = str(msg?.content ?? choice0?.text);
  if (!text) notes.push("response_has_no_text");
  return { text, notes };
}

function sidecarKey(record: CloudflareAiGatewayLog): string | undefined {
  return getStr(record, ["log_id", "id", "event.id", "event_id", "cf.ray_id"]);
}

export function normalizeCloudflareAiGatewayLog(
  record: CloudflareAiGatewayLog,
  options: NormalizeOptions = {},
): NormalizedBlindBenchTrace {
  const request = get(record, ["request", "request_body", "payload.request", "event.request"]);
  const response = get(record, ["response", "response_body", "payload.response", "event.response"]);
  const logId = getStr(record, ["log_id", "id", "log.id"]);
  const eventId = getStr(record, ["event_id", "event.id", "cf.event_id"]);
  const accountId = getStr(record, ["account_id", "account.id"]);
  const gatewayId = getStr(record, ["gateway_id", "gateway.id"]);
  const metadata = {
    ...(getRecord(record, ["metadata", "request.metadata", "event.metadata"]) ?? {}),
    ...(sidecarKey(record) ? (options.metadataSidecar?.[sidecarKey(record)!] ?? {}) : {}),
  };
  const { messages, notes: requestNotes } = extractMessages(request);
  const { text: outputText, notes: responseNotes } = extractOutput(response);
  const seed = { accountId, gatewayId, logId, eventId, ts: getStr(record, ["timestamp", "created_at", "datetime"]), model: getStr(record, ["model", "request.model", "response.model"]), request_hash: stableHash(request ?? "missing") };

  return NormalizedBlindBenchTrace.parse({
    trace_id: `cf-aigw-${stableHash(seed)}`,
    source: "cloudflare_ai_gateway",
    source_ids: { account_id: accountId, gateway_id: gatewayId, log_id: logId, event_id: eventId },
    product: str(metadata.product) ?? options.defaultProduct,
    module: str(metadata.module),
    prompt_version: str(metadata.prompt_version),
    variant: str(metadata.variant),
    release: str(metadata.release),
    environment: str(metadata.environment) ?? options.defaultEnvironment,
    timestamp: getStr(record, ["timestamp", "created_at", "datetime"]),
    provider: getStr(record, ["provider", "request.provider", "response.provider"]),
    model: getStr(record, ["model", "request.model", "response.model"]),
    status: getStr(record, ["status", "response.status", "error.type"]),
    request_type: getStr(record, ["request_type", "type"]),
    messages,
    output_text: outputText,
    usage: {
      input_tokens: getNum(record, ["tokens_in", "usage.input_tokens", "usage.prompt_tokens"]),
      output_tokens: getNum(record, ["tokens_out", "usage.output_tokens", "usage.completion_tokens"]),
      total_tokens: getNum(record, ["tokens_total", "usage.total_tokens"]),
    },
    cost_usd: getNum(record, ["cost", "cost_usd", "usage.cost_usd"]),
    duration_ms: getNum(record, ["duration", "duration_ms", "latency_ms"]),
    cached: getBool(record, ["cached", "cache.cached"]),
    dlp: {
      action: getStr(record, ["dlp.action", "dlp_action"]),
      flagged: getBool(record, ["dlp.flagged", "dlp_flagged"]),
    },
    human_feedback: {
      value: getStr(record, ["feedback", "human_feedback.value", "feedback.value"]),
      rating: getNum(record, ["human_feedback.rating", "feedback.rating"]),
    },
    redaction: {
      request_missing: messages.length === 0,
      response_missing: outputText === undefined,
      notes: [...requestNotes, ...responseNotes],
    },
    metadata,
    raw_field_paths: {
      request: request === undefined ? undefined : "request|request_body|payload.request|event.request",
      response: response === undefined ? undefined : "response|response_body|payload.response|event.response",
    },
  });
}

export function parseCloudflareAiGatewayJsonl(
  text: string,
  options: NormalizeOptions = {},
): NormalizedBlindBenchTrace[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => normalizeCloudflareAiGatewayLog(CloudflareAiGatewayLog.parse(JSON.parse(line)), options));
}

export function toJsonl(rows: NormalizedBlindBenchTrace[]): string {
  return rows.map((r) => stableStringify(r)).join("\n") + (rows.length ? "\n" : "");
}

export function convertTraceToEvalCase(
  trace: NormalizedBlindBenchTrace,
  options: { suiteId?: string; title?: string; tags?: string[] } = {},
): EvalCaseInput {
  return {
    id: `case-${trace.trace_id}`,
    product: trace.product ?? "unknown",
    title: options.title ?? `${trace.product ?? "AI Gateway"} replay ${trace.trace_id}`,
    description: "Replay seed generated from a normalized Cloudflare AI Gateway trace.",
    source: "production_log",
    tags: ["cloudflare-ai-gateway", "replay-seed", ...(options.tags ?? [])],
    input: {
      messages: trace.messages,
      context: {
        trace_id: trace.trace_id,
        module: trace.module ?? null,
        prompt_version: trace.prompt_version ?? null,
        provider: trace.provider ?? null,
        model: trace.model ?? null,
      },
    },
    expected: {
      privacy_class: trace.redaction.request_missing ? "internal" : "confidential",
      must: trace.output_text ? ["Review candidate output against the original production output."] : [],
      data_policy: { retention: "customer_scoped_review_only" },
    },
    metadata: {
      suite_id: options.suiteId ?? "cloudflare-ai-gateway-import",
      trace_id: trace.trace_id,
      source_ids: trace.source_ids,
      output_text: trace.output_text,
      scorers: [],
    },
  };
}
