import { describe, expect, it } from "vitest";
import { EvalCase } from "./evalCase";
import { customerPilotSmokeCases } from "./packs/customerPilot";
import {
  PromotionPolicy,
  ReviewDecision,
  approveForTraining,
  type TrainingExportCandidate,
} from "./reviewWorkflow";
import {
  SPLITS,
  compileTrainingDataset,
  customerPilotTrainingSourceRows,
  formatManifest,
  toJsonl,
  type TrainingDatasetSourceRow,
} from "./trainingDataset";

const GENERATED_AT = "2026-01-01T00:00:00Z";

// Approve a synthetic case for training and wrap it as a source row.
function syntheticRow(
  i: number,
  over: Partial<TrainingDatasetSourceRow> = {},
): TrainingDatasetSourceRow {
  const c = EvalCase.parse(customerPilotSmokeCases[i]);
  const candidate = approveForTraining(
    c,
    ReviewDecision.parse({
      case_id: c.id,
      reviewer_id: "reviewer-TEST-1",
      outcome: "pass",
      reason_tag: "approved_for_training",
    }),
    PromotionPolicy.parse({
      classification: "training_approved",
      review_allowed: true,
      training_allowed: true,
    }),
    GENERATED_AT,
  );
  return {
    candidate,
    source: c.source,
    assistant_output: `Synthetic safe completion for ${c.id}.`,
    metrics: { score: 1, rating: 5 },
    ...over,
  };
}

const compile = (rows: TrainingDatasetSourceRow[], opts = {}) =>
  compileTrainingDataset(rows, { generated_at: GENERATED_AT, ...opts });

describe("training approval gates", () => {
  it("exports training_approved synthetic rows", () => {
    const { manifest, splits } = compile([syntheticRow(0)]);
    const total = SPLITS.reduce((n, s) => n + splits[s].length, 0);
    expect(total).toBe(1);
    expect(manifest.excluded).toEqual([]);
    expect(manifest.classifications).toEqual(["training_approved"]);
  });

  it("blocks prod_sensitive candidates by construction", () => {
    // Hand-built candidate (approveForTraining would never emit prod_sensitive).
    const base = syntheticRow(0);
    const candidate: TrainingExportCandidate = {
      ...base.candidate,
      classification: "prod_sensitive",
    };
    const { manifest, splits } = compile([{ ...base, candidate, source: "production_log" }]);
    expect(SPLITS.every((s) => splits[s].length === 0)).toBe(true);
    expect(manifest.excluded).toEqual([
      { case_id: base.candidate.source_case_id, reason: "prod_sensitive_blocked" },
    ]);
  });

  it("excludes unapproved production rows unless policy approval is explicit", () => {
    const row = syntheticRow(1, { source: "production_log" });
    expect(compile([row]).manifest.excluded[0]?.reason).toBe(
      "training_approved_export_not_policy_approved",
    );
    // Explicit policy approval lets it through.
    const ok = compile([row], { allow_training_approved_export: true });
    expect(ok.manifest.excluded).toEqual([]);
    expect(SPLITS.reduce((n, s) => n + ok.splits[s].length, 0)).toBe(1);
  });
});

describe("eval-set contamination prevention", () => {
  it("keeps held-out rows out of train/validation, test only when allowed", () => {
    // eval_only without allow_in_test → excluded everywhere.
    const blocked = compile([syntheticRow(0, { eval_only: true, split_hint: "train" })]);
    expect(blocked.splits.train).toEqual([]);
    expect(blocked.manifest.excluded[0]?.reason).toBe("held_out_eval_only_excluded");

    // eval_only + allow_in_test → test ONLY, never train/validation, ignoring split_hint.
    const allowed = compile([syntheticRow(0, { eval_only: true, allow_in_test: true, split_hint: "train" })]);
    expect(allowed.splits.train).toEqual([]);
    expect(allowed.splits.validation).toEqual([]);
    expect(allowed.splits.test).toHaveLength(1);
  });
});

describe("deterministic splits + manifest", () => {
  it("produces identical splits, hashes, and JSONL across runs", () => {
    const rows = customerPilotTrainingSourceRows();
    const a = compile(rows);
    const b = compile(rows);
    expect(a.manifest.dataset_hash).toBe(b.manifest.dataset_hash);
    expect(a.manifest.split_counts).toEqual(b.manifest.split_counts);
    for (const s of SPLITS) expect(toJsonl(a.splits[s])).toBe(toJsonl(b.splits[s]));
  });

  it("every held-out pilot row lands in test, never train/validation", () => {
    const { splits } = compile(customerPilotTrainingSourceRows());
    const heldOut = customerPilotTrainingSourceRows()
      .filter((r) => r.eval_only)
      .map((r) => r.candidate.source_case_id);
    const trainVal = [...splits.train, ...splits.validation].map((r) => r.metadata.case_id);
    expect(heldOut.length).toBeGreaterThan(0);
    expect(heldOut.some((id) => trainVal.includes(id))).toBe(false);
  });

  it("manifest counts reconcile with split sizes and source rows", () => {
    const rows = customerPilotTrainingSourceRows();
    const { manifest, splits } = compile(rows);
    const exported = SPLITS.reduce((n, s) => n + splits[s].length, 0);
    expect(exported + manifest.excluded.length).toBe(rows.length);
    for (const s of SPLITS) expect(manifest.split_counts[s]).toBe(splits[s].length);
  });
});

