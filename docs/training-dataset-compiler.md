# Training dataset compiler (Fireworks SFT)

Local, deterministic compiler that turns explicitly **training-approved** review
candidates into a Fireworks-compatible chat/SFT JSONL dataset with train /
validation / test splits and a manifest.

Source: `src/lib/evals/trainingDataset.ts` · Tests: `trainingDataset.test.ts`.

It is **compiler + fixtures + tests only**: no network, no Convex, no Fireworks
API call. The caller supplies `generated_at` so artifacts are byte-stable.

## Run it

```bash
npm run dataset:customer-pilot            # uses a fixed default generated_at
npm run dataset:customer-pilot 2026-06-24T00:00:00Z   # override timestamp
```

Writes (into the gitignored `artifacts/`):

- `customer-pilot-training-dataset.train.jsonl`
- `customer-pilot-training-dataset.validation.jsonl`
- `customer-pilot-training-dataset.test.jsonl`
- `customer-pilot-training-dataset.manifest.json`

The pilot source is the **synthetic** customer-pilot smoke pack only — fake data.

## Output shapes

Each JSONL line is a **messages-only** Fireworks chat/SFT row — nothing else:

```json
{"messages":[{"role":"user","content":"…"},{"role":"assistant","content":"…"}]}
```

Messages are `transcript` + case `messages` + the safe assistant completion. Keys
are stably sorted so JSONL is deterministic, and the row is strictly valid JSON for
every row (no inline sidecar keys that could be `undefined`).

**Per-row metadata lives in the manifest, not in the JSONL.** The manifest's
`row_entries` maps each split to an array of `{ case_id, product, source,
classification, privacy_class, split, approver, approved_at?, variant?,
customer_scope?, hash }`, where `hash` is the SHA-256 of that row's messages-only
JSONL line (so the manifest verifies exactly what was written). Optional fields are
omitted when absent — `JSON.stringify` keeps the manifest valid JSON.

The manifest also carries source filters, split ratios + counts, a `dataset_hash`,
products, privacy classes, classifications, and every excluded row with its reason.

### Split ratios

`splits: { train, validation }` (test is the remainder). Both must be finite and
non-negative, and `train + validation <= 1` (sum `== 1` is allowed — an intentionally
empty test split). Invalid ratios throw before any row is compiled.

### Forbidden-content safety gate

Pass `blocked_substrings: string[]` to exclude any row whose input messages or
completion contain a known forbidden sentinel (cross-tenant ids, PII markers). Blocked
rows are reported in `manifest.excluded` with reason `forbidden_substring_blocked` (the
matched value is never echoed) and never written to JSONL.

## Data-boundary rules

Mirrors [`tenancy-consent-data-isolation.md`](./tenancy-consent-data-isolation.md)
and [`review-promotion-workflow.md`](./review-promotion-workflow.md). The compiler
is **default-deny** — a row only exports if it clears every gate:

1. **Approved by construction.** Inputs are `TrainingExportCandidate`s from
   `approveForTraining()`. There is no other way to get a candidate, so a row
   that never passed the training gate cannot be fed in.
2. **Classification.** `prod_sensitive` and `redacted_prod` candidates are
   blocked (`prod_sensitive_blocked` / `redacted_prod_not_exportable`). Only
   `training_approved` exports.
3. **Explicit policy approval for real data.** A non-`synthetic` source row
   exports only when the caller passes `allow_training_approved_export: true`.
   Synthetic rows always pass. Without the flag, real rows are excluded as
   `training_approved_export_not_policy_approved`. **Never export raw prompt/
   output text from `prod_sensitive` or unapproved production sources.**
4. **Eval-set contamination prevention.** Rows marked `eval_only` (held-out)
   never appear in train or validation. They reach the **test** split only when
   `allow_in_test` is set; otherwise they are excluded
   (`held_out_eval_only_excluded`).
5. **Field redaction.** Only curated metadata is emitted (case id, product,
   variant, classification, privacy class, split, approver, customer scope). The
   raw snapshot, scorer config, and provider payloads are never written.

## Ingesting Cloudflare AI Gateway traces

Traces are not fed in directly. The path is:

```
normalizeCloudflareAiGatewayLog → convertTraceToEvalCase → review (ReviewDecision)
  → approveForTraining(... training_approved policy ...) → TrainingExportCandidate
  → TrainingDatasetSourceRow (with source: "production_log") → compileTrainingDataset
```

Real (production) rows still require `allow_training_approved_export: true`, which
is the explicit per-customer policy-approval gate.

## Filters

`compileTrainingDataset(rows, { filters })` supports `products`, `variants`,
`privacy_classes`, `classifications`, `customer_scopes`, `approvers`, `min_score`,
and `min_rating`. Filtered rows appear in the manifest as `filtered_out:<axis>`.
