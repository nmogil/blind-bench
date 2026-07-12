/**
 * #53 (export bridge): Convex-safe serializers for training-data export.
 *
 * Pure, zero-dep (no node, no zod) so it runs in the Convex export action and in
 * plain vitest. This module owns only the TARGET JSONL shapes (fixed by #53) and
 * the data-boundary gate applied at serialization time; the per-source mapping
 * (output preferences / trajectory matchups → these rows) lives in the export
 * action. Formats:
 *
 *   DPO:       {prompt, chosen, rejected, metadata}
 *   Annotated: {prompt, output, annotations:[{from,to,text,comment,tags}], preference, metadata}
 *   SFT:       {messages:[{role,content}], metadata?}
 *
 * Data-boundary contract (mirrors src/lib/evals/trainingDataset.ts / #228):
 *  - Default-deny by privacy class: only `public`/`internal` rows export; any
 *    `confidential`/`pii`/`phi` (prod-sensitive) row is EXCLUDED unless the
 *    caller passes an explicit consent flag.
 *  - Excluded rows are reported with a reason, never dropped silently.
 *  - Defense-in-depth: a row whose serialized text still contains an email or an
 *    api-key-looking token is excluded (`pii_leak`) even if its class allowed it.
 *  Anonymization is by CONSTRUCTION in the action (allowlisted fields only); this
 *  gate is the backstop.
 */

export type ExportFormat = "dpo" | "annotated" | "sft";

/** Conservative Convex-safe hard caps for approved export generation. */
export const TRAINING_EXPORT_LIMITS = {
  maxCandidates: 50,
  maxProjectionBytes: 512 * 1024,
  maxRowBytes: 768 * 1024,
  maxJsonlBytes: 4 * 1024 * 1024,
  maxManifestBytes: 512 * 1024,
  maxExportsPerApproval: 20,
} as const;

/** UTF-8 byte length used by every export size gate. */
export function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export type TrainingExportSizeInput = {
  readonly candidates?: number;
  readonly projectionBytes?: number;
  readonly rowBytes?: number;
  readonly jsonlBytes?: number;
  readonly manifestBytes?: number;
};

/** Return the first exceeded hard cap; exact-limit values are accepted. */
export function trainingExportSizeViolation(input: TrainingExportSizeInput): keyof TrainingExportSizeInput | null {
  if (input.candidates !== undefined && input.candidates > TRAINING_EXPORT_LIMITS.maxCandidates) return "candidates";
  if (input.projectionBytes !== undefined && input.projectionBytes > TRAINING_EXPORT_LIMITS.maxProjectionBytes) return "projectionBytes";
  if (input.rowBytes !== undefined && input.rowBytes > TRAINING_EXPORT_LIMITS.maxRowBytes) return "rowBytes";
  if (input.jsonlBytes !== undefined && input.jsonlBytes > TRAINING_EXPORT_LIMITS.maxJsonlBytes) return "jsonlBytes";
  if (input.manifestBytes !== undefined && input.manifestBytes > TRAINING_EXPORT_LIMITS.maxManifestBytes) return "manifestBytes";
  return null;
}
export type PrivacyClass = "public" | "internal" | "confidential" | "pii" | "phi";

export interface Annotation {
  from: number;
  to: number;
  text: string;
  comment: string;
  tags: string[];
}

export interface DpoPair {
  prompt: string;
  chosen: string;
  rejected: string;
  metadata: Record<string, unknown>;
}

export interface AnnotatedRow {
  prompt: string;
  output: string;
  annotations: Annotation[];
  preference: string;
  metadata: Record<string, unknown>;
}

export interface SftMessage {
  role: string;
  content: string;
}

export interface SftRow {
  messages: SftMessage[];
  metadata?: Record<string, unknown>;
}

export type ExportRow =
  | ({ kind: "dpo" } & DpoPair)
  | ({ kind: "annotated" } & AnnotatedRow)
  | ({ kind: "sft" } & SftRow);

/** Every export row carries its privacy class so the gate can decide. */
export interface ClassifiedRow {
  row: ExportRow;
  privacyClass: PrivacyClass;
}

