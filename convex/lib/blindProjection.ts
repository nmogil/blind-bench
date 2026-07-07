/**
 * #266 (M31.3): blind projection for agent traces — the boundary scrub applied
 * to whatever an evaluator-callable trace function is about to return.
 *
 * Heavy content redaction (tool args/results/snapshots/messages) is PRECOMPUTED
 * at ingest into each step's blind body blob (see agentTraceStorage.ts /
 * agentTrace.core.ts `redactValue`). This module handles the remaining DIRECT
 * IDENTIFIERS that fingerprint the model+harness combo and are cheap,
 * deterministic scalar transforms: tool names, tool-call ids, wall-clock
 * timestamps, and the parent's harness/model/provider/product/ids.
 *
 * Honesty (product requirement, from the strategy doc): this is BIAS REDUCTION,
 * not anonymity. A determined reviewer can still infer the harness from
 * reasoning style, error formats, and step cadence — we do not claim otherwise.
 * Statistical de-fingerprinting (timing jitter, style normalization) is a known,
 * un-built limitation (#266 out of scope).
 */

/** Product-facing tool aliases: hide the harness-specific name, keep meaning. */
export const TOOL_ALIASES: Record<string, string> = {
  Bash: "run_command",
  Read: "read_file",
  Write: "write_file",
  Edit: "edit_file",
  MultiEdit: "edit_file",
  NotebookEdit: "edit_notebook",
  Glob: "find_files",
  Grep: "search_files",
  LS: "list_dir",
  WebFetch: "fetch_url",
  WebSearch: "web_search",
  Task: "spawn_subagent",
  TodoWrite: "update_tasks",
};

// Short deterministic pseudonym for unknown tools — keeps distinct tools
// distinguishable (reviewability) without exposing the fingerprinting name.
const fnvShort = (s: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0").slice(0, 6);
};

export function aliasToolName(name: string | undefined): string | undefined {
  if (!name) return name;
  return TOOL_ALIASES[name] ?? `tool_${fnvShort(name)}`;
}

/** A single `listSteps` page item (shape from agentTraces.listSteps). */
export interface StepView {
  stepIndex: number;
  kind: string;
  role?: string;
  toolName?: string;
  toolCallId?: string;
  label?: string;
  policy?: string;
  action?: string;
  reason?: string;
  timestamp?: string;
  privacyClass?: string;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  bodyUrl?: string | null;
}

/**
 * Project one step for a blind principal: alias the tool name, replace the
 * provider tool-call id with an opaque per-trace positional token, and drop the
 * absolute timestamp (a direct timing identifier). The body is already the
 * blind blob (chosen upstream); `privacyClass` is kept so the UI can badge a
 * sensitive step.
 */
export function blindStepView(item: StepView): StepView {
  return {
    ...item,
    toolName: aliasToolName(item.toolName),
    toolCallId: item.toolCallId != null ? `call-${item.stepIndex}` : undefined,
    timestamp: undefined,
  };
}

export interface TraceView {
  _id: string;
  traceId?: string;
  product?: string;
  module?: string;
  environment?: string;
  status: string;
  stepCount: number;
  privacyClass: string;
  model?: string;
  harnessName?: string;
  harnessVersion?: string;
  usage: { costUsd?: number; durationMs?: number; totalTokens?: number };
  finalAnswerUrl: string | null;
}

/**
 * Project the parent metadata for a blind principal: strip every direct
 * identifier (harness, model, provider, real trace/session id, product,
 * environment). The Convex `_id` stays as the opaque handle the client uses to
 * page steps; usage rollups stay (aggregate numbers don't name the combo).
 */
export function blindTraceView(trace: TraceView): TraceView {
  return {
    _id: trace._id,
    traceId: undefined,
    product: undefined,
    module: undefined,
    environment: undefined,
    status: trace.status,
    stepCount: trace.stepCount,
    privacyClass: trace.privacyClass,
    model: undefined,
    harnessName: undefined,
    harnessVersion: undefined,
    usage: trace.usage,
    finalAnswerUrl: trace.finalAnswerUrl,
  };
}
