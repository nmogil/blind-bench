/**
 * #263: map OTLP/HTTP Gen-AI spans → the `AgentRunTrace` interchange type, one
 * trace per OTel `traceId` (spans grouped and time-ordered → steps). Feeds
 * persistTrace → the M31 spine (trajectory review / blind / DPO export).
 *
 * Pure + defensive (no Convex ctx, no zod): OTLP JSON is partial/varied across
 * exporters. Reads the attribute shapes emitted by Cloudflare AI Gateway and the
 * OTel Gen-AI semantic conventions:
 *   - gen_ai.request.model / gen_ai.response.model, gen_ai.system|provider
 *   - gen_ai.usage.input_tokens / output_tokens / cost
 *   - gen_ai.prompt_json / gen_ai.completion_json  (CF: JSON string of messages)
 *   - gen_ai.prompt.{n}.role / .content            (OTel indexed)
 *   - gen_ai.prompt / gen_ai.completion            (plain string)
 * Bodies are optional: a span with no prompt/completion still produces a trace
 * (requestMissing/responseMissing counted), mirroring the gateway importer.
 */
import type { AgentRunTrace, AgentTraceStep, Message } from "./agentTrace";
import { redactValue } from "./agentTrace";

export interface OtelIngestSummary {
  traces: number;
  spans: number;
  ignoredSpans: number;
  steps: number;
  requestMissing: number;
  responseMissing: number;
  models: string[];
  invalid: boolean;
}

export interface OtelMapResult {
  traces: AgentRunTrace[];
  summary: OtelIngestSummary;
}

const rec = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length ? v : undefined);
const num = (v: unknown): number | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
};

/** Unwrap an OTLP AnyValue ({stringValue|intValue|doubleValue|boolValue|...}). */
function anyValue(v: unknown): unknown {
  const o = rec(v);
  if (!o) return v;
  if ("stringValue" in o) return o.stringValue;
  if ("intValue" in o) return num(o.intValue);
  if ("doubleValue" in o) return o.doubleValue;
  if ("boolValue" in o) return o.boolValue;
  if ("arrayValue" in o) return arr(rec(o.arrayValue)?.values).map(anyValue);
  if ("kvlistValue" in o) return flattenAttrs(rec(o.kvlistValue)?.values);
  return undefined;
}

/** OTLP attributes ([{key,value}]) → flat record with unwrapped values. */
function flattenAttrs(attributes: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of arr(attributes)) {
    const kv = rec(a);
    const key = str(kv?.key);
    if (key) out[key] = anyValue(kv?.value);
  }
  return out;
}

const toMessage = (m: unknown): Message | undefined => {
  const o = rec(m);
  if (!o) return undefined;
  const content = o.content;
  const contentStr =
    typeof content === "string" ? content : content == null ? "" : JSON.stringify(content);
  return { role: str(o.role) ?? "user", content: contentStr };
};

/** Parse the prompt side of a span into ordered messages. */
function extractPrompt(attrs: Record<string, unknown>): Message[] {
  const pj = str(attrs["gen_ai.prompt_json"]) ?? str(attrs["gen_ai.prompt.json"]);
  if (pj) {
    try {
      const parsed = JSON.parse(pj);
      const list = Array.isArray(parsed) ? parsed : rec(parsed)?.messages;
      const msgs = arr(list).map(toMessage).filter((m): m is Message => !!m);
      if (msgs.length) return msgs;
    } catch {
      /* fall through */
    }
  }
  const indexed: Message[] = [];
  for (let i = 0; i < 128; i++) {
    const role = attrs[`gen_ai.prompt.${i}.role`];
    const content = attrs[`gen_ai.prompt.${i}.content`];
    if (role === undefined && content === undefined) break;
    indexed.push({ role: str(role) ?? "user", content: str(content) ?? "" });
  }
  if (indexed.length) return indexed;
  const plain = str(attrs["gen_ai.prompt"]);
  return plain ? [{ role: "user", content: plain }] : [];
}

/** Parse the completion side → an assistant message + any tool calls. */
function extractCompletion(attrs: Record<string, unknown>): {
  message?: Message;
  toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>;
} {
  const toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
  const cj = str(attrs["gen_ai.completion_json"]) ?? str(attrs["gen_ai.completion.json"]);
  if (cj) {
    try {
      const parsed = JSON.parse(cj);
      const first = Array.isArray(parsed) ? rec(parsed[0]) : rec(parsed);
      const msgObj = first?.message ? rec(first.message) : first;
      for (const tc of arr(msgObj?.tool_calls)) {
        const t = rec(tc);
        const fn = rec(t?.function);
        let parsedArgs: Record<string, unknown> = {};
        try {
          parsedArgs = rec(JSON.parse(str(fn?.arguments) ?? "{}")) ?? {};
        } catch {
          parsedArgs = { raw: str(fn?.arguments) };
        }
        toolCalls.push({
          id: str(t?.id) ?? `tool-${toolCalls.length}`,
          name: str(fn?.name) ?? "unknown_tool",
          args: parsedArgs,
        });
      }
      const content = msgObj?.content;
      if (content != null && content !== "") {
        return {
          message: { role: str(msgObj?.role) ?? "assistant", content: typeof content === "string" ? content : JSON.stringify(content) },
          toolCalls,
        };
      }
      if (toolCalls.length) return { toolCalls };
    } catch {
      /* fall through */
    }
  }
  const plain = str(attrs["gen_ai.completion"]);
  return plain ? { message: { role: "assistant", content: plain }, toolCalls: [] } : { toolCalls: [] };
}

