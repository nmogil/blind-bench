# Customer-testing data-boundary readiness

Use this command before importing real operator/customer trace data. It turns the data-boundary approval checklist into a deterministic local report.

```bash
npm run readiness:customer-testing
npm run readiness:customer-testing -- --json
npm run readiness:customer-testing -- --approvals /path/to/customer-testing-approvals.json
```

Default output artifacts:

```text
artifacts/customer-testing-readiness/
├── customer-testing-readiness.md
└── customer-testing-readiness.json
```

## Default posture

Without an approvals file, the command exits non-zero and reports:

```text
blocked_until_approved
```

This is intentional. Real logs should not be imported until all required gates are explicitly approved in a local JSON file.

## Required gates

The approval file should contain booleans only for these keys:

```json
{
  "customer_data_boundary_identified": true,
  "operator_owns_or_exports_logs": true,
  "reviewer_scope_approved": true,
  "retention_deletion_policy_accepted": true,
  "redaction_classification_path_accepted": true,
  "training_use_explicitly_approved_or_blocked": true,
  "shared_demos_marketing_reuse_blocked": true,
  "credential_handling_confirmed": true,
  "local_preflight_before_live_import": true
}
```

The report deliberately ignores and does not echo free-text notes or additional fields from the approval file.

## Required documents checked

The command also verifies these guardrail documents exist:

- `docs/tenancy-consent-data-isolation.md`
- `docs/cloudflare-gateway-live-import.md`
- `docs/native-ingest.md`
- `docs/training-dataset-compiler.md`
- `docs/customer-pilot-sow.md`

## Safety contract

The readiness command is local-only:

- no network calls;
- no Convex import or mutation;
- no Cloudflare calls;
- no Fireworks/model-provider calls;
- no customer trace content required or printed;
- no authentication material required or printed.

## Operator flow

1. Confirm the customer/legal data boundary and approval posture outside the repo.
2. Create a local approvals JSON file with every required boolean set to `true` only after approval is real.
3. Run:

   ```bash
   npm run readiness:customer-testing -- --approvals /path/to/customer-testing-approvals.json
   ```

4. Keep the Markdown/JSON report as handoff evidence.
5. Only then run the relevant local preflight for the operator-owned file before live import.

## Important caveat

`ready_for_customer_testing` means the repo-side checklist is satisfied. It is not evidence that a customer granted consent unless the local approvals file was created from a real external approval record.
