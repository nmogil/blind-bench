# Training export artifact verifier

Use this local verifier before handing Fireworks-ready JSONL artifacts to Fireworks or to a customer. It checks that the legacy local compiler output is internally consistent and preserves the data-boundary contract.

For product-generated, explicitly approved strict full-span SFT/DPO artifacts, use the v2 manifest verifier and operator flow in [`full-span-training-export.md`](./full-span-training-export.md). That verifier checks exact line hashes, exact dataset bytes, approval/policy state, row shape, and count reconciliation against the static sanitized Mogil producer fixture.

```bash
npm run dataset:demo
npm run verify:training-export -- artifacts
npm run verify:training-export -- artifacts --json
```

Optional leakage guard:

```bash
npm run verify:training-export -- artifacts --block-substring FORBIDDEN_SENTINEL
```

The verifier is local-only:

- no Fireworks API calls;
- no Convex import or mutation;
- no Cloudflare or model-provider calls;
- no credentials required.

## Expected files

The artifact directory must contain the compiler output names:

- `training-dataset.train.jsonl`
- `training-dataset.validation.jsonl`
- `training-dataset.test.jsonl`
- `training-dataset.manifest.json`

## Checks

The verifier validates:

1. Every JSONL line parses as JSON.
2. Every row has the Fireworks chat/SFT shape:

   ```json
   {"messages":[{"role":"user","content":"…"},{"role":"assistant","content":"…"}]}
   ```

3. Message roles and content are non-empty strings.
4. Manifest `split_counts` match actual JSONL line counts.
5. Manifest `row_entries[*].hash` values match each messages-only JSONL row.
6. Manifest `dataset_hash` matches the row-entry hash structure.
7. Optional `--block-substring` sentinels do not appear in any JSONL row.

## Safe output

Text mode prints only management-safe fields:

```text
Training export verification — READY

  dataset:       training-dataset
  hash suffix:   …27a9583a60f1
  files checked: 4
  rows:          train=4 validation=0 test=1
  excluded:      0
```

Error mode prints reason codes like `train:manifest_count_mismatch` or `test:line_2:invalid_json`. It does **not** print row contents, prompts, completions, account IDs, invalid JSON text, or blocked substring values.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Artifacts are ready. |
| 1 | Artifacts were readable but failed verification. |
| 2 | Bad invocation or missing artifact directory. |

## Operator flow

1. Generate or receive training artifacts.
2. Run this verifier locally.
3. Only hand off JSONL if the verifier reports `READY` and the manifest/excluded counts match the intended data boundary.
4. Keep the manifest with the JSONL handoff; it is the safe sidecar for hashes, split counts, filters, and exclusions.
