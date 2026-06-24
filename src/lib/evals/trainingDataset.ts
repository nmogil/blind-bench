/**
 * Local, deterministic Fireworks training-dataset compiler (issue #228).
 *
 * Turns explicitly training-approved review candidates into a Fireworks-compatible
 * chat/SFT JSONL dataset with deterministic train/validation/test splits and a
 * manifest. Pure and local: no network, no Convex, no Fireworks API, no real
 * customer data. The caller supplies `generated_at` so output is byte-stable.
 *
 * DATA-BOUNDARY CONTRACT (mirrors docs/tenancy-consent-data-isolation.md):
 *  - Only candidates produced by `approveForTraining` enter (TS enforces this).
 *  - `prod_sensitive` / `redacted_prod` candidates are blocked by construction.
 *  - Non-synthetic `training_approved` rows export ONLY when the caller passes
 *    `allow_training_approved_export` (default-deny explicit policy approval).
 *  - Rows marked `eval_only` (held-out) never reach train/validation; they reach
 *    the test split only when `allow_in_test` is set, else they are excluded.
 * Excluded rows are reported with a reason in the manifest, never dropped silently.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { EvalCase, type PrivacyClass, type ScenarioSource } from "./evalCase";
import { stableStringify } from "./cloudflareAiGateway";
import {
  customerPilotSmokeCases,
  customerPilotSmokeFixturesAllPass,
} from "./packs/customerPilot";
import {
  PromotionPolicy,
  ReviewDecision,
  approveForTraining,
  type DataClassification,
  type TrainingExportCandidate,
} from "./reviewWorkflow";

export type SplitName = "train" | "validation" | "test";
export const SPLITS: SplitName[] = ["train", "validation", "test"];

// --- Inputs ------------------------------------------------------------------

/** A training-approved candidate plus the metadata the compiler filters/splits on. */
export interface TrainingDatasetSourceRow {
  /** Produced by `approveForTraining` — the approval gate by construction. */
  candidate: TrainingExportCandidate;
  /** Provenance of the underlying case; gates raw-text export of real prod data. */
  source: ScenarioSource;
  /** Safe assistant completion for SFT (synthetic or approved-redacted text). */
  assistant_output: string;
  /** Held-out / eval-only: must never appear in train or validation. */
  eval_only?: boolean;
  /** Explicit allowance for an eval_only row to appear in the test split. */
  allow_in_test?: boolean;
  /** Force a split; otherwise a deterministic hash of the case id decides. */
  split_hint?: SplitName;
  variant?: string;
  customer_scope?: string;
  /** Optional reviewer score / rating used by min_score / min_rating filters. */
  metrics?: { score?: number; rating?: number };
}

export interface TrainingDatasetFilters {
  products?: string[];
  variants?: string[];
  privacy_classes?: PrivacyClass[];
  classifications?: DataClassification[];
  customer_scopes?: string[];
  approvers?: string[];
  min_score?: number;
  min_rating?: number;
}

export interface CompileOptions {
  /** ISO-8601 timestamp stamped into the manifest (caller-supplied, deterministic). */
  generated_at: string;
  dataset_name?: string;
  filters?: TrainingDatasetFilters;
  /** Required to export non-synthetic `training_approved` rows (default-deny). */
  allow_training_approved_export?: boolean;
  /** Split ratios; test is the remainder. Defaults to 0.8 / 0.1 / 0.1. */
  splits?: { train: number; validation: number };
  /**
   * Safety gate: any row whose input messages OR completion contain one of these
   * substrings is excluded (reason `forbidden_substring_blocked`) and never written
   * to JSONL. Use for known forbidden sentinels (cross-tenant ids, PII markers).
   */
  blocked_substrings?: string[];
}

// --- Outputs -----------------------------------------------------------------

/**
 * Safe sidecar metadata for a kept row. Lives in the MANIFEST (per-row entries),
 * never in the training JSONL — see `toJsonl`. Optional fields may be absent;
 * `JSON.stringify` (manifest) omits undefined keys so the manifest stays valid JSON.
 */
