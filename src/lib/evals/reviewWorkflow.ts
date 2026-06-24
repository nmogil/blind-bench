/**
 * Minimal local human-review → promotion workflow (issue #234, non-UI slice).
 *
 * Turns a reviewed eval case into either a frozen customer-scoped regression
 * candidate or a training-export candidate, gated by the data-classification /
 * consent model in `docs/tenancy-consent-data-isolation.md`. Default-deny: a
 * missing gate is treated as denied.
 *
 * Pure functions only — no UI, no persistence, no network. The caller supplies
 * `promoted_at` / `approved_at` so promotion is deterministic and testable.
 */
import { z } from "zod/v4";
import { EvidenceSpan, type EvalCase } from "./evalCase";

// --- Review label ------------------------------------------------------------

/**
 * Reviewer verdict. `ignore` marks a case the reviewer explicitly declines to
 * promote (noise/dupe/out-of-scope); the pairwise verdicts (`better`/`worse`/
 * `tie`) support A-vs-B comparisons. Only `ignore` blocks promotion.
 */
export const ReviewOutcome = z.enum([
  "pass",
  "fail",
  "better",
  "worse",
  "tie",
  "ignore",
]);
export type ReviewOutcome = z.infer<typeof ReviewOutcome>;

export const ReviewDecision = z.object({
  /** Eval case (or trace) being reviewed. */
  case_id: z.string(),
  /** Reviewer identity; synthetic/test ids are fine for fixtures. */
  reviewer_id: z.string(),
  outcome: ReviewOutcome,
  /** Stable categorical reason, e.g. "hallucinated_amount", "good_escalation". */
  reason_tag: z.string(),
  notes: z.string().optional(),
  /** ISO-8601; set by the caller, not derived here. */
  reviewed_at: z.string().optional(),
  /** Optional citations supporting the verdict, reusing the scorer EvidenceSpan. */
  evidence_spans: z.array(EvidenceSpan).optional(),
});
export type ReviewDecision = z.infer<typeof ReviewDecision>;

// --- Data classification + consent gates -------------------------------------

/** Mirrors docs/tenancy-consent-data-isolation.md. */
export const DataClassification = z.enum([
  "synthetic",
  "redacted_prod",
  "prod_sensitive",
  "training_approved",
]);
export type DataClassification = z.infer<typeof DataClassification>;

/**
 * Per-source consent gates. Booleans default to `false` (default-deny).
 * Redaction must happen before this module sees a case. A source that is still
 * `prod_sensitive` cannot be promoted into regression; classify the redacted
 * result as `redacted_prod` first.
 */
export const PromotionPolicy = z.object({
  classification: DataClassification,
  review_allowed: z.boolean().default(false),
  regression_allowed: z.boolean().default(false),
  training_allowed: z.boolean().default(false),
});
export type PromotionPolicy = z.infer<typeof PromotionPolicy>;
export type PromotionPolicyInput = z.input<typeof PromotionPolicy>;

// --- Promotion result rows ---------------------------------------------------

/** Frozen copy of the parts of an eval case a regression must pin. */
export interface CaseSnapshot {
  input: EvalCase["input"];
  expected: EvalCase["expected"];
  scorer_assignments: EvalCase["scorer_assignments"];
  metadata: EvalCase["metadata"];
}

export interface RegressionCandidate {
  kind: "regression";
  source_case_id: string;
  product: string;
  classification: DataClassification;
  review: ReviewDecision;
  /** Deep-frozen so later mutation of the source case can't change the dataset. */
  snapshot: CaseSnapshot;
  promoted_at?: string;
}

export interface TrainingExportCandidate {
  kind: "training_export";
  source_case_id: string;
  product: string;
  classification: DataClassification;
  approver: string;
  review: ReviewDecision;
  snapshot: CaseSnapshot;
  approved_at?: string;
}

// --- Gates -------------------------------------------------------------------

const isReviewed = (review: ReviewDecision) => review.outcome !== "ignore";

