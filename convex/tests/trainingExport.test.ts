import { describe, expect, test } from "vitest";
import {
  buildExportManifest,
  gateRows,
  TRAINING_EXPORT_LIMITS,
  trainingExportSizeViolation,
  serializeAgentObservableEvent,
  serializeAgentObservableTrajectoryContext,
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

describe("#287 bounded export limits", () => {
  test.each([
    ["candidates", "maxCandidates"],
    ["projectionBytes", "maxProjectionBytes"],
    ["rowBytes", "maxRowBytes"],
    ["jsonlBytes", "maxJsonlBytes"],
    ["manifestBytes", "maxManifestBytes"],
  ] as const)("accepts %s exactly at its cap and rejects one byte/item above", (field, limitField) => {
    const limit = TRAINING_EXPORT_LIMITS[limitField];
    expect(trainingExportSizeViolation({ [field]: limit })).toBeNull();
    expect(trainingExportSizeViolation({ [field]: limit + 1 })).toBe(field);
  });
});

describe("#287 agent-observable trajectory serialization", () => {
  test("allowlists inference-time context and cuts chronology at terminal final output", () => {
    const context = serializeAgentObservableTrajectoryContext({
      taskPrompt: "Fix the widget.",
      events: [
        { sequence: 0, kind: "user_message", role: "user", content: "Fix it." },
        { sequence: 1, kind: "assistant_reasoning", content: "private reasoning" },
        { sequence: 2, kind: "assistant_message", role: "assistant", content: "I will inspect." },
        { sequence: 3, kind: "tool_call", callId: "operation-1", toolName: "read_file", arguments: { path: "widget.ts" } },
        { sequence: 4, kind: "tool_result", callId: "operation-1", toolName: "read_file", result: { text: "source" } },
        { sequence: 5, kind: "workspace_change", content: "post-hoc changed files" },
        { sequence: 6, kind: "verifier_result", content: "oracle passed" },
        { sequence: 7, kind: "reward", content: "reward=1" },
        { sequence: 8, kind: "policy_event", content: "post-hoc policy" },
        { sequence: 9, kind: "final_output", content: "Fixed." },
        { sequence: 10, kind: "user_message", role: "user", content: "must not appear after final" },
        { sequence: 11, kind: "termination", content: "completed" },
      ],
    });
    expect(context).toContain("Fix the widget.");
    expect(context).toContain("I will inspect.");
    expect(context).toContain("read_file");
    expect(context).toContain("source");
    expect(context).not.toContain("operation-1");
    expect(context).not.toMatch(/private reasoning|workspace_change|changed files|verifier|oracle|reward|policy|final_output|must not appear|termination/);
    expect(context).not.toMatch(/objective_outcomes|infrastructure|succeeded|passed/);
  });

  test.each(["assistant_reasoning", "verifier_result", "workspace_change", "policy_event", "outcome", "reward", "lifecycle", "termination", "final_output"])(
    "rejects %s as a DPO chosen/rejected action",
    (kind) => expect(serializeAgentObservableEvent({ sequence: 1, kind, content: "oracle" })).toBeNull(),
  );
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

  test("canary or private provenance markers are excluded even from public rows", () => {
    const { included, excluded } = gateRows([
      { row: dpo({ chosen: "HIDDEN_VERIFIER_CANARY_BLOCKING_123" }), privacyClass: "public" },
      { row: dpo({ chosen: "analysis_metadata: private" }), privacyClass: "public" },
    ]);
    expect(included).toHaveLength(0);
    expect(excluded.map((row) => row.reason)).toEqual(["canary_or_private_leak", "canary_or_private_leak"]);
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

  test("invalid SFT roles or a missing final assistant turn are excluded", () => {
    const rows: ClassifiedRow[] = [
      { row: { kind: "sft", messages: [{ role: "developer", content: "x" }, { role: "assistant", content: "ok" }] }, privacyClass: "public" },
      { row: { kind: "sft", messages: [{ role: "user", content: "unfinished" }] }, privacyClass: "public" },
    ];
    const { included, excluded } = gateRows(rows);
    expect(included).toHaveLength(0);
    expect(excluded.map((row) => row.reason)).toEqual(["invalid_sft_shape", "invalid_sft_shape"]);
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
    expect(JSON.parse(lines[1]!)).not.toHaveProperty("metadata");
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
    expect(manifest.version).toBe(2);
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