export interface RowMetadata {
  case_id: string;
  product: string;
  source: ScenarioSource;
  classification: DataClassification;
  privacy_class: PrivacyClass;
  split: SplitName;
  approver: string;
  approved_at?: string;
  variant?: string;
  customer_scope?: string;
}

/**
 * A compiled row held in memory. Only `messages` is written to JSONL (Fireworks
 * chat/SFT shape: `{ "messages": [...] }`); `metadata` is emitted in the manifest.
 */
export interface CompiledRow {
  messages: { role: string; content: string }[];
  metadata: RowMetadata;
}

/** Manifest per-row entry: the safe sidecar metadata plus the JSONL row hash. */
export type RowEntry = RowMetadata & { hash: string };

export interface ExcludedRow {
  case_id: string;
  reason: string;
}

export interface TrainingDatasetManifest {
  dataset_name: string;
  generated_at: string;
  filters: TrainingDatasetFilters;
  allow_training_approved_export: boolean;
  split_ratios: { train: number; validation: number; test: number };
  products: string[];
  privacy_classes: string[];
  classifications: string[];
  split_counts: Record<SplitName, number>;
  /** Per-row sidecar metadata + hash of the messages-only JSONL row, by split. */
  row_entries: Record<SplitName, RowEntry[]>;
  dataset_hash: string;
  excluded: ExcludedRow[];
}

export interface CompiledTrainingDataset {
  splits: Record<SplitName, CompiledRow[]>;
  manifest: TrainingDatasetManifest;
}

// --- Helpers -----------------------------------------------------------------

const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");

/** Stable 0–99 bucket from the case id — deterministic split assignment. */
function hashBucket(caseId: string): number {
  return createHash("sha256").update(caseId).digest().readUInt32BE(0) % 100;
}

/** Build the SFT message list: prior transcript, then case messages, then the completion. */
function buildMessages(row: TrainingDatasetSourceRow): { role: string; content: string }[] {
  const input = row.candidate.snapshot.input;
  return [
    ...(input.transcript ?? []),
    ...(input.messages ?? []),
    { role: "assistant", content: row.assistant_output },
  ];
}

/**
 * Why a row is excluded, or null if it should be kept. Default-deny: the first
 * failing gate wins, in classification → policy → filter order.
 */
function exclusionReason(row: TrainingDatasetSourceRow, opts: CompileOptions): string | null {
  const c = row.candidate;
  if (c.kind !== "training_export") return "not a training_export candidate";

  // Classification gate (defensive — approveForTraining only emits training_approved).
  if (c.classification === "prod_sensitive") return "prod_sensitive_blocked";
  if (c.classification === "redacted_prod") return "redacted_prod_not_exportable";
  if (c.classification !== "training_approved") return "classification_not_exportable";

  // Real (non-synthetic) data needs explicit policy approval to export raw text.
  if (row.source !== "synthetic" && !opts.allow_training_approved_export)
    return "training_approved_export_not_policy_approved";

  if (!row.assistant_output) return "no_assistant_output";
  const messages = buildMessages(row);
  if (messages.length <= 1) return "no_input_messages";

  // Safety gate: drop rows carrying a known forbidden sentinel in input or completion.
  // Reason is generic on purpose — never echo the matched value into the manifest.
  if (opts.blocked_substrings?.some((s) => messages.some((m) => m.content.includes(s))))
    return "forbidden_substring_blocked";

  // Filters.
  const f = opts.filters ?? {};
  const privacy = c.snapshot.expected.privacy_class;
  if (f.products && !f.products.includes(c.product)) return "filtered_out:product";
  if (f.classifications && !f.classifications.includes(c.classification))
    return "filtered_out:classification";
  if (f.privacy_classes && !f.privacy_classes.includes(privacy)) return "filtered_out:privacy_class";
  if (f.variants && !f.variants.includes(row.variant ?? "")) return "filtered_out:variant";
  if (f.customer_scopes && !f.customer_scopes.includes(row.customer_scope ?? ""))
    return "filtered_out:customer_scope";
  if (f.approvers && !f.approvers.includes(c.approver)) return "filtered_out:approver";
  if (f.min_score !== undefined && !(typeof row.metrics?.score === "number" && row.metrics.score >= f.min_score))
    return "filtered_out:min_score";
  if (f.min_rating !== undefined && !(typeof row.metrics?.rating === "number" && row.metrics.rating >= f.min_rating))
    return "filtered_out:min_rating";

  // Contamination prevention: held-out rows never train/validate; test only if allowed.
  if (row.eval_only && !row.allow_in_test) return "held_out_eval_only_excluded";

  return null;
}

