import { describe, expect, it } from "vitest";
import { EvalCase, type EvalCase as EvalCaseT } from "./evalCase";
import { demoSmokeCases } from "./packs/demoPack";
import {
  PromotionPolicy,
  ReviewDecision,
  approveForTraining,
  canApproveForTraining,
  canPromoteToRegression,
  promoteToRegression,
  type PromotionPolicyInput,
  type ReviewOutcome,
} from "./reviewWorkflow";

// A synthetic reviewed case + reviewer — no real customer data anywhere.
const syntheticCase = (): EvalCaseT =>
  EvalCase.parse(demoSmokeCases[0]);

const review = (
  outcome: ReviewOutcome,
  over: Partial<ReturnType<typeof ReviewDecision.parse>> = {},
) =>
  ReviewDecision.parse({
    case_id: "demo-docs-renewal-00",
    reviewer_id: "reviewer-TEST-1",
    outcome,
    reason_tag: "looks_correct",
    reviewed_at: "2026-06-24T00:00:00Z",
    ...over,
  });

const policy = (over: Partial<PromotionPolicyInput>) =>
  PromotionPolicy.parse({ classification: "synthetic", ...over });

describe("regression promotion", () => {
  for (const outcome of ["pass", "fail"] as const) {
    it(`promotes a ${outcome}-labeled synthetic case when the gate is open`, () => {
      const c = syntheticCase();
      const r = review(outcome);
      const p = policy({ regression_allowed: true, review_allowed: true });
      expect(canPromoteToRegression(r, p)).toBe(true);
      const cand = promoteToRegression(c, r, p, "2026-06-24T01:00:00Z");
      expect(cand.kind).toBe("regression");
      expect(cand.source_case_id).toBe(c.id);
      expect(cand.classification).toBe("synthetic");
      expect(cand.promoted_at).toBe("2026-06-24T01:00:00Z");
    });
  }

  it("refuses to promote when the review gate is closed (default-deny)", () => {
    const p = policy({ regression_allowed: true });
    expect(canPromoteToRegression(review("pass"), p)).toBe(false);
    expect(() => promoteToRegression(syntheticCase(), review("pass"), p)).toThrow(
      /review gate not granted/,
    );
  });

  it("refuses to promote when the regression gate is closed", () => {
    const p = policy({ review_allowed: true });
    expect(canPromoteToRegression(review("pass"), p)).toBe(false);
    expect(() => promoteToRegression(syntheticCase(), review("pass"), p)).toThrow(
      /regression gate not granted/,
    );
  });

  it("ignored cases cannot promote even with the gate open", () => {
    const p = policy({ regression_allowed: true, review_allowed: true });
    expect(canPromoteToRegression(review("ignore"), p)).toBe(false);
    expect(() =>
      promoteToRegression(syntheticCase(), review("ignore"), p),
    ).toThrow(/ignored/);
  });

  it("prod_sensitive cannot promote; caller must reclassify redacted data first", () => {
    const blocked = policy({
      classification: "prod_sensitive",
      regression_allowed: true, review_allowed: true,
    });
    expect(canPromoteToRegression(review("pass"), blocked)).toBe(false);
    expect(() =>
      promoteToRegression(syntheticCase(), review("pass"), blocked),
    ).toThrow(/redacted and reclassified/);

    const allowed = policy({
      classification: "redacted_prod",
      regression_allowed: true, review_allowed: true,
    });
    expect(canPromoteToRegression(review("pass"), allowed)).toBe(true);

    const trainingOnly = policy({
      classification: "training_approved",
      regression_allowed: true, review_allowed: true,
    });
    expect(canPromoteToRegression(review("pass"), trainingOnly)).toBe(false);
    expect(() =>
      promoteToRegression(syntheticCase(), review("pass"), trainingOnly),
    ).toThrow(/not eligible for regression/);
  });

  it("rejects a synthetic classification for a non-synthetic source case", () => {
    const c = syntheticCase();
    c.source = "production_log";
    expect(() =>
      promoteToRegression(c, review("pass"), policy({ classification: "synthetic", regression_allowed: true, review_allowed: true })),
    ).toThrow(/synthetic classification/);
  });
});

describe("training export approval", () => {
  it("requires both training_approved classification and the training gate", () => {
    const r = review("pass");
    // synthetic is never training-approved by default
    expect(canApproveForTraining(r, policy({ training_allowed: true, review_allowed: true }))).toBe(
      false,
    );
    // right class but gate closed
    expect(
      canApproveForTraining(r, policy({ classification: "training_approved", review_allowed: true })),
    ).toBe(false);
    // both satisfied
    const ok = policy({
      classification: "training_approved",
      review_allowed: true,
      training_allowed: true,
    });
    expect(canApproveForTraining(r, ok)).toBe(true);
    const cand = approveForTraining(syntheticCase(), r, ok, "2026-06-24T02:00:00Z");
    expect(cand.kind).toBe("training_export");
    expect(cand.approver).toBe("reviewer-TEST-1");
    expect(cand.approved_at).toBe("2026-06-24T02:00:00Z");
  });

  it("ignored cases cannot be approved for training", () => {
    const ok = policy({
      classification: "training_approved",
      review_allowed: true,
      training_allowed: true,
    });
    expect(canApproveForTraining(review("ignore"), ok)).toBe(false);
    expect(() =>
      approveForTraining(syntheticCase(), review("ignore"), ok),
    ).toThrow(/ignored/);
  });
});

describe("promotion freezes the snapshot", () => {
  it("is independent from later mutation of the source case", () => {
    const c = syntheticCase();
    const r = review("pass");
    const cand = promoteToRegression(
      c,
      r,
      policy({ regression_allowed: true, review_allowed: true }),
    );
    const before = cand.snapshot.expected.must.slice();

    // Mutate the original after promotion.
    c.expected.must.push("a brand new requirement");
    c.input.variables = { tampered: true };
    r.notes = "mutated after promotion";

    expect(cand.snapshot.expected.must).toEqual(before);
    expect(cand.snapshot.input).not.toHaveProperty("variables.tampered");
    expect(cand.review.notes).not.toBe("mutated after promotion");
    // snapshot and candidate are frozen, so writes throw in strict mode / are no-ops otherwise
    expect(Object.isFrozen(cand)).toBe(true);
    expect(Object.isFrozen(cand.snapshot)).toBe(true);
    expect(Object.isFrozen(cand.snapshot.expected.must)).toBe(true);
  });
});

describe("fixtures carry no real customer data", () => {
  it("uses only synthetic TEST identifiers", () => {
    const blob = JSON.stringify({
      review: review("pass"),
      cand: promoteToRegression(
        syntheticCase(),
        review("pass"),
        policy({ regression_allowed: true, review_allowed: true }),
      ),
    });
    expect(blob).toMatch(/TEST/);
    expect(blob).not.toMatch(/\b\d{3}-\d{2}-\d{4}\b/); // no SSN-shaped strings
    expect(blob).not.toMatch(/@/); // no emails
  });
});