export interface ExcludedRow {
  reason:
    | "prod_sensitive"
    | "pii_leak"
    | "empty"
    | "degenerate"
    | "non_comparable_prefix"
    | "review_disagreement"
    | "no_preference"
    | "no_approved_verdict"
    | "invalid_sft_shape"
    | "not_full_span"
    | "fixture_only"
    | "insufficient_evidence"
    | "sensitive"
    | "hidden_reasoning"
    | "post_hoc_or_non_observable"
    | "task_mismatch"
    | "canary_or_private_leak";
  privacyClass: PrivacyClass;
}

export interface GateResult {
  included: ExportRow[];
  excluded: ExcludedRow[];
}

const SENSITIVE_CLASSES: ReadonlySet<PrivacyClass> = new Set([
  "confidential",
  "pii",
  "phi",
]);

// Belt-and-suspenders leak scan: email + common secret-key prefixes.
const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const API_KEY = /\b(sk-[a-z0-9]{16,}|xox[baprs]-[a-z0-9-]{10,}|AKIA[0-9A-Z]{12,}|ghp_[a-z0-9]{20,})\b/i;
const PRIVATE_OR_CANARY = /HIDDEN_VERIFIER_CANARY_|analysis_metadata|assistant_reasoning|(?:provider|model|harness)[_-]?(?:id|name)?\s*[:=]/i;

const rowText = (row: ExportRow): string => {
  switch (row.kind) {
    case "dpo":
      return `${row.prompt}\n${row.chosen}\n${row.rejected}`;
    case "annotated":
      return `${row.prompt}\n${row.output}\n${row.annotations.map((a) => `${a.text} ${a.comment}`).join("\n")}`;
    case "sft":
      return row.messages.map((m) => m.content).join("\n");
  }
};

const isEmptyRow = (row: ExportRow): boolean => {
  switch (row.kind) {
    case "dpo":
      return !row.prompt.trim() || !row.chosen.trim() || !row.rejected.trim();
    case "annotated":
      return !row.prompt.trim() || !row.output.trim();
    case "sft":
      return row.messages.length === 0 || row.messages.every((m) => !m.content.trim());
  }
};

/**
 * Apply the data-boundary gate. `allowSensitive` opts sensitive-class rows in
 * (explicit consent); the pii-leak scan and empty-row drop always apply.
 */
export function gateRows(
  rows: ClassifiedRow[],
  opts: { allowSensitive?: boolean } = {},
): GateResult {
  const included: ExportRow[] = [];
  const excluded: ExcludedRow[] = [];
  for (const { row, privacyClass } of rows) {
    if (isEmptyRow(row)) {
      excluded.push({ reason: "empty", privacyClass });
      continue;
    }
    if (
      row.kind === "sft" &&
      (row.messages.some((message) => !["system", "user", "assistant"].includes(message.role)) ||
        row.messages[row.messages.length - 1]?.role !== "assistant")
    ) {
      excluded.push({ reason: "invalid_sft_shape", privacyClass });
      continue;
    }
    if (SENSITIVE_CLASSES.has(privacyClass) && !opts.allowSensitive) {
      excluded.push({ reason: "prod_sensitive", privacyClass });
      continue;
    }
    // A DPO pair with identical chosen/rejected carries no preference signal —
    // it pollutes the dataset. Drop it (e.g. the matchup's divergence index
    // landed on a shared-prefix step). Surfaced by the M31 dogfood pass.
    if (row.kind === "dpo" && row.chosen.trim() === row.rejected.trim()) {
      excluded.push({ reason: "degenerate", privacyClass });
      continue;
    }
    const text = rowText(row);
    if (EMAIL.test(text) || API_KEY.test(text)) {
      excluded.push({ reason: "pii_leak", privacyClass });
      continue;
    }
    if (PRIVATE_OR_CANARY.test(text)) {
      excluded.push({ reason: "canary_or_private_leak", privacyClass });
      continue;
    }
    included.push(row);
  }
  return { included, excluded };
}

// --- reviewer-safe training trajectory serialization -------------------------

/** Agent-observable event shape accepted by the safe training serializer. */
export interface AgentObservableEvent {
  readonly sequence: number;
  readonly kind: string;
  readonly role?: string;
  readonly content?: string;
  readonly callId?: string;
  readonly toolName?: string;
  readonly status?: string;
  readonly arguments?: unknown;
  readonly result?: unknown;
  readonly error?: string;
}

