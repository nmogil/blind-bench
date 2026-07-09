import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stableStringify } from "./cloudflareAiGateway";
import { SPLITS, type SplitName } from "./trainingDataset";

type ReadFile = (path: string) => string;

export interface VerifyTrainingExportOptions {
  artifactDir: string;
  blockedSubstrings?: string[];
  readFile?: ReadFile;
}

export type TrainingExportReadiness = "ready" | "not_ready";

export interface VerifyTrainingExportSummary {
  readiness: TrainingExportReadiness;
  filesChecked: string[];
  datasetName?: string;
  datasetHashSuffix?: string;
  rows: Record<SplitName, number>;
  excludedCount: number;
  errors: string[];
  caveats: string[];
}

interface ManifestRowEntry {
  case_id?: string;
  hash?: string;
}

interface ManifestShape {
  dataset_name?: string;
  dataset_hash?: string;
  split_counts?: Partial<Record<SplitName, number>>;
  row_entries?: Partial<Record<SplitName, ManifestRowEntry[]>>;
  excluded?: unknown[];
}

const DATASET_BASENAME = "training-dataset";
const MANIFEST_FILE = `${DATASET_BASENAME}.manifest.json`;
const SPLIT_FILE = (split: SplitName) => `${DATASET_BASENAME}.${split}.jsonl`;

const sha256hex = (value: string) => createHash("sha256").update(value).digest("hex");

function safeSuffix(value: unknown, chars = 12): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value.length <= chars ? value : `…${value.slice(-chars)}`;
}

function hasBlockedSubstring(value: string, blocked: string[]): boolean {
  return blocked.some((s) => s.length > 0 && value.includes(s));
}

function validateMessagesRow(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "row_not_object";
  const row = value as Record<string, unknown>;
  if (!Array.isArray(row.messages)) return "messages_missing";
  if (row.messages.length === 0) return "messages_empty";
  for (const message of row.messages) {
    if (!message || typeof message !== "object" || Array.isArray(message)) return "message_not_object";
    const m = message as Record<string, unknown>;
    if (typeof m.role !== "string" || m.role.length === 0) return "message_role_invalid";
    if (typeof m.content !== "string" || m.content.length === 0) return "message_content_empty";
  }
  return null;
}

function readText(path: string, readFile?: ReadFile): string {
  return readFile ? readFile(path) : readFileSync(path, "utf8");
}

function parseManifest(text: string): { manifest?: ManifestShape; error?: string } {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { error: "manifest_not_object" };
    return { manifest: parsed as ManifestShape };
  } catch {
    return { error: "manifest_invalid_json" };
  }
}

export function verifyTrainingExportArtifacts(
  options: VerifyTrainingExportOptions,
): VerifyTrainingExportSummary {
  const read = options.readFile;
  const blocked = options.blockedSubstrings ?? [];
  const filesChecked: string[] = [];
  const errors: string[] = [];
  const caveats: string[] = [];
  const rows: Record<SplitName, number> = { train: 0, validation: 0, test: 0 };
  const rowHashes: Record<SplitName, string[]> = { train: [], validation: [], test: [] };
  let manifest: ManifestShape | undefined;

  try {
    const manifestPath = join(options.artifactDir, MANIFEST_FILE);
    filesChecked.push(MANIFEST_FILE);
    const parsed = parseManifest(readText(manifestPath, read));
    if (parsed.error) errors.push(parsed.error);
    manifest = parsed.manifest;
  } catch {
    errors.push("manifest_missing_or_unreadable");
  }

  for (const split of SPLITS) {
    const file = SPLIT_FILE(split);
    filesChecked.push(file);
    let text = "";
    try {
      text = readText(join(options.artifactDir, file), read);
    } catch {
      errors.push(`${split}:jsonl_missing_or_unreadable`);
      continue;
    }
    const lines = text.split("\n").filter((line) => line.length > 0);
    rows[split] = lines.length;
    lines.forEach((line, i) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        errors.push(`${split}:line_${i + 1}:invalid_json`);
        return;
      }
      const shapeError = validateMessagesRow(parsed);
      if (shapeError) errors.push(`${split}:line_${i + 1}:${shapeError}`);
      if (hasBlockedSubstring(line, blocked)) errors.push(`${split}:line_${i + 1}:blocked_substring_present`);
      rowHashes[split].push(sha256hex(stableStringify(parsed)));
    });
  }

  if (manifest?.split_counts) {
    for (const split of SPLITS) {
      const expected = manifest.split_counts[split];
      if (typeof expected === "number" && expected !== rows[split]) {
        errors.push(`${split}:manifest_count_mismatch`);
      }
    }
  } else if (manifest) {
    caveats.push("Manifest has no split_counts object.");
  }

  if (manifest?.row_entries) {
    for (const split of SPLITS) {
      const entries = manifest.row_entries[split] ?? [];
      if (entries.length !== rows[split]) {
        errors.push(`${split}:manifest_row_entries_count_mismatch`);
        continue;
      }
      entries.forEach((entry, i) => {
        if (typeof entry.hash !== "string") {
          errors.push(`${split}:entry_${i + 1}:hash_missing`);
        } else if (entry.hash !== rowHashes[split][i]) {
          errors.push(`${split}:entry_${i + 1}:hash_mismatch`);
        }
      });
    }
    const computedDatasetHash = sha256hex(stableStringify(manifest.row_entries));
    if (typeof manifest.dataset_hash === "string" && manifest.dataset_hash !== computedDatasetHash) {
      errors.push("manifest_dataset_hash_mismatch");
    }
  } else if (manifest) {
    caveats.push("Manifest has no row_entries object; row-level hashes were not checked.");
  }

  const excludedCount = Array.isArray(manifest?.excluded) ? manifest!.excluded!.length : 0;
  return {
    readiness: errors.length === 0 ? "ready" : "not_ready",
    filesChecked,
    datasetName: typeof manifest?.dataset_name === "string" ? manifest.dataset_name : undefined,
    datasetHashSuffix: safeSuffix(manifest?.dataset_hash),
    rows,
    excludedCount,
    errors,
    caveats,
  };
}

export function formatTrainingExportVerificationText(summary: VerifyTrainingExportSummary): string {
  const lines = [
    `Training export verification — ${summary.readiness === "ready" ? "READY" : "NOT READY"}`,
    "",
    `  dataset:       ${summary.datasetName ?? "unknown"}`,
    `  hash suffix:   ${summary.datasetHashSuffix ?? "n/a"}`,
    `  files checked: ${summary.filesChecked.length}`,
    `  rows:          train=${summary.rows.train} validation=${summary.rows.validation} test=${summary.rows.test}`,
    `  excluded:      ${summary.excludedCount}`,
  ];
  if (summary.errors.length) {
    lines.push("", "Errors:", ...summary.errors.map((e) => `  - ${e}`));
  }
  if (summary.caveats.length) {
    lines.push("", "Caveats:", ...summary.caveats.map((c) => `  - ${c}`));
  }
  return `${lines.join("\n")}\n`;
}

export function formatTrainingExportVerificationJson(summary: VerifyTrainingExportSummary): string {
  return `${JSON.stringify(summary, null, 2)}\n`;
}
