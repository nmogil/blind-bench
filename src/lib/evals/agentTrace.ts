/**
 * Normalized multi-step agent run traces for agent-harness style harnesses.
 *
 * This is capture/normalization only: no sandboxed agent execution and no provider
 * SDK dependency. The concrete first ingest path is a permissive "Jeeves/Clog run"
 * JSON export shape with messages, tool calls/results, policy events, and final answer.
 */
import { createHash } from "node:crypto";
import { z } from "zod/v4";
import type { EvalCaseInput } from "./evalCase";

const JsonRecord = z.record(z.string(), z.unknown());
const Message = z.object({ role: z.string(), content: z.string() });

export const PrivacyMode = z.enum(["blind_view", "reviewer_view", "internal_view"]);
export type PrivacyMode = z.infer<typeof PrivacyMode>;

export const AgentTraceStep = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("message"),
    index: z.number().int().nonnegative(),
    timestamp: z.string().optional(),
    message: Message,
  }),
  z.object({
    type: z.literal("tool_call"),
    index: z.number().int().nonnegative(),
    timestamp: z.string().optional(),
    tool_call_id: z.string(),
    name: z.string(),
    args: JsonRecord.default({}),
    redacted_args: JsonRecord.default({}),
    privacy_class: z.enum(["public", "internal", "confidential", "pii", "phi"]),
  }),
  z.object({
    type: z.literal("tool_result"),
    index: z.number().int().nonnegative(),
    timestamp: z.string().optional(),
    tool_call_id: z.string(),
    name: z.string().optional(),
    result: z.unknown().optional(),
    redacted_result: z.unknown().optional(),
    privacy_class: z.enum(["public", "internal", "confidential", "pii", "phi"]),
  }),
  z.object({
    type: z.literal("state"),
    index: z.number().int().nonnegative(),
    timestamp: z.string().optional(),
    label: z.string(),
    snapshot: JsonRecord.default({}),
    redacted_snapshot: JsonRecord.default({}),
    privacy_class: z.enum(["public", "internal", "confidential", "pii", "phi"]),
  }),
  z.object({
    type: z.literal("policy_event"),
    index: z.number().int().nonnegative(),
    timestamp: z.string().optional(),
    policy: z.string(),
    action: z.string(),
    reason: z.string().optional(),
  }),
]);
export type AgentTraceStep = z.infer<typeof AgentTraceStep>;

export const AgentRunTrace = z.object({
  trace_id: z.string(),
  source: z.literal("agent_harness"),
  harness: z.object({ name: z.string(), version: z.string().optional(), sdk: z.string().optional() }),
  product: z.string(),
  module: z.string().optional(),
  environment: z.string().optional(),
  model: z.string().optional(),
  run_id: z.string().optional(),
  source_ids: JsonRecord.default({}),
  messages: z.array(Message).default([]),
  steps: z.array(AgentTraceStep),
  final_answer: z.string().optional(),
  usage: z.object({ cost_usd: z.number().optional(), duration_ms: z.number().optional(), total_tokens: z.number().optional() }),
  privacy: z.object({
    class: z.enum(["public", "internal", "confidential", "pii", "phi"]),
    redaction_notes: z.array(z.string()).default([]),
  }),
  metadata: JsonRecord.default({}),
});
export type AgentRunTrace = z.infer<typeof AgentRunTrace>;

export interface JeevesClogRunExport {
  run_id?: string;
  trace_id?: string;
  product?: string;
  module?: string;
  environment?: string;
  harness?: { name?: string; version?: string; sdk?: string };
  model?: string;
  messages?: Array<{ role?: string; content?: string; timestamp?: string }>;
  steps?: unknown[];
  final_answer?: string;
  usage?: { cost_usd?: number; duration_ms?: number; total_tokens?: number };
  metadata?: Record<string, unknown>;
}

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const stableStringify = (v: unknown): string => {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
};
const hash = (v: unknown) => createHash("sha256").update(stableStringify(v)).digest("hex").slice(0, 16);

const SENSITIVE_KEY = /(ssn|social|phone|email|address|token|secret|password|account_number|card|dob)/i;
export function redactValue(value: unknown, mode: PrivacyMode = "blind_view"): unknown {
  if (mode === "internal_view") return value;
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((x) => redactValue(x, mode));
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(key)) out[key] = "[REDACTED]";
    else out[key] = redactValue(val, mode);
  }
  return out;
}

const privacyClassFor = (value: unknown): AgentRunTrace["privacy"]["class"] =>
  SENSITIVE_KEY.test(stableStringify(value)) ? "pii" : "internal";

