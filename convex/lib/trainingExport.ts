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
    | "invalid_sft_shape";
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
    included.push(row);
  }
  return { included, excluded };
}

// --- trajectory rendering (steps → readable text for DPO prompt/answers) -----

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
  version: 1;
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
    version: 1,
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
      return s.metadata ? { messages: s.messages, metadata: s.metadata } : { messages: s.messages };
    }),
  );
}
