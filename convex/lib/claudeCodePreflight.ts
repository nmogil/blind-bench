import type { AgentRunTrace } from "./agentTrace";
import { parseClaudeCodeSession, type ClaudeCodeSummary } from "./claudeCodeTrace";

export type ClaudeCodePreflightStatus = "ready" | "blocked";

export interface ClaudeCodePreflightSummary {
  status: ClaudeCodePreflightStatus;
  trace_ref: string;
  session_ref?: string;
  events: number;
  steps: number;
  invalid: number;
  invalid_lines: number[];
  truncated: boolean;
  over_size: boolean;
  input_bytes: number;
  dropped_meta: number;
  compactions: number;
  merged_messages: number;
  models: string[];
  earliest?: string;
  latest?: string;
  privacy_class: string;
  redaction_detected: boolean;
  step_kind_counts: Record<string, number>;
  caveats: string[];
}

const MAX_INVALID_LINES = 20;
export const CLAUDE_CODE_IMPORT_MAX_BYTES = 8 * 1024 * 1024;

function safeRef(value: string | undefined, prefix: string): string | undefined {
  if (!value) return undefined;
  const cleaned = value.replace(/^cc-/, "");
  if (cleaned.length <= 8) return `${prefix}-${cleaned}`;
  return `${prefix}-…${cleaned.slice(-8)}`;
}

function stepKindCounts(trace: AgentRunTrace): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const step of trace.steps) {
    counts[step.type] = (counts[step.type] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function redactionDetected(trace: AgentRunTrace): boolean {
  return trace.privacy.class !== "internal" || JSON.stringify(trace.steps).includes("[REDACTED]");
}

function caveatsFor(summary: ClaudeCodeSummary, trace: AgentRunTrace): string[] {
  const caveats: string[] = [];
  if (summary.invalid > 0) {
    caveats.push("Malformed JSONL lines were skipped; inspect the source transcript if counts look wrong.");
  }
  if (summary.truncated) {
    caveats.push("Input exceeded the parser line limit; split the transcript before import so no events are silently omitted.");
  }
  if (summary.droppedMeta > 0) {
    caveats.push("Claude Code sidecar metadata records were dropped because they are not trajectory steps.");
  }
  if (trace.steps.length === 0) {
    caveats.push("No reviewable steps were parsed; choose a different Claude Code session transcript.");
  }
  if (redactionDetected(trace)) {
    caveats.push("Sensitive-looking fields were redacted in normalized tool/message artifacts.");
  }
  return caveats;
}

export function summarizeClaudeCodePreflight(jsonl: string): ClaudeCodePreflightSummary {
  const inputBytes = new TextEncoder().encode(jsonl).byteLength;
  if (inputBytes > CLAUDE_CODE_IMPORT_MAX_BYTES) {
    return {
      status: "blocked",
      trace_ref: "trace-unknown",
      events: 0,
      steps: 0,
      invalid: 0,
      invalid_lines: [],
      truncated: false,
      over_size: true,
      input_bytes: inputBytes,
      dropped_meta: 0,
      compactions: 0,
      merged_messages: 0,
      models: [],
      privacy_class: "unknown",
      redaction_detected: false,
      step_kind_counts: {},
      caveats: ["Input exceeds the authenticated importer's 8 MiB file limit; split the transcript before import."],
    };
  }
  const { sessionId, trace, summary } = parseClaudeCodeSession(jsonl);
  const status: ClaudeCodePreflightStatus = trace.steps.length > 0 && !summary.truncated ? "ready" : "blocked";

  return {
    status,
    trace_ref: safeRef(trace.trace_id, "trace") ?? "trace-unknown",
    ...(safeRef(sessionId, "session") ? { session_ref: safeRef(sessionId, "session") } : {}),
    events: summary.events,
    steps: summary.steps,
    invalid: summary.invalid,
    invalid_lines: summary.invalidLines.slice(0, MAX_INVALID_LINES),
    truncated: summary.truncated,
    over_size: false,
    input_bytes: inputBytes,
    dropped_meta: summary.droppedMeta,
    compactions: summary.compactions,
    merged_messages: summary.mergedMessages,
    models: [...summary.models].sort(),
    ...(summary.earliest ? { earliest: summary.earliest } : {}),
    ...(summary.latest ? { latest: summary.latest } : {}),
    privacy_class: trace.privacy.class,
    redaction_detected: redactionDetected(trace),
    step_kind_counts: stepKindCounts(trace),
    caveats: caveatsFor(summary, trace),
  };
}

export function formatClaudeCodePreflightText(summary: ClaudeCodePreflightSummary): string {
  const lines: string[] = [];
  lines.push("Claude Code session preflight");
  lines.push(`status: ${summary.status}`);
  lines.push(`trace: ${summary.trace_ref}`);
  if (summary.session_ref) lines.push(`session: ${summary.session_ref}`);
  lines.push(`events: ${summary.events}`);
  lines.push(`steps: ${summary.steps}`);
  lines.push(`models: ${summary.models.length ? summary.models.join(", ") : "unknown"}`);
  lines.push(`time_bounds: ${summary.earliest ?? "unknown"} → ${summary.latest ?? "unknown"}`);
  lines.push(`invalid_lines: ${summary.invalid}${summary.invalid_lines.length ? ` (${summary.invalid_lines.join(", ")})` : ""}`);
  lines.push(`truncated: ${summary.truncated}`);
  lines.push(`over_size: ${summary.over_size}`);
  lines.push(`input_bytes: ${summary.input_bytes}`);
  lines.push(`dropped_meta: ${summary.dropped_meta}`);
  lines.push(`compactions: ${summary.compactions}`);
  lines.push(`merged_messages: ${summary.merged_messages}`);
  lines.push(`privacy_class: ${summary.privacy_class}`);
  lines.push(`redaction_detected: ${summary.redaction_detected}`);
  lines.push(
    `step_kinds: ${Object.entries(summary.step_kind_counts)
      .map(([kind, count]) => `${kind}=${count}`)
      .join(", ") || "none"}`,
  );
  if (summary.caveats.length) {
    lines.push("caveats:");
    for (const caveat of summary.caveats) lines.push(`- ${caveat}`);
  }
  lines.push(summary.status === "ready"
    ? "safe_to_upload: use the authenticated app import next; this preflight did not send data anywhere."
    : "no_data_sent: preflight is blocked; resolve the caveats before using authenticated import.");
  return lines.join("\n") + "\n";
}

export function formatClaudeCodePreflightJson(summary: ClaudeCodePreflightSummary): string {
  return JSON.stringify(summary, null, 2) + "\n";
}
