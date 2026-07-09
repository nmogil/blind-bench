import { describe, expect, test } from "vitest";
import {
  buildExportManifest,
  gateRows,
  toJsonl,
  type ClassifiedRow,
  type ExportRow,
} from "../lib/trainingExport";

const dpo = (over: Partial<Record<string, string>> = {}): ExportRow => ({
  kind: "dpo",
  prompt: over.prompt ?? "resolve the ticket",
  chosen: over.chosen ?? "escalated appropriately",
  rejected: over.rejected ?? "ignored the request",
  metadata: { evaluator_count: 2 },
});

describe("#53 training-export data-boundary gate", () => {
  test("sensitive classes are excluded by default, admitted only with explicit consent", () => {
    const rows: ClassifiedRow[] = [
      { row: dpo(), privacyClass: "internal" },
      { row: dpo(), privacyClass: "pii" },
      { row: dpo(), privacyClass: "phi" },
    ];
    const denied = gateRows(rows);
    expect(denied.included).toHaveLength(1);
    expect(denied.excluded.map((e) => e.reason)).toEqual(["prod_sensitive", "prod_sensitive"]);

    const consented = gateRows(rows, { allowSensitive: true });
    expect(consented.included).toHaveLength(3);
  });

  test("pii-leak scan excludes rows whose text leaks email or api keys, even if class-allowed", () => {
    const rows: ClassifiedRow[] = [
      { row: dpo({ rejected: "contact me at agent@example.com" }), privacyClass: "public" },
      { row: dpo({ chosen: "the key is sk-abcdef0123456789ABCDEF" }), privacyClass: "public" },
      { row: dpo(), privacyClass: "public" },
    ];
    const { included, excluded } = gateRows(rows);
    expect(included).toHaveLength(1);
    expect(excluded.every((e) => e.reason === "pii_leak")).toBe(true);
  });

  test("degenerate DPO pairs (chosen === rejected) are excluded — no training signal", () => {
    const rows: ClassifiedRow[] = [
      { row: dpo({ chosen: "same action", rejected: "same action" }), privacyClass: "public" },
      { row: dpo({ chosen: "better", rejected: "worse" }), privacyClass: "public" },
    ];
    const { included, excluded } = gateRows(rows);
    expect(included).toHaveLength(1);
    expect(excluded[0]?.reason).toBe("degenerate");
  });

  test("empty rows are excluded with a reason, never silently dropped", () => {
    const rows: ClassifiedRow[] = [
      { row: dpo({ chosen: "   " }), privacyClass: "public" },
    ];
    const { included, excluded } = gateRows(rows);
    expect(included).toHaveLength(0);
    expect(excluded[0]?.reason).toBe("empty");
  });
});

describe("#53 JSONL serializers produce valid, parseable output", () => {
  test("dpo", () => {
    const out = toJsonl("dpo", [dpo()]);
    const parsed = JSON.parse(out);
    expect(parsed).toMatchObject({ prompt: expect.any(String), chosen: expect.any(String), rejected: expect.any(String), metadata: expect.any(Object) });
    expect(Object.keys(parsed).sort()).toEqual(["chosen", "metadata", "prompt", "rejected"]);
  });

  test("annotated", () => {
    const row: ExportRow = {
      kind: "annotated",
      prompt: "p",
      output: "o",
      annotations: [{ from: 0, to: 3, text: "abc", comment: "off tone", tags: ["tone"] }],
      preference: "weak",
      metadata: {},
    };
    const parsed = JSON.parse(toJsonl("annotated", [row]));
    expect(parsed.annotations[0]).toMatchObject({ from: 0, to: 3, comment: "off tone", tags: ["tone"] });
    expect(parsed.preference).toBe("weak");
  });

  test("sft omits metadata when absent; multi-row is newline-delimited", () => {
    const rows: ExportRow[] = [
      { kind: "sft", messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }] },
      { kind: "sft", messages: [{ role: "user", content: "bye" }, { role: "assistant", content: "later" }], metadata: { preference: "best" } },
    ];
    const out = toJsonl("sft", rows);
    const lines = out.split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).not.toHaveProperty("metadata");
    expect(JSON.parse(lines[1]!).metadata).toEqual({ preference: "best" });
    // valid JSONL: every line parses
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
  });
});

describe("#288 export manifest (Fireworks handoff report)", () => {
  test("carries schema/version, source/format, counts, gate, and provenance", () => {
    const rows: ClassifiedRow[] = [
      { row: dpo(), privacyClass: "internal" },
      { row: dpo({ chosen: "same", rejected: "same" }), privacyClass: "public" }, // degenerate
      { row: dpo(), privacyClass: "pii" }, // prod_sensitive (default-deny)
    ];
    const { included, excluded } = gateRows(rows);
    const manifest = buildExportManifest({
      source: "output_preference",
      format: "dpo",
      included,
      excluded,
      allowSensitive: false,
      stats: { sourceUnits: 3, reviewers: 2 },
      generatedAt: 1_700_000_000_000,
    });

    expect(manifest.schema).toBe("blindbench.training-export");
    expect(manifest.version).toBe(1);
    expect(manifest).toMatchObject({ source: "output_preference", format: "dpo" });
    expect(manifest.row_count).toBe(included.length);
    expect(manifest.excluded_count).toBe(excluded.length);
    expect(manifest.excluded_by_reason).toMatchObject({ degenerate: 1, prod_sensitive: 1 });
    expect(manifest.sensitivity_gate).toEqual({
      allow_sensitive: false,
      default_deny_classes: ["confidential", "pii", "phi"],
    });
    expect(manifest.source_units).toBe(3);
    expect(manifest.reviewers).toBe(2);
    expect(manifest.fireworks).toEqual({ compatible: true, row_shape: "prompt/chosen/rejected" });
    // never echo raw counts of ids — provenance is aggregate only
    expect(manifest.notes.join(" ")).toContain("anonymized by construction");
  });

  test("dpo with zero comparable pairs gets an explicit 'no pairs' note, not a silent empty", () => {
    const { included, excluded } = gateRows([
      { row: dpo({ chosen: "same", rejected: "same" }), privacyClass: "public" },
    ]);
    const manifest = buildExportManifest({
      source: "trajectory",
      format: "dpo",
      included,
      excluded,
      allowSensitive: false,
      stats: { sourceUnits: 0, reviewers: 0 },
      generatedAt: 0,
    });
    expect(manifest.row_count).toBe(0);
    expect(manifest.notes.some((n) => n.includes("No comparable preference pairs"))).toBe(true);
  });

  test("sft manifest documents the Fireworks chat row shape", () => {
    const manifest = buildExportManifest({
      source: "trajectory",
      format: "sft",
      included: [{ kind: "sft", messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "ok" }] }],
      excluded: [],
      allowSensitive: false,
      stats: { sourceUnits: 1, reviewers: 1 },
      generatedAt: 0,
    });
    expect(manifest.fireworks.row_shape).toBe("messages[]");
    expect(manifest.notes.some((n) => n.includes("messages"))).toBe(true);
  });
});