const AGENT_OBSERVABLE_KINDS: ReadonlySet<string> = new Set([
  "user_message",
  "assistant_message",
  "tool_call",
  "tool_result",
  "tool_error",
]);

/** True only for context/action events the agent could observe at inference. */
export function isAgentObservableTrainingEvent(event: AgentObservableEvent): boolean {
  return AGENT_OBSERVABLE_KINDS.has(event.kind);
}

/** Serialize one allowlisted event without timestamps or provenance. */
export function serializeAgentObservableEvent(event: AgentObservableEvent): string | null {
  if (!isAgentObservableTrainingEvent(event)) return null;
  return JSON.stringify({
    sequence: event.sequence,
    kind: event.kind,
    ...(event.role ? { role: event.role } : {}),
    ...(event.content ? { content: event.content } : {}),
    ...(event.toolName ? { tool: event.toolName } : {}),
    ...(event.status ? { status: event.status } : {}),
    ...(event.arguments !== undefined ? { arguments: event.arguments } : {}),
    ...(event.result !== undefined ? { result: event.result } : {}),
    ...(event.error ? { error: event.error } : {}),
  });
}

/**
 * Serialize task + agent-observable chronology only. Iteration stops at the
 * first final output even if malformed/post-hoc events follow it. Objective
 * outcomes, rewards, verifier/workspace/policy events, reasoning, final output,
 * lifecycle, and termination are never included in model input.
 */
export function serializeAgentObservableTrajectoryContext(input: {
  readonly taskPrompt: string;
  readonly events: ReadonlyArray<AgentObservableEvent>;
}): string {
  const observedEvents: unknown[] = [];
  for (const event of input.events) {
    if (event.kind === "final_output") break;
    const serialized = serializeAgentObservableEvent(event);
    if (serialized !== null) {
      const parsed: unknown = JSON.parse(serialized);
      observedEvents.push(parsed);
    }
  }
  return JSON.stringify({
    schema: "blindbench.agent-observable-trajectory",
    version: 1,
    task: input.taskPrompt,
    observed_events: observedEvents,
  });
}

// --- legacy trajectory rendering (steps → readable text) ---------------------

export interface StepMeta {
  kind: "message" | "tool_call" | "tool_result" | "state" | "policy_event";
  role?: string;
  toolName?: string;
  label?: string;
  policy?: string;
  action?: string;
  reason?: string;
}

const asStr = (v: unknown): string =>
  typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v);

/** One step (metadata + its parsed body) → a single readable transcript line. */
export function renderStep(meta: StepMeta, body: unknown): string {
  const b = (body ?? {}) as Record<string, unknown>;
  switch (meta.kind) {
    case "message":
      return `${meta.role ?? "assistant"}: ${asStr(b.content)}`;
    case "tool_call":
      return `${meta.role ?? "assistant"} → ${meta.toolName ?? "tool"}(${asStr(b.args)})`;
    case "tool_result":
      return `tool ${meta.toolName ?? ""} result: ${asStr(b.result)}`;
    case "state":
      return `[state ${meta.label ?? ""}] ${asStr(b.snapshot)}`;
    case "policy_event":
      return `[policy ${meta.policy ?? ""}/${meta.action ?? ""}${meta.reason ? `: ${meta.reason}` : ""}]`;
  }
}

/** Ordered (meta, body) pairs → a transcript string (DPO prefix / SFT turns). */
export function renderTranscript(steps: Array<{ meta: StepMeta; body: unknown }>): string {
  return steps.map((s) => renderStep(s.meta, s.body)).join("\n");
}

/** The more-sensitive of two privacy classes (for a matchup spanning two traces). */
const CLASS_RANK: Record<PrivacyClass, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  pii: 3,
  phi: 4,
};
export function moreSensitive(a: PrivacyClass, b: PrivacyClass): PrivacyClass {
  return CLASS_RANK[a] >= CLASS_RANK[b] ? a : b;
}

// --- export manifest (Fireworks handoff report) ------------------------------

/**
 * Aggregate provenance for an export — how much reviewed signal fed it. Counts
 * only: raw trace/run/user ids are intentionally NOT carried into the manifest
 * (exports are anonymized by construction).
 */
