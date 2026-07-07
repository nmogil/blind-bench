/**
 * #264 (M31 Trajectory Spine): the lossless mapping between a normalized
 * `AgentTraceStep` and its persisted form — a light inline scalar row plus up
 * to two storage-bound body blobs (`full` = reviewer view, `blind` = precomputed
 * projection).
 *
 * Pure and self-contained (no Convex ctx) so it drives both the ingestion path
 * (`splitStep` → store blobs → insert rows) and reconstruction (`reconstructStep`
 * ← read rows + blobs), and can be unit-tested without the DB. The invariant:
 * `reconstructStep(splitStep(step)) deep-equals step` for every step kind. That
 * round-trip is exactly acceptance criterion 3 on #264.
 */
import type { AgentTraceStep, PrivacyClass } from "./agentTrace";

/** Inline scalar fields of an `agentTraceSteps` row (sans FK + storage ids). */
export interface StepRow {
  stepIndex: number;
  kind: AgentTraceStep["type"];
  role?: string;
  toolName?: string;
  toolCallId?: string;
  label?: string;
  policy?: string;
  action?: string;
  reason?: string;
  timestamp?: string;
  privacyClass?: PrivacyClass;
}

export interface SplitStep {
  row: StepRow;
  /** Reviewer-view body; undefined for bodyless kinds (policy_event). */
  fullBody?: unknown;
  /** Precomputed blind-view body; undefined for bodyless kinds. */
  blindBody?: unknown;
}

/** Normalized step → { inline row, full body, blind body }. */
export function splitStep(step: AgentTraceStep): SplitStep {
  const base = { stepIndex: step.index, timestamp: step.timestamp };
  switch (step.type) {
    case "message":
      return {
        row: { ...base, kind: "message", role: step.message.role },
        // Content is not key-redacted here; #266 refines message projection.
        fullBody: { content: step.message.content },
        blindBody: { content: step.message.content },
      };
    case "tool_call":
      return {
        row: {
          ...base,
          kind: "tool_call",
          toolName: step.name,
          toolCallId: step.tool_call_id,
          privacyClass: step.privacy_class,
        },
        fullBody: { args: step.args },
        blindBody: { args: step.redacted_args },
      };
    case "tool_result":
      return {
        row: {
          ...base,
          kind: "tool_result",
          toolName: step.name,
          toolCallId: step.tool_call_id,
          privacyClass: step.privacy_class,
        },
        fullBody: { result: step.result },
        blindBody: { result: step.redacted_result },
      };
    case "state":
      return {
        row: {
          ...base,
          kind: "state",
          label: step.label,
          privacyClass: step.privacy_class,
        },
        fullBody: { snapshot: step.snapshot },
        blindBody: { snapshot: step.redacted_snapshot },
      };
    case "policy_event":
      return {
        row: {
          ...base,
          kind: "policy_event",
          policy: step.policy,
          action: step.action,
          reason: step.reason,
        },
      };
  }
}

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/**
 * Inverse of `splitStep`: inline row + stored bodies → normalized step.
 * `fullBody`/`blindBody` are the parsed JSON bodies (or undefined for a bodyless
 * or blind-projected read where the full body was withheld). For blind reads
 * the caller passes the blind body as `fullBody` so the reconstructed step
 * carries the projected payload in its primary field.
 */
export function reconstructStep(
  row: StepRow,
  fullBody?: unknown,
  blindBody?: unknown,
): AgentTraceStep {
  const timestamp = row.timestamp;
  switch (row.kind) {
    case "message":
      return {
        type: "message",
        index: row.stepIndex,
        timestamp,
        message: { role: row.role ?? "assistant", content: String(rec(fullBody).content ?? "") },
      };
    case "tool_call":
      return {
        type: "tool_call",
        index: row.stepIndex,
        timestamp,
        tool_call_id: row.toolCallId ?? `tool-${row.stepIndex}`,
        name: row.toolName ?? "unknown_tool",
        args: rec(rec(fullBody).args),
        redacted_args: rec(rec(blindBody).args),
        privacy_class: row.privacyClass ?? "internal",
      };
    case "tool_result":
      return {
        type: "tool_result",
        index: row.stepIndex,
        timestamp,
        tool_call_id: row.toolCallId ?? `tool-${row.stepIndex}`,
        name: row.toolName,
        result: rec(fullBody).result,
        redacted_result: rec(blindBody).result,
        privacy_class: row.privacyClass ?? "internal",
      };
    case "state":
      return {
        type: "state",
        index: row.stepIndex,
        timestamp,
        label: row.label ?? "state_snapshot",
        snapshot: rec(rec(fullBody).snapshot),
        redacted_snapshot: rec(rec(blindBody).snapshot),
        privacy_class: row.privacyClass ?? "internal",
      };
    case "policy_event":
      return {
        type: "policy_event",
        index: row.stepIndex,
        timestamp,
        policy: row.policy ?? "unknown_policy",
        action: row.action ?? "unknown_action",
        reason: row.reason,
      };
  }
}
