import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { stableStringify } from "./cloudflareAiGateway";
import {
  SPLITS,
  compileTrainingDataset,
  demoTrainingSourceRows,
  type CompiledRow,
  type SplitName,
  type TrainingDatasetManifest,
} from "./trainingDataset";

export interface EvaluationRowMessage {
  role: string;
  content: string;
}

export interface EvaluationRow {
  messages: EvaluationRowMessage[];
  tools: unknown[];
  input_metadata: Record<string, unknown>;
  rollout_status: "completed";
  ground_truth: Record<string, unknown>;
  evaluation_result: Record<string, unknown>;
  execution_metadata: Record<string, unknown>;
  created_at: string;
  eval_metadata: Record<string, unknown>;
}

export interface EvaluationRowExportManifest {
  format: "evaluation_row_jsonl";
  schema_family: "eval_protocol_evaluation_row";
  generated_at: string;
  dataset_name: string;
  source_dataset_hash: string;
  row_count: number;
  split_counts: Record<SplitName, number>;
  row_hashes: Array<{ case_id: string; split: SplitName; hash: string }>;
  dataset_hash: string;
  caveats: string[];
}

export interface EvaluationRowExportBundle {
  rows: EvaluationRow[];
  jsonl: string;
  manifest: EvaluationRowExportManifest;
  reportMarkdown: string;
}

const DEFAULT_GENERATED_AT = "2026-01-01T00:00:00Z";
const DEFAULT_DATASET = "evaluation-row-demo";

function sha256hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function rowLine(row: EvaluationRow): string {
  return stableStringify(row);
}

export function toEvaluationRow(row: CompiledRow, sourceManifest: TrainingDatasetManifest, generatedAt: string): EvaluationRow {
  return {
    messages: row.messages.map((message) => ({ role: message.role, content: message.content })),
    tools: [],
    input_metadata: {
      case_id: row.metadata.case_id,
      product: row.metadata.product,
      source: row.metadata.source,
      privacy_class: row.metadata.privacy_class,
      classification: row.metadata.classification,
      split: row.metadata.split,
    },
    rollout_status: "completed",
    ground_truth: {
      source: "blind_bench_review",
      classification: row.metadata.classification,
    },
    evaluation_result: {
      approved_for_training: row.metadata.classification === "training_approved",
      source_dataset_hash_suffix: sourceManifest.dataset_hash.slice(0, 16),
    },
    execution_metadata: {
      exporter: "blind_bench_evaluation_row_local",
      dataset_name: sourceManifest.dataset_name,
    },
    created_at: generatedAt,
    eval_metadata: {
      case_id: row.metadata.case_id,
      product: row.metadata.product,
      source: row.metadata.source,
      split: row.metadata.split,
      approver: row.metadata.approver,
      approved_at: row.metadata.approved_at,
      variant: row.metadata.variant,
      customer_scope: row.metadata.customer_scope,
    },
  };
}

export function toEvaluationRowJsonl(rows: EvaluationRow[]): string {
  return rows.map(rowLine).join("\n") + (rows.length ? "\n" : "");
}

export function buildEvaluationRowExportBundle(options: {
  generated_at?: string;
  dataset_name?: string;
} = {}): EvaluationRowExportBundle {
  const generatedAt = options.generated_at ?? DEFAULT_GENERATED_AT;
  const compiled = compileTrainingDataset(demoTrainingSourceRows(), {
    generated_at: generatedAt,
    dataset_name: options.dataset_name ?? DEFAULT_DATASET,
  });

  const rows: EvaluationRow[] = [];
  const rowHashes: EvaluationRowExportManifest["row_hashes"] = [];
  for (const split of SPLITS) {
    for (const row of compiled.splits[split]) {
      const evaluationRow = toEvaluationRow(row, compiled.manifest, generatedAt);
      const line = rowLine(evaluationRow);
      rows.push(evaluationRow);
      rowHashes.push({ case_id: row.metadata.case_id, split, hash: sha256hex(line) });
    }
  }

  const jsonl = toEvaluationRowJsonl(rows);
  const manifest: EvaluationRowExportManifest = {
    format: "evaluation_row_jsonl",
    schema_family: "eval_protocol_evaluation_row",
    generated_at: generatedAt,
    dataset_name: compiled.manifest.dataset_name,
    source_dataset_hash: compiled.manifest.dataset_hash,
    row_count: rows.length,
    split_counts: compiled.manifest.split_counts,
    row_hashes: rowHashes,
    dataset_hash: sha256hex(jsonl),
    caveats: [
      "Optional compatibility artifact only; this does not adopt Eval Protocol runtime, Python SDK, or Fireworks tracing proxy.",
      "Synthetic demo rows only by default.",
      "Real rows require existing Blind Bench consent, privacy, and training-export gates before serialization.",
      "Summary/report output intentionally omits raw prompts, completions, and tool arguments.",
    ],
  };

  return {
    rows,
    jsonl,
    manifest,
    reportMarkdown: formatEvaluationRowExportReport(manifest),
  };
}

export function formatEvaluationRowExportManifest(manifest: EvaluationRowExportManifest): string {
  return JSON.stringify(manifest, null, 2) + "\n";
}

export function formatEvaluationRowExportReport(manifest: EvaluationRowExportManifest): string {
  return [
    "# EvaluationRow compatibility export",
    "",
    "## Summary",
    "",
    `- Format: \`${manifest.format}\``,
    `- Schema family: \`${manifest.schema_family}\``,
    `- Dataset: \`${manifest.dataset_name}\``,
    `- Rows: ${manifest.row_count}`,
    `- Splits: train=${manifest.split_counts.train}, validation=${manifest.split_counts.validation}, test=${manifest.split_counts.test}`,
    `- Dataset hash suffix: \`${manifest.dataset_hash.slice(0, 16)}\``,
    `- Source dataset hash suffix: \`${manifest.source_dataset_hash.slice(0, 16)}\``,
    "",
    "## Caveats",
    "",
    ...manifest.caveats.map((caveat) => `- ${caveat}`),
    "",
  ].join("\n");
}

export function writeEvaluationRowExportBundle(bundle: EvaluationRowExportBundle, outDir: string): void {
  const jsonlPath = `${outDir}/evaluation-rows.jsonl`;
  const manifestPath = `${outDir}/evaluation-rows.manifest.json`;
  const reportPath = `${outDir}/evaluation-rows.report.md`;
  mkdirSync(dirname(jsonlPath), { recursive: true });
  writeFileSync(jsonlPath, bundle.jsonl);
  writeFileSync(manifestPath, formatEvaluationRowExportManifest(bundle.manifest));
  writeFileSync(reportPath, bundle.reportMarkdown);
}