/** Reject non-finite, negative, or >1 split ratios before compiling. */
function validateRatios(ratios: { train: number; validation: number }): void {
  const { train, validation } = ratios;
  for (const [name, v] of [["train", train], ["validation", validation]] as const) {
    if (!Number.isFinite(v) || v < 0)
      throw new Error(`Invalid split ratio: ${name}=${v} must be finite and non-negative`);
  }
  // test is the remainder (1 - train - validation); allow == 1 (empty test) but not over.
  if (train + validation > 1)
    throw new Error(
      `Invalid split ratios: train(${train}) + validation(${validation}) = ${train + validation} must be <= 1`,
    );
}

/** Resolve the split for a KEPT row. Held-out rows are forced to test. */
function assignSplit(
  row: TrainingDatasetSourceRow,
  ratios: { train: number; validation: number },
): SplitName {
  if (row.eval_only) return "test"; // exclusionReason already required allow_in_test
  if (row.split_hint) return row.split_hint;
  const bucket = hashBucket(row.candidate.source_case_id);
  const t = Math.round(ratios.train * 100);
  const v = Math.round(ratios.validation * 100);
  if (bucket < t) return "train";
  if (bucket < t + v) return "validation";
  return "test";
}

// --- Compile -----------------------------------------------------------------

export function compileTrainingDataset(
  rows: TrainingDatasetSourceRow[],
  opts: CompileOptions,
): CompiledTrainingDataset {
  const ratios = opts.splits ?? { train: 0.8, validation: 0.1 };
  validateRatios(ratios);
  const splits: Record<SplitName, CompiledRow[]> = { train: [], validation: [], test: [] };
  const excluded: ExcludedRow[] = [];
  const products = new Set<string>();
  const privacyClasses = new Set<string>();
  const classifications = new Set<string>();

  for (const row of rows) {
    const reason = exclusionReason(row, opts);
    if (reason) {
      excluded.push({ case_id: row.candidate.source_case_id, reason });
      continue;
    }
    const split = assignSplit(row, ratios);
    const c = row.candidate;
    products.add(c.product);
    privacyClasses.add(c.snapshot.expected.privacy_class);
    classifications.add(c.classification);
    const metadata: RowMetadata = {
      case_id: c.source_case_id,
      product: c.product,
      source: row.source,
      classification: c.classification,
      privacy_class: c.snapshot.expected.privacy_class,
      split,
      approver: c.approver,
    };
    if (c.approved_at !== undefined) metadata.approved_at = c.approved_at;
    if (row.variant !== undefined) metadata.variant = row.variant;
    if (row.customer_scope !== undefined) metadata.customer_scope = row.customer_scope;
    splits[split].push({
      messages: buildMessages(row),
      metadata,
    });
  }

  // Sort every split by case id for deterministic ordering, then hash.
  const row_entries = {} as Record<SplitName, RowEntry[]>;
  const split_counts = {} as Record<SplitName, number>;
  for (const s of SPLITS) {
    splits[s].sort((a, b) => a.metadata.case_id.localeCompare(b.metadata.case_id));
    split_counts[s] = splits[s].length;
    // Hash the messages-only JSONL row so the manifest verifies what's actually written.
    row_entries[s] = splits[s].map((r) => ({
      ...r.metadata,
      hash: sha256hex(jsonlLine(r)),
    }));
  }
  excluded.sort((a, b) => a.case_id.localeCompare(b.case_id) || a.reason.localeCompare(b.reason));

  const dataset_hash = sha256hex(stableStringify(row_entries));

  return {
    splits,
    manifest: {
      dataset_name: opts.dataset_name ?? "training-dataset",
      generated_at: opts.generated_at,
      filters: opts.filters ?? {},
      allow_training_approved_export: opts.allow_training_approved_export ?? false,
      split_ratios: { train: ratios.train, validation: ratios.validation, test: Number((1 - ratios.train - ratios.validation).toFixed(4)) },
      products: [...products].sort(),
      privacy_classes: [...privacyClasses].sort(),
      classifications: [...classifications].sort(),
      split_counts,
      row_entries,
      dataset_hash,
      excluded,
    },
  };
}

