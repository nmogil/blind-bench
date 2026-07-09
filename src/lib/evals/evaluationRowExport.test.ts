import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  buildEvaluationRowExportBundle,
  formatEvaluationRowExportManifest,
  writeEvaluationRowExportBundle,
} from "./evaluationRowExport";

describe("EvaluationRow compatibility export", () => {
  test("builds deterministic non-empty EvaluationRow JSONL", () => {
    const a = buildEvaluationRowExportBundle();
    const b = buildEvaluationRowExportBundle();
    expect(a.manifest.row_count).toBeGreaterThan(0);
    expect(a.jsonl).toBe(b.jsonl);
    expect(a.manifest.dataset_hash).toBe(b.manifest.dataset_hash);
    const firstLine = a.jsonl.trim().split("\n")[0];
    expect(firstLine).toBeDefined();
    const first = JSON.parse(firstLine ?? "{}");
    expect(first.messages.length).toBeGreaterThan(1);
    expect(first.rollout_status).toBe("completed");
    expect(first.input_metadata.case_id).toMatch(/^demo-/);
    expect(first.eval_metadata.case_id).toBe(first.input_metadata.case_id);
  });

  test("manifest/report summary omits raw row content", () => {
    const bundle = buildEvaluationRowExportBundle();
    const firstRow = bundle.rows[0];
    expect(firstRow).toBeDefined();
    const firstMessage = firstRow === undefined ? undefined : firstRow.messages[0];
    expect(firstMessage).toBeDefined();
    const firstContent = firstMessage === undefined ? "" : firstMessage.content;
    const summary = formatEvaluationRowExportManifest(bundle.manifest) + bundle.reportMarkdown;
    expect(summary).not.toContain(firstContent);
    expect(summary).toContain("evaluation_row_jsonl");
    expect(summary).toContain("Eval Protocol runtime");
  });

  test("writes jsonl, manifest, and report artifacts", () => {
    const dir = mkdtempSync(join(tmpdir(), "evaluation-row-export-"));
    const bundle = buildEvaluationRowExportBundle();
    writeEvaluationRowExportBundle(bundle, dir);
    expect(readFileSync(join(dir, "evaluation-rows.jsonl"), "utf8")).toBe(bundle.jsonl);
    const manifest = JSON.parse(readFileSync(join(dir, "evaluation-rows.manifest.json"), "utf8"));
    expect(manifest.row_count).toBe(bundle.manifest.row_count);
    expect(readFileSync(join(dir, "evaluation-rows.report.md"), "utf8")).toContain("EvaluationRow compatibility export");
  });
});
