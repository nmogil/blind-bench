# Customer tenancy, consent, and data isolation

Blind Bench must keep customer data isolated while still allowing reusable product infrastructure to improve. This note defines the minimum model for customers and future Cloudflare AI Gateway users.

## Tenancy architecture

```text
Customer workspace
  ├─ projects
  │   ├─ trace imports
  │   ├─ eval cases
  │   ├─ review labels
  │   ├─ regression datasets
  │   ├─ scorecards
  │   └─ training exports
  ├─ customer-scoped credentials
  ├─ customer-scoped storage namespace
  └─ consent / retention policy

Reusable Blind Bench layer
  ├─ schemas
  ├─ runner
  ├─ scorer implementations
  ├─ adapters
  └─ synthetic examples only
```

## Isolation requirements

- One customer workspace per customer/legal data boundary.
- Separate Cloudflare credentials or tokens per customer workspace.
- Separate Fireworks/OpenAI/fine-tuning credentials per customer if training is enabled.
- Separate storage namespace or prefix per customer.
- Trace IDs and sidecar metadata must be scoped by customer/workspace.
- No cross-customer global search over raw traces or reviewed outputs.
- Reusable scorer code can be shared; customer data cannot.

## Data classification

| Class | Meaning | Allowed use |
| --- | --- | --- |
| `synthetic` | Fake examples with obvious TEST/SYNTHETIC IDs | Repo, demos, reusable packs, CI. |
| `redacted_prod` | Production-derived but redacted and approved for review/eval | Customer-scoped regression/eval only. |
| `prod_sensitive` | Raw or lightly processed production data | Customer-scoped secure storage/review only; no repo or generic demos. |
| `training_approved` | Reviewed and explicitly approved for model training/export | Customer-scoped training/fine-tuning export only. |

## Consent gates

Trace promotion must pass through explicit gates:

1. **Import allowed** — customer authorizes collecting/processing this source.
2. **Review allowed** — trace may be shown to approved reviewers after redaction/classification.
3. **Regression allowed** — reviewed trace can be frozen into a customer-scoped regression dataset.
4. **Training allowed** — reviewed trace/label can be exported for fine-tuning or preference training.
5. **Reusable allowed** — only synthetic or explicitly written-approved, non-confidential material may become reusable Blind Bench content.

Default: if a gate is missing, treat it as denied.

## Trace-to-training approval workflow

```text
Raw trace
  → classify + redact
  → reviewer labels outcome/reason/evidence
  → promote to regression? yes/no
  → approve for training? yes/no + approver + timestamp
  → export only if class == training_approved
```

A local, pure-function implementation of the label → regression/training gates lives in [`review-promotion-workflow.md`](./review-promotion-workflow.md) (`src/lib/evals/reviewWorkflow.ts`).

Training export metadata should include:

- source trace ID / hash
- data class
- approver
- approval timestamp
- redaction version
- source product/module
- intended training target
- revocation/deletion handle if available

## Reusable assets vs customer artifacts

Reusable Blind Bench assets:

- Zod/JSON schemas
- deterministic scorer code
- runner/CLI
- Cloudflare adapter code
- agent trace schema
- synthetic examples
- generic docs

Customer-specific artifacts:

- Cloudflare logs
- trace sidecars
- Customer labels/reviews
- Customer regression datasets
- Customer scorecards
- Customer training exports
- prompt/version metadata if confidential

## Deletion and retention

Each customer workspace should define:

- raw trace retention period
- reviewed case retention period
- regression dataset retention period
- training export retention/deletion process
- audit log retention

Deletion should cascade or tombstone by source trace ID so scorecards can preserve aggregate facts without retaining raw sensitive payloads.

## Hard rule

Customer logs never seed shared models, shared eval packs, demos, marketing examples, or reusable Blind Bench datasets without explicit written approval.