export interface ExportSourceStats {
  /** Source units that yielded ≥1 candidate row: runs (output-pref), decided matchups / best traces (trajectory). */
  sourceUnits: number;
  /** Distinct reviewers whose verdicts/preferences/matchups fed this export. */
  reviewers: number;
}

/**
 * The manifest/report emitted alongside every export. Enough metadata for a
 * Fireworks fine-tuning handoff: source kind, format, counts, exclusion breakdown,
 * the sensitivity gate state, a schema/version stamp, and human-readable notes on
 * DPO comparability and exclusions. Persisted with the export and shown in-app;
 * no raw prompt/output text and no trace ids.
 */
export interface ExportManifest {
  schema: "blindbench.training-export";
  version: 2;
  generated_at: number;
  source: "trajectory" | "output_preference";
  format: ExportFormat;
  row_count: number;
  excluded_count: number;
  excluded_by_reason: Partial<Record<ExcludedRow["reason"], number>>;
  sensitivity_gate: {
    allow_sensitive: boolean;
    default_deny_classes: PrivacyClass[];
  };
  source_units: number;
  reviewers: number;
  policy: {
    training_approval_required: true;
    approval_status: "active";
    policy_version: string;
    privacy_policy: "public_or_internal_only";
    safe_trajectory_serialization: "agent-observable-trajectory-v1";
  };
  integrity: {
    candidate_count: number;
    included_count: number;
    excluded_count: number;
    reconciled: boolean;
    row_hashes: string[];
    dataset_hash: string;
  };
  fireworks: { compatible: boolean; row_shape: string };
  notes: string[];
}

export function buildExportManifest(input: {
  source: "trajectory" | "output_preference";
  format: ExportFormat;
  included: ExportRow[];
  excluded: ExcludedRow[];
  allowSensitive: boolean;
  stats: ExportSourceStats;
  generatedAt: number;
  approvalPolicyVersion?: string;
  rowHashes?: string[];
  datasetHash?: string;
  candidateCount?: number;
}): ExportManifest {
  const { source, format, included, excluded, allowSensitive, stats, generatedAt } = input;

  const byReason: Partial<Record<ExcludedRow["reason"], number>> = {};
  for (const e of excluded) byReason[e.reason] = (byReason[e.reason] ?? 0) + 1;

  const notes: string[] = [];
  if (format === "dpo") {
    notes.push(
      "Trajectory DPO rows require a persisted SHA-256 shared-prefix proof and an unambiguous directional reviewer decision. Prefix mismatches, reviewer disagreement, ties/skips, and identical chosen/rejected text are excluded with explicit reasons.",
    );
    if (included.length === 0)
      notes.push(
        "No comparable preference pairs were found, so no DPO rows were written. Decide more A/B matchups (trajectories) or add best+weak ratings on the same run (prompt outputs).",
      );
  }
  if (format === "sft") {
    notes.push(
      "SFT rows use the OpenAI/Fireworks chat shape { messages: [{ role, content }] }; roles are limited to system/user/assistant, the final turn is assistant, and only unambiguously best-rated outputs/trajectories are included.",
    );
    if ((byReason.invalid_sft_shape ?? 0) > 0) {
      notes.push(`${byReason.invalid_sft_shape} row(s) excluded because the chat roles or final assistant turn were invalid.`);
    }
  }
  if ((byReason.prod_sensitive ?? 0) > 0 && !allowSensitive)
    notes.push(
      `${byReason.prod_sensitive} row(s) excluded as prod-sensitive (confidential/PII/PHI). Re-run with explicit consent to include them.`,
    );
  if ((byReason.pii_leak ?? 0) > 0)
    notes.push(
      `${byReason.pii_leak} row(s) excluded by the PII/secret leak scan even though their privacy class was allowed.`,
    );
  if ((byReason.non_comparable_prefix ?? 0) > 0)
    notes.push(
      `${byReason.non_comparable_prefix} trajectory matchup(s) excluded because the chosen/rejected prefixes did not share the same persisted hash.`,
    );
  if ((byReason.review_disagreement ?? 0) > 0)
    notes.push(
      `${byReason.review_disagreement} trajectory matchup(s) excluded because reviewers selected different winners.`,
    );
  if ((byReason.no_preference ?? 0) > 0)
    notes.push(
      `${byReason.no_preference} trajectory matchup(s) excluded because reviewers only tied or skipped the pair.`,
    );
  notes.push(
    "Source trace/run ids are omitted by design — exports are anonymized by construction; source_units and reviewers are aggregate counts only.",
  );

  return {
    schema: "blindbench.training-export",
    version: 2,
    generated_at: generatedAt,
    source,
    format,
    row_count: included.length,
    excluded_count: excluded.length,
    excluded_by_reason: byReason,
    sensitivity_gate: {
      allow_sensitive: allowSensitive,
      default_deny_classes: [...SENSITIVE_CLASSES],
    },
    source_units: stats.sourceUnits,
    reviewers: stats.reviewers,
    policy: {
      training_approval_required: true,
      approval_status: "active",
      policy_version: input.approvalPolicyVersion ?? "legacy-test-only",
      privacy_policy: "public_or_internal_only",
      safe_trajectory_serialization: "agent-observable-trajectory-v1",
    },
    integrity: {
      candidate_count: input.candidateCount ?? included.length + excluded.length,
      included_count: included.length,
      excluded_count: excluded.length,
      reconciled: (input.candidateCount ?? included.length + excluded.length) === included.length + excluded.length,
      row_hashes: input.rowHashes ?? [],
      dataset_hash: input.datasetHash ?? "",
    },
    fireworks: {
      compatible: true,
      row_shape: format === "sft" ? "messages[]" : "prompt/chosen/rejected",
    },
    notes,
  };
}