function normalizeStep(step: unknown, index: number, mode: PrivacyMode): AgentTraceStep {
  const s = asRecord(step) ?? {};
  const type = str(s.type ?? s.kind) ?? (s.tool_name || s.tool ? "tool_call" : "state");
  if (type === "message") {
    return AgentTraceStep.parse({
      type: "message",
      index,
      timestamp: str(s.timestamp),
      message: { role: str(s.role) ?? "assistant", content: str(s.content) ?? "" },
    });
  }
  if (type === "tool_call") {
    const args = asRecord(s.args ?? s.arguments) ?? {};
    return AgentTraceStep.parse({
      type: "tool_call",
      index,
      timestamp: str(s.timestamp),
      tool_call_id: str(s.tool_call_id ?? s.id) ?? `tool-${index}`,
      name: str(s.name ?? s.tool_name ?? s.tool) ?? "unknown_tool",
      args,
      redacted_args: redactValue(args, mode),
      privacy_class: privacyClassFor(args),
    });
  }
  if (type === "tool_result") {
    const result = s.result ?? s.output;
    return AgentTraceStep.parse({
      type: "tool_result",
      index,
      timestamp: str(s.timestamp),
      tool_call_id: str(s.tool_call_id ?? s.id) ?? `tool-${index}`,
      name: str(s.name ?? s.tool_name ?? s.tool),
      result,
      redacted_result: redactValue(result, mode),
      privacy_class: privacyClassFor(result),
    });
  }
  if (type === "policy_event") {
    return AgentTraceStep.parse({
      type: "policy_event",
      index,
      timestamp: str(s.timestamp),
      policy: str(s.policy) ?? "unknown_policy",
      action: str(s.action) ?? "unknown_action",
      reason: str(s.reason),
    });
  }
  const snapshot = asRecord(s.snapshot ?? s.state ?? s) ?? {};
  return AgentTraceStep.parse({
    type: "state",
    index,
    timestamp: str(s.timestamp),
    label: str(s.label) ?? "state_snapshot",
    snapshot,
    redacted_snapshot: redactValue(snapshot, mode),
    privacy_class: privacyClassFor(snapshot),
  });
}

export function normalizeJeevesClogRun(
  raw: JeevesClogRunExport,
  options: { privacyMode?: PrivacyMode; defaultProduct?: string } = {},
): AgentRunTrace {
  const privacyMode = options.privacyMode ?? "blind_view";
  const messages = (raw.messages ?? []).flatMap((m) =>
    m.role && m.content ? [{ role: m.role, content: m.content }] : [],
  );
  const steps = (raw.steps ?? []).map((s, i) => normalizeStep(s, i, privacyMode));
  const traceSeed = { run_id: raw.run_id, trace_id: raw.trace_id, harness: raw.harness, model: raw.model, messages };
  const redactionNotes = steps.some((s) => stableStringify(s).includes("[REDACTED]"))
    ? ["sensitive tool/state fields redacted for blind/reviewer views"]
    : [];
  return AgentRunTrace.parse({
    trace_id: raw.trace_id ?? `agent-${hash(traceSeed)}`,
    source: "agent_harness",
    harness: { name: raw.harness?.name ?? "jeeves_clog", version: raw.harness?.version, sdk: raw.harness?.sdk ?? "clog" },
    product: raw.product ?? options.defaultProduct ?? "jeeves",
    module: raw.module ?? "systems_agent",
    environment: raw.environment,
    model: raw.model,
    run_id: raw.run_id,
    source_ids: { run_id: raw.run_id, trace_id: raw.trace_id },
    messages,
    steps,
    final_answer: raw.final_answer,
    usage: { cost_usd: num(raw.usage?.cost_usd), duration_ms: num(raw.usage?.duration_ms), total_tokens: num(raw.usage?.total_tokens) },
    privacy: { class: steps.some((s) => "privacy_class" in s && s.privacy_class === "pii") ? "pii" : "internal", redaction_notes: redactionNotes },
    metadata: raw.metadata ?? {},
  });
}

export interface ScorerVisibleAgentRun {
  trace_id: string;
  harness: AgentRunTrace["harness"];
  product: string;
  model?: string;
  messages: AgentRunTrace["messages"];
  tool_calls: Array<{ tool_call_id: string; name: string; args: unknown; index: number }>;
  tool_results: Array<{ tool_call_id: string; name?: string; result: unknown; index: number }>;
  policy_events: Array<{ policy: string; action: string; reason?: string; index: number }>;
  final_answer?: string;
}

export function toScorerVisibleAgentRun(
  trace: AgentRunTrace,
  mode: PrivacyMode = "blind_view",
): ScorerVisibleAgentRun {
  const redact = (v: unknown) => redactValue(v, mode);
  return {
    trace_id: trace.trace_id,
    harness: trace.harness,
    product: trace.product,
    model: trace.model,
    messages: trace.messages,
    tool_calls: trace.steps.flatMap((s) =>
      s.type === "tool_call" ? [{ tool_call_id: s.tool_call_id, name: s.name, args: mode === "internal_view" ? s.args : s.redacted_args, index: s.index }] : [],
    ),
    tool_results: trace.steps.flatMap((s) =>
      s.type === "tool_result" ? [{ tool_call_id: s.tool_call_id, name: s.name, result: mode === "internal_view" ? s.result : s.redacted_result, index: s.index }] : [],
    ),
    policy_events: trace.steps.flatMap((s) =>
      s.type === "policy_event" ? [{ policy: s.policy, action: s.action, reason: s.reason, index: s.index }] : [],
    ),
    final_answer: trace.final_answer ? String(redact(trace.final_answer)) : undefined,
  };
}

export function agentTraceToEvalCase(trace: AgentRunTrace): EvalCaseInput {
  const visible = toScorerVisibleAgentRun(trace, "blind_view");
  return {
    id: `case-${trace.trace_id}`,
    product: trace.product,
    title: `${trace.harness.name} replay ${trace.run_id ?? trace.trace_id}`,
    source: "replay",
    tags: ["agent-harness", trace.harness.name, trace.module ?? "agent"],
    input: {
      messages: trace.messages,
      context: {
        trace_id: trace.trace_id,
        harness: trace.harness,
        tool_calls: visible.tool_calls,
        policy_events: visible.policy_events,
      },
    },
    expected: { privacy_class: trace.privacy.class, data_policy: { retention: "customer_scoped_review_only" } },
    metadata: { trace_id: trace.trace_id, run_id: trace.run_id, final_answer: visible.final_answer, scorers: [] },
  };
}