/**
 * One messages-only JSONL line for a row: `{"messages":[...]}`. Fireworks chat/SFT
 * shape. Always valid JSON — no optional/undefined sidecar keys (those live in the
 * manifest). stableStringify gives deterministic key order; message contents are strings.
 */
function jsonlLine(row: CompiledRow): string {
  return stableStringify({ messages: row.messages });
}

/** Serialize one split to deterministic, strictly-valid JSONL (trailing newline). */
export function toJsonl(rows: CompiledRow[]): string {
  return rows.map(jsonlLine).join("\n") + (rows.length ? "\n" : "");
}

export function formatManifest(manifest: TrainingDatasetManifest): string {
  return JSON.stringify(manifest, null, 2) + "\n";
}

// --- Synthetic customer-pilot fixture source ---------------------------------

const PILOT_REVIEWED_AT = "2026-01-01T00:00:00Z";
const PILOT_APPROVED_AT = "2026-01-01T00:00:00Z";

/**
 * Build training source rows from the SYNTHETIC customer-pilot smoke pack by
 * approving each case with an explicit `training_approved` policy and pairing it
 * with the clean (all-pass) synthetic completion. Every 5th case is marked
 * held-out (eval_only, allow_in_test) to exercise contamination prevention.
 */
export function customerPilotTrainingSourceRows(): TrainingDatasetSourceRow[] {
  const policy = PromotionPolicy.parse({
    classification: "training_approved",
    review_allowed: true,
    training_allowed: true,
  });
  return customerPilotSmokeCases.map((raw, i) => {
    const c = EvalCase.parse(raw);
    const review = ReviewDecision.parse({
      case_id: c.id,
      reviewer_id: "reviewer-TEST-1",
      outcome: "pass",
      reason_tag: "approved_for_training",
      reviewed_at: PILOT_REVIEWED_AT,
    });
    const candidate = approveForTraining(c, review, policy, PILOT_APPROVED_AT);
    const eval_only = i % 5 === 0;
    return {
      candidate,
      source: c.source,
      assistant_output: customerPilotSmokeFixturesAllPass[c.id]?.text ?? "",
      eval_only,
      allow_in_test: eval_only,
      variant: c.product === "eavesly" ? "voice-v1" : "sms-v1",
      customer_scope: (c.metadata?.customer_scope as string | undefined) ?? "customer-pilot",
      metrics: { score: 1, rating: 5 },
    };
  });
}

// --- CLI entrypoint ----------------------------------------------------------

const OUT_DIR = "artifacts";
const BASENAME = "customer-pilot-training-dataset";
// Fixed default so `npm run dataset:customer-pilot` is byte-stable; override via argv[0].
const DEFAULT_GENERATED_AT = "2026-01-01T00:00:00Z";

export async function main(argv: string[]): Promise<number> {
  const generated_at = argv[0] ?? DEFAULT_GENERATED_AT;
  const { splits, manifest } = compileTrainingDataset(customerPilotTrainingSourceRows(), {
    generated_at,
    dataset_name: BASENAME,
  });

  mkdirSync(OUT_DIR, { recursive: true });
  for (const s of SPLITS) writeFileSync(`${OUT_DIR}/${BASENAME}.${s}.jsonl`, toJsonl(splits[s]));
  writeFileSync(`${OUT_DIR}/${BASENAME}.manifest.json`, formatManifest(manifest));

  process.stdout.write(
    `Wrote ${OUT_DIR}/${BASENAME}.{train,validation,test}.jsonl + .manifest.json\n` +
      `  splits: train=${manifest.split_counts.train} validation=${manifest.split_counts.validation} test=${manifest.split_counts.test}\n` +
      `  excluded: ${manifest.excluded.length}  dataset_hash: ${manifest.dataset_hash.slice(0, 16)}…\n`,
  );
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