const jsonl = (objs: unknown[]): string => objs.map((o) => JSON.stringify(o)).join("\n");

/** Serialize gated rows to JSONL for the given format. Rows must match `format`. */
export function toJsonl(format: ExportFormat, rows: ExportRow[]): string {
  if (format === "dpo") {
    return jsonl(
      rows.map((r) => {
        const p = r as DpoPair;
        return { prompt: p.prompt, chosen: p.chosen, rejected: p.rejected, metadata: p.metadata };
      }),
    );
  }
  if (format === "annotated") {
    return jsonl(
      rows.map((r) => {
        const a = r as AnnotatedRow;
        return {
          prompt: a.prompt,
          output: a.output,
          annotations: a.annotations,
          preference: a.preference,
          metadata: a.metadata,
        };
      }),
    );
  }
  return jsonl(
    rows.map((r) => {
      const s = r as SftRow;
      return { messages: s.messages };
    }),
  );
}

async function digest(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Verify an approved export artifact against its v2 manifest without logging
 * row content. This is the same local/no-network seam used by synthetic Convex
 * integration tests before an operator handoff.
 */
export async function verifyApprovedExportArtifact(
  jsonl: string,
  manifest: ExportManifest,
): Promise<{ readonly ready: boolean; readonly reasons: string[] }> {
  const reasons: string[] = [];
  const lines = jsonl === "" ? [] : jsonl.split("\n");
  if (manifest.schema !== "blindbench.training-export" || manifest.version !== 2) reasons.push("unsupported_manifest");
  if (!manifest.integrity.reconciled) reasons.push("counts_not_reconciled");
  if (manifest.row_count !== lines.length || manifest.integrity.included_count !== lines.length) reasons.push("row_count_mismatch");
  if (manifest.integrity.excluded_count !== manifest.excluded_count) reasons.push("excluded_count_mismatch");
  if (manifest.integrity.candidate_count !== manifest.row_count + manifest.excluded_count) reasons.push("candidate_count_mismatch");
  const actualHashes: string[] = [];
  for (const line of lines) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) reasons.push("invalid_row_shape");
      else if (manifest.format === "sft" && (Object.keys(parsed).length !== 1 || !("messages" in parsed))) reasons.push("invalid_sft_shape");
      else if (manifest.format === "dpo" && !("prompt" in parsed && "chosen" in parsed && "rejected" in parsed)) reasons.push("invalid_dpo_shape");
    } catch {
      reasons.push("invalid_jsonl");
    }
    actualHashes.push(await digest(line));
  }
  if (JSON.stringify(actualHashes) !== JSON.stringify(manifest.integrity.row_hashes)) reasons.push("row_hash_mismatch");
  if (await digest(jsonl) !== manifest.integrity.dataset_hash) reasons.push("dataset_hash_mismatch");
  return { ready: reasons.length === 0, reasons: [...new Set(reasons)] };
}
