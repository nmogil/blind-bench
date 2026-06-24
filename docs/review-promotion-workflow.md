# Review → promotion workflow (local slice)

Minimal, local-only implementation of the human-review side of issue #234. No
UI, no Convex, no network — just pure functions over the eval-case schema so a
reviewer (or a CLI) can turn a reviewed case into a regression or training
candidate while respecting the gates in
[`tenancy-consent-data-isolation.md`](./tenancy-consent-data-isolation.md).

Code: `src/lib/evals/reviewWorkflow.ts` · tests: `reviewWorkflow.test.ts`.

## Flow

```text
eval case  ─┐
            ├─ reviewer labels (outcome / reason_tag / notes / evidence)
            │
            ├─ canPromoteToRegression? → promoteToRegression() → frozen regression candidate
            └─ canApproveForTraining?  → approveForTraining()   → training-export candidate
```

## Pieces

- **`ReviewDecision`** — `case_id`, `reviewer_id`, `outcome`
  (`pass|fail|better|worse|tie|ignore`), `reason_tag`, optional `notes`,
  `reviewed_at`, and `evidence_spans` (reusing the scorer `EvidenceSpan`).
  `ignore` is how a reviewer declines a case; it blocks all promotion.
- **`PromotionPolicy`** — the source `classification`
  (`synthetic|redacted_prod|prod_sensitive|training_approved`) plus the consent
  booleans `review_allowed`, `regression_allowed`, and `training_allowed`.
  All booleans default to `false` — **default-deny**. Redaction is upstream work:
  a source that is still classified `prod_sensitive` cannot enter a regression set.

## Gates

| Function | Allowed only when |
| --- | --- |
| `canPromoteToRegression` | not ignored · `review_allowed` · `regression_allowed` · classification is `synthetic` or `redacted_prod` |
| `canApproveForTraining` | not ignored · `review_allowed` · `training_allowed` · `classification == training_approved` |

Synthetic cases promote to regression when the gate is open, but are **never**
training-approved by default. `regressionDenialReason` / `trainingDenialReason`
return the specific reason (for CLI messaging); the `promote*` / `approve*`
functions throw that reason if a gate fails.

## Freezing

`promoteToRegression` / `approveForTraining` deep-clone and recursively freeze
the case `input` / `expected` / `scorer_assignments` / `metadata` into the candidate's `snapshot`. Later
mutation of the source trace/case cannot change an already-promoted regression
candidate (covered by a test).

## What this slice does not do

Persistence, the reviewer UI, and trace-mutation plumbing are out of scope —
this is the pure-logic core that those layers call. Callers pass `promoted_at` /
`approved_at` so promotion is deterministic.