/**
 * Why a regression promotion is denied, or null if allowed. Public so a CLI can
 * surface the reason without a try/catch.
 */
export function regressionDenialReason(
  review: ReviewDecision,
  policy: PromotionPolicy,
): string | null {
  if (!isReviewed(review)) return "case is ignored or unreviewed";
  if (!policy.review_allowed) return "review gate not granted";
  if (!policy.regression_allowed) return "regression gate not granted";
  if (policy.classification === "prod_sensitive")
    return "prod_sensitive source must be redacted and reclassified before promotion";
  if (policy.classification !== "synthetic" && policy.classification !== "redacted_prod")
    return "classification not eligible for regression; use synthetic or redacted_prod";
  return null;
}

export const canPromoteToRegression = (
  review: ReviewDecision,
  policy: PromotionPolicy,
): boolean => regressionDenialReason(review, policy) === null;

/** Why a training approval is denied, or null if allowed. */
export function trainingDenialReason(
  review: ReviewDecision,
  policy: PromotionPolicy,
): string | null {
  if (!isReviewed(review)) return "case is ignored or unreviewed";
  if (!policy.review_allowed) return "review gate not granted";
  if (!policy.training_allowed) return "training gate not granted";
  if (policy.classification !== "training_approved")
    return "data is not classified training_approved";
  return null;
}

export const canApproveForTraining = (
  review: ReviewDecision,
  policy: PromotionPolicy,
): boolean => trainingDenialReason(review, policy) === null;

// --- Promotion ---------------------------------------------------------------

/** Deep-clone then recursively freeze, so the snapshot is immutable + detached. */
function frozenSnapshot(evalCase: EvalCase): CaseSnapshot {
  return deepFreeze({
    input: structuredClone(evalCase.input),
    expected: structuredClone(evalCase.expected),
    scorer_assignments: structuredClone(evalCase.scorer_assignments),
    metadata: structuredClone(evalCase.metadata),
  });
}

function deepFreeze<T>(obj: T): T {
  if (obj && typeof obj === "object") {
    for (const v of Object.values(obj)) deepFreeze(v);
    Object.freeze(obj);
  }
  return obj;
}

function casePolicyDenialReason(evalCase: EvalCase, policy: PromotionPolicy): string | null {
  if (policy.classification === "synthetic" && evalCase.source !== "synthetic") {
    return "synthetic classification requires a synthetic eval case source";
  }
  return null;
}

/**
 * Freeze a reviewed case into a customer-scoped regression candidate. Throws if
 * any gate fails (check `canPromoteToRegression` first to avoid the throw).
 */
export function promoteToRegression(
  evalCase: EvalCase,
  review: ReviewDecision,
  policy: PromotionPolicy,
  promoted_at?: string,
): RegressionCandidate {
  const denied = regressionDenialReason(review, policy);
  if (denied) throw new Error(`regression promotion denied: ${denied}`);
  const caseDenied = casePolicyDenialReason(evalCase, policy);
  if (caseDenied) throw new Error(`regression promotion denied: ${caseDenied}`);
  return deepFreeze({
    kind: "regression",
    source_case_id: evalCase.id,
    product: evalCase.product,
    classification: policy.classification,
    review: structuredClone(review),
    snapshot: frozenSnapshot(evalCase),
    promoted_at,
  });
}

/**
 * Approve a reviewed case for training export. Throws unless the source is
 * `training_approved` and the training gate is granted.
 */
export function approveForTraining(
  evalCase: EvalCase,
  review: ReviewDecision,
  policy: PromotionPolicy,
  approved_at?: string,
): TrainingExportCandidate {
  const denied = trainingDenialReason(review, policy);
  if (denied) throw new Error(`training approval denied: ${denied}`);
  return deepFreeze({
    kind: "training_export",
    source_case_id: evalCase.id,
    product: evalCase.product,
    classification: policy.classification,
    approver: review.reviewer_id,
    review: structuredClone(review),
    snapshot: frozenSnapshot(evalCase),
    approved_at,
  });
}
