/**
 * Shared, isomorphic core for normalized multi-step agent run traces.
 *
 * Runs unchanged in BOTH runtimes: the Vite/CLI/lab bundle AND the Convex
 * function bundle. To make that possible it has ZERO `zod` and ZERO `node:*`
 * imports — the two things the Convex bundle cannot tolerate (zod's
 * `toJSONSchema` evaluates at import in evalCase.ts; `node:crypto` is not in the
 * Convex runtime). `src/lib/evals/agentTrace.ts` re-exports this file for the
 * lab path; `convex/lib/agentTrace.ts` re-exports it for the Convex path — one
 * implementation, no drift. (#264, M31 Trajectory Spine.)
 *
 * The `import type` below is erased at compile — evalCase.ts (which pulls zod)
 * never enters any bundle through this module.
 */
import type { EvalCaseInput } from "./evalCase";

export type PrivacyClass = "public" | "internal" | "confidential" | "pii" | "phi";
export type PrivacyMode = "blind_view" | "reviewer_view" | "internal_view";

export interface Message {
  role: string;
  content: string;
}

export type AgentTraceStep =
  | { type: "message"; index: number; timestamp?: string; message: Message }
  | {
      type: "tool_call";
      index: number;
      timestamp?: string;
      tool_call_id: string;
      name: string;
      args: Record<string, unknown>;
      redacted_args: Record<string, unknown>;
      privacy_class: PrivacyClass;
    }
  | {
      type: "tool_result";
      index: number;
      timestamp?: string;
      tool_call_id: string;
      name?: string;
      result?: unknown;
      redacted_result?: unknown;
      privacy_class: PrivacyClass;
    }
  | {
      type: "state";
      index: number;
      timestamp?: string;
      label: string;
      snapshot: Record<string, unknown>;
      redacted_snapshot: Record<string, unknown>;
      privacy_class: PrivacyClass;
    }
  | {
      type: "policy_event";
      index: number;
      timestamp?: string;
      policy: string;
      action: string;
      reason?: string;
    };

export interface AgentRunTrace {
  trace_id: string;
  source: "agent_harness";
  harness: { name: string; version?: string; sdk?: string };
  product: string;
  module?: string;
  environment?: string;
  model?: string;
  run_id?: string;
  source_ids: Record<string, unknown>;
  messages: Message[];
  steps: AgentTraceStep[];
  final_answer?: string;
  usage: { cost_usd?: number; duration_ms?: number; total_tokens?: number };
  privacy: { class: PrivacyClass; redaction_notes: string[] };
  metadata: Record<string, unknown>;
}

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

// ponytail: non-crypto FNV-1a, 16 hex chars — trace_id fallback only (was
// sha256.slice(0,16)). Collisions are cosmetic; upgrade to a real digest only
// if trace_id ever becomes a security boundary.
const MASK64 = 0xffffffffffffffffn;
const hash = (v: unknown): string => {
  let h = 0xcbf29ce484222325n;
  const s = stableStringify(v);
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * 0x100000001b3n) & MASK64;
  }
  return h.toString(16).padStart(16, "0");
};

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

const asRedactedRecord = (value: unknown, mode: PrivacyMode): Record<string, unknown> =>
  (asRecord(redactValue(value, mode)) ?? {});

const privacyClassFor = (value: unknown): PrivacyClass =>
  SENSITIVE_KEY.test(stableStringify(value)) ? "pii" : "internal";

function normalizeStep(step: unknown, index: number, mode: PrivacyMode): AgentTraceStep {
  const s = asRecord(step) ?? {};
  const type = str(s.type ?? s.kind) ?? (s.tool_name || s.tool ? "tool_call" : "state");
  if (type === "message") {
    return {
      type: "message",
      index,
      timestamp: str(s.timestamp),
      message: { role: str(s.role) ?? "assistant", content: str(s.content) ?? "" },
    };
  }
  if (type === "tool_call") {
    const args = asRecord(s.args ?? s.arguments) ?? {};
    return {
      type: "tool_call",
      index,
      timestamp: str(s.timestamp),
      tool_call_id: str(s.tool_call_id ?? s.id) ?? `tool-${index}`,
      name: str(s.name ?? s.tool_name ?? s.tool) ?? "unknown_tool",
      args,
      redacted_args: asRedactedRecord(args, mode),
      privacy_class: privacyClassFor(args),
    };
  }
  if (type === "tool_result") {
    const result = s.result ?? s.output;
    return {
      type: "tool_result",
      index,
      timestamp: str(s.timestamp),
      tool_call_id: str(s.tool_call_id ?? s.id) ?? `tool-${index}`,
      name: str(s.name ?? s.tool_name ?? s.tool),
      result,
      redacted_result: redactValue(result, mode),
      privacy_class: privacyClassFor(result),
    };
  }
  if (type === "policy_event") {
    return {
      type: "policy_event",
      index,
      timestamp: str(s.timestamp),
      policy: str(s.policy) ?? "unknown_policy",
      action: str(s.action) ?? "unknown_action",
      reason: str(s.reason),
    };
  }
  const snapshot = asRecord(s.snapshot ?? s.state ?? s) ?? {};
  return {
    type: "state",
    index,
    timestamp: str(s.timestamp),
    label: str(s.label) ?? "state_snapshot",
    snapshot,
    redacted_snapshot: asRedactedRecord(snapshot, mode),
    privacy_class: privacyClassFor(snapshot),
  };
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
  return {
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
  };
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