const spanTime = (span: Record<string, unknown>): number =>
  num(span.startTimeUnixNano) ?? num(span.start_time_unix_nano) ?? 0;

export function mapOtlpToTraces(payload: unknown): OtelMapResult {
  const root = rec(payload);
  const resourceSpans = arr(root?.resourceSpans);
  const summary: OtelIngestSummary = {
    traces: 0,
    spans: 0,
    ignoredSpans: 0,
    steps: 0,
    requestMissing: 0,
    responseMissing: 0,
    models: [],
    invalid: resourceSpans.length === 0,
  };

  // Group spans by traceId.
  const byTrace = new Map<string, Array<Record<string, unknown>>>();
  for (const rs of resourceSpans) {
    for (const ss of arr(rec(rs)?.scopeSpans)) {
      for (const s of arr(rec(ss)?.spans)) {
        const span = rec(s);
        if (!span) continue;
        const attrs = flattenAttrs(span.attributes);
        const isGenAiSpan = Object.keys(attrs).some((key) => key.startsWith("gen_ai."));
        if (!isGenAiSpan) {
          summary.ignoredSpans++;
          continue;
        }
        summary.spans++;
        const traceId = str(span.traceId) ?? str(span.trace_id) ?? `otlp-${summary.spans}`;
        (byTrace.get(traceId) ?? byTrace.set(traceId, []).get(traceId)!).push(span);
      }
    }
  }

  const models = new Set<string>();
  const traces: AgentRunTrace[] = [];

  for (const [traceId, spans] of byTrace) {
    spans.sort((a, b) => spanTime(a) - spanTime(b));
    const steps: AgentTraceStep[] = [];
    let harness = "otel";
    let model: string | undefined;
    let inTok = 0;
    let outTok = 0;
    let cost = 0;
    let sawRequest = false;
    let sawResponse = false;

    for (const span of spans) {
      const attrs = flattenAttrs(span.attributes);
      const m = str(attrs["gen_ai.request.model"]) ?? str(attrs["gen_ai.response.model"]);
      if (m) {
        model ??= m;
        models.add(m);
      }
      const sys = str(attrs["gen_ai.system"]) ?? str(attrs["gen_ai.provider"]) ?? str(attrs["gen_ai.model.provider"]);
      if (sys) harness = sys;
      inTok += num(attrs["gen_ai.usage.input_tokens"]) ?? 0;
      outTok += num(attrs["gen_ai.usage.output_tokens"]) ?? 0;
      cost += num(attrs["gen_ai.usage.cost"]) ?? 0;
      const ts = str(span.startTimeUnixNano);

      const prompt = extractPrompt(attrs);
      if (prompt.length) sawRequest = true;
      else summary.requestMissing++;
      for (const msg of prompt) {
        steps.push({ type: "message", index: steps.length, timestamp: ts, message: msg });
      }

      const { message, toolCalls } = extractCompletion(attrs);
      if (message || toolCalls.length) sawResponse = true;
      else summary.responseMissing++;
      if (message) {
        steps.push({ type: "message", index: steps.length, timestamp: ts, message });
      }
      for (const tc of toolCalls) {
        steps.push({
          type: "tool_call",
          index: steps.length,
          timestamp: ts,
          tool_call_id: tc.id,
          name: tc.name,
          args: tc.args,
          redacted_args: (redactValue(tc.args, "blind_view") as Record<string, unknown>) ?? {},
          privacy_class: JSON.stringify(redactValue(tc.args, "blind_view")).includes("[REDACTED]") ? "pii" : "internal",
        });
      }
    }

    summary.steps += steps.length;
    summary.traces++;
    const anyRedacted = steps.some((s) => JSON.stringify(s).includes("[REDACTED]"));
    traces.push({
      trace_id: `otlp-${traceId}`,
      source: "agent_harness",
      harness: { name: harness, sdk: "otlp" },
      product: harness,
      module: "otlp_ingest",
      model,
      run_id: traceId,
      source_ids: { otel_trace_id: traceId },
      messages: [],
      steps,
      usage: { total_tokens: inTok + outTok || undefined, cost_usd: cost || undefined },
      privacy: {
        class: anyRedacted ? "pii" : "internal",
        redaction_notes: anyRedacted ? ["sensitive tool fields redacted for blind/reviewer views"] : [],
      },
      metadata: { otel_trace_id: traceId, request_missing: !sawRequest, response_missing: !sawResponse },
    });
  }

  summary.models = [...models];
  summary.invalid = summary.traces === 0;
  return { traces, summary };
}
