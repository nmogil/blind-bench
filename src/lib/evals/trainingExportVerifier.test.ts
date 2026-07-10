import { describe, expect, test } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SPLITS,
  compileTrainingDataset,
  demoTrainingSourceRows,
  formatManifest,
  toJsonl,
} from "./trainingDataset";
import {
  formatTrainingExportVerificationJson,
  formatTrainingExportVerificationText,
  verifyTrainingExportArtifacts,
} from "./trainingExportVerifier";

function writeExportDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "training-export-verifier-"));
  mkdirSync(dir, { recursive: true });
  const { splits, manifest } = compileTrainingDataset(demoTrainingSourceRows(), {
    generated_at: "2026-01-01T00:00:00Z",
    dataset_name: "training-dataset",
  });
  for (const split of SPLITS) writeFileSync(join(dir, `training-dataset.${split}.jsonl`), toJsonl(splits[split]));
  writeFileSync(join(dir, "training-dataset.manifest.json"), formatManifest(manifest));
  return dir;
}

describe("training export verifier", () => {
  test("accepts compiler-generated artifacts and prints safe summaries", () => {
    const dir = writeExportDir();
    const summary = verifyTrainingExportArtifacts({ artifactDir: dir });
    expect(summary.readiness).toBe("ready");
    expect(summary.errors).toEqual([]);
    expect(summary.rows.train + summary.rows.validation + summary.rows.test).toBeGreaterThan(0);
    expect(summary.datasetName).toBe("training-dataset");
    expect(summary.datasetHashSuffix?.startsWith("…")).toBe(true);
    expect(formatTrainingExportVerificationText(summary)).toContain("Training export verification — READY");
  });

  test("fails count and hash mismatches without printing row content", () => {
    const dir = writeExportDir();
    const manifestPath = join(dir, "training-dataset.manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.split_counts.train += 1;
    manifest.row_entries.validation[0].hash = "0".repeat(64);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const summary = verifyTrainingExportArtifacts({ artifactDir: dir });
    expect(summary.readiness).toBe("not_ready");
    expect(summary.errors).toContain("train:manifest_count_mismatch");
    expect(summary.errors).toContain("validation:entry_1:hash_mismatch");
    const text = formatTrainingExportVerificationText(summary);
    expect(text).not.toContain("Synthetic safe completion");
    expect(text).not.toContain("messages");
  });

  test("fails invalid JSONL and empty message content", () => {
    const dir = writeExportDir();
    writeFileSync(join(dir, "training-dataset.test.jsonl"), `{"messages":[{"role":"user","content":""}]}\n{bad json}\n`);
    const summary = verifyTrainingExportArtifacts({ artifactDir: dir });
    expect(summary.readiness).toBe("not_ready");
    expect(summary.errors).toContain("test:line_1:message_content_empty");
    expect(summary.errors).toContain("test:line_2:invalid_json");
  });

  test("requires manifest count and row-hash bindings", () => {
    const dir = writeExportDir();
    const manifestPath = join(dir, "training-dataset.manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    delete manifest.split_counts;
    delete manifest.row_entries;
    writeFileSync(manifestPath, JSON.stringify(manifest));

    const summary = verifyTrainingExportArtifacts({ artifactDir: dir });
    expect(summary.readiness).toBe("not_ready");
    expect(summary.errors).toContain("manifest_split_counts_missing");
    expect(summary.errors).toContain("manifest_row_entries_missing");
  });

  test("requires supported roles and a final assistant completion", () => {
    const dir = writeExportDir();
    writeFileSync(
      join(dir, "training-dataset.test.jsonl"),
      `${JSON.stringify({ messages: [{ role: "developer", content: "unsupported" }, { role: "user", content: "unfinished" }] })}\n`,
    );
    const summary = verifyTrainingExportArtifacts({ artifactDir: dir });
    expect(summary.readiness).toBe("not_ready");
    expect(summary.errors).toContain("test:line_1:message_role_unsupported");
    expect(summary.errors).toContain("test:line_1:final_message_not_assistant");
  });

  test("blocks forbidden substrings without echoing the substring in text or JSON", () => {
    const dir = writeExportDir();
    const forbidden = "TOKEN_DO_NOT_PRINT_123456";
    writeFileSync(join(dir, "training-dataset.train.jsonl"), `{"messages":[{"role":"user","content":"${forbidden}"}]}\n`);
    const summary = verifyTrainingExportArtifacts({ artifactDir: dir, blockedSubstrings: [forbidden] });
    expect(summary.readiness).toBe("not_ready");
    expect(summary.errors).toContain("train:line_1:blocked_substring_present");
    expect(formatTrainingExportVerificationText(summary)).not.toContain(forbidden);
    expect(formatTrainingExportVerificationJson(summary)).not.toContain(forbidden);
  });
});