describe("filters", () => {
  it("filters by product and min_rating", () => {
    const rows = customerPilotTrainingSourceRows();
    const { manifest } = compile(rows, { filters: { products: ["migo"] } });
    expect(manifest.products).toEqual(["migo"]);
    expect(manifest.excluded.some((e) => e.reason === "filtered_out:product")).toBe(true);

    const lowRating = compile([syntheticRow(0, { metrics: { rating: 2 } })], {
      filters: { min_rating: 4 },
    });
    expect(lowRating.manifest.excluded[0]?.reason).toBe("filtered_out:min_rating");
  });
});

describe("output safety", () => {
  it("emits messages-only JSONL that is valid JSON, no sidecar metadata inline", () => {
    const { splits } = compile(customerPilotTrainingSourceRows());
    const blob = SPLITS.map((s) => toJsonl(splits[s])).join("");
    for (const line of blob.split("\n").filter(Boolean)) {
      const row = JSON.parse(line); // throws if not strictly valid JSON
      expect(Object.keys(row)).toEqual(["messages"]); // Fireworks chat/SFT shape only
      expect(Array.isArray(row.messages)).toBe(true);
      expect(row.messages.at(-1).role).toBe("assistant");
      expect(row.metadata).toBeUndefined(); // metadata lives in the manifest
    }
  });

  it("serializes valid JSONL even when approved_at/variant/customer_scope are absent", () => {
    // A row missing every optional metadata field — the stableStringify undefined bug.
    const base = syntheticRow(0);
    const candidate: TrainingExportCandidate = { ...base.candidate, approved_at: undefined as never };
    const { splits, manifest } = compile([
      { ...base, candidate, variant: undefined, customer_scope: undefined },
    ]);
    const blob = SPLITS.map((s) => toJsonl(splits[s])).join("");
    expect(blob).not.toContain("undefined"); // would appear if stableStringify hit an undefined value
    for (const line of blob.split("\n").filter(Boolean)) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    // Manifest is valid JSON too (JSON.stringify drops the absent optional keys).
    const entry = SPLITS.flatMap((s) => manifest.row_entries[s])[0];
    expect(entry?.approved_at).toBeUndefined();
    expect(JSON.parse(formatManifest(manifest)).split_counts).toBeDefined();
  });

  it("blocks rows containing a forbidden sentinel and keeps it out of the JSONL", () => {
    const dirty = syntheticRow(1, {
      assistant_output: "Sure — the cross-tenant id is OTHER-7777, balance overdue.",
    });
    const clean = syntheticRow(2);
    const { splits, manifest } = compile([dirty, clean], {
      blocked_substrings: ["OTHER-7777", "overdue"],
    });
    // Dirty row excluded and reported; clean row exported.
    expect(manifest.excluded).toContainEqual({
      case_id: dirty.candidate.source_case_id,
      reason: "forbidden_substring_blocked",
    });
    expect(SPLITS.reduce((n, s) => n + splits[s].length, 0)).toBe(1);
    // The sentinel never reaches the JSONL.
    const blob = SPLITS.map((s) => toJsonl(splits[s])).join("");
    expect(blob).not.toContain("OTHER-7777");
    expect(blob).not.toContain("overdue");
  });
});

describe("split ratio validation", () => {
  it("rejects negative, non-finite, or oversized ratios", () => {
    const rows = [syntheticRow(0)];
    expect(() => compile(rows, { splits: { train: -0.1, validation: 0.1 } })).toThrow(/non-negative/);
    expect(() => compile(rows, { splits: { train: NaN, validation: 0.1 } })).toThrow(/finite/);
    expect(() => compile(rows, { splits: { train: Infinity, validation: 0 } })).toThrow(/finite/);
    expect(() => compile(rows, { splits: { train: 0.8, validation: 0.5 } })).toThrow(/<= 1/);
    // Sum == 1 is allowed (intentionally empty test split).
    expect(() => compile(rows, { splits: { train: 0.7, validation: 0.3 } })).not.toThrow();
  });
});
