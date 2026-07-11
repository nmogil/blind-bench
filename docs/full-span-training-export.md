# Approved full-span training export runbook

Blind Bench can turn a **closed, strict Mogil/Harbor full-span review** into deterministic Fireworks-compatible SFT or DPO artifacts. It does not run training, call Fireworks, or authorize customer/private data automatically.

## Safety contract

The operator flow is deliberately separate:

```text
review → close → owner training approval → export → verify
```

A `quality_eligible` objective result and a positive human verdict/preference are necessary but **not training consent**. An organization/project owner must grant a separate training approval on the closed Result. Editors may export an active approval but cannot grant or revoke it. Guest/blind review surfaces have no approval or export functions.

Approval is default-deny:

- approval snapshots the exact reviewer-projection storage ID and SHA-256 of its exact bytes; DPO snapshots both sides, winner, divergence index, persisted shared-prefix hash, and reviewer-safe task prompt/revision hash;
- generation reads only those immutable snapshot references and rejects missing, oversized, or hash-mismatched blobs—it never rediscovers the current span or matchup;
- only strict full-span evidence with `runQualification=quality_eligible`, complete integrity-bound reviewer evidence, and a positive human judgment is eligible;
- fixture-only, insufficient, non-full-span, confidential, PII, and PHI candidates are excluded;
- a sensitivity override is not available on the approved path;
- export recording atomically rechecks active approval plus project/campaign/format binding; failed partial generation deletes every blob it created;
- revocation blocks every later export/download and deletes all bounded JSONL/manifest blobs tied to the approval, invalidating previously issued direct storage URLs;
- customer or production data requires a separate product/data-boundary decision. Do not use the approval control as a substitute for written authorization.

## SFT artifact

Each JSONL line has exactly one top-level key:

```json
{"messages":[{"role":"user","content":"…"},{"role":"assistant","content":"…"}]}
```

No metadata is embedded in SFT JSONL. The assistant completion is the immutable reviewer-safe final output. Tool-rich context uses `blindbench.agent-observable-trajectory` version 1 inside the user message. Its explicit allowlist is `user_message`, `assistant_message`, `tool_call`, `tool_result`, and `tool_error`:

- reviewer-safe task prompt;
- sanitized observed user/assistant messages and aliased tool calls/results;
- chronology stops at the first terminal `final_output`, which is used only as the assistant target;
- no assistant reasoning, objective outcomes/rewards, verifier results, post-agent workspace changes, policy/lifecycle/termination events, raw evidence, source/model/provider/harness provenance, credentials, canaries, absolute paths, or raw trace/call IDs.

Objective outcomes remain eligibility and aggregate-manifest gates only; they never enter JSONL prompts/messages. This serialization is inference-available trajectory context, not hidden chain-of-thought or post-hoc oracle training data.

## DPO artifact

DPO is emitted only for an approved closed comparison when:

1. both candidates are quality-eligible strict full spans;
2. both independently share the same immutable SHA-256 task hash over reviewer-safe task prompt + producer task revision (including at divergence step 0);
3. the persisted SHA-256 prefix proof matches at the same divergence step;
4. reviewers resolve to one directional winner;
5. the chosen/rejected next actions are reviewer-safe, agent-observable allowlisted events, non-empty, and non-identical.

Ties, neither/cannot-judge, disagreement, prefix mismatch, hidden-reasoning or post-hoc/non-observable divergence, sensitive data, and degenerate pairs are explicit exclusions. A valid zero-row DPO artifact has an empty JSONL file plus a manifest whose counts reconcile and whose notes explain why no pair was written.

## Manifest

`blindbench.training-export` version 2 is stored and downloaded beside the JSONL. It contains only aggregate/safe handoff data:

- source and reviewer counts;
- row and exclusion counts plus reasons;
- schema, policy, and safe-serialization versions;
- active training-approval and public/internal-only sensitivity policy state;
- exact SHA-256 hash for each JSONL line;
- SHA-256 of the exact JSONL artifact bytes;
- candidate reconciliation (`candidate_count = included_count + excluded_count`);
- Fireworks row-shape declaration and zero-row notes.

It intentionally omits project/org/user/trace/run IDs, approver identity, provider/model/harness provenance, prompts, completions, comments, and raw evidence.

JSONL bytes are deterministic for one immutable approval snapshot, so row and dataset hashes are stable. The manifest is operational metadata: `generated_at` intentionally varies on each generation, while its row hashes and `dataset_hash` continue to identify the deterministic JSONL bytes.

## Hard size limits

Convex storage is blob-oriented rather than a true streaming writer, so export fails closed under conservative caps:

| Boundary | Maximum |
| --- | ---: |
| Candidates per approval/export | 50 |
| Exact reviewer projection blob | 512 KiB |
| One serialized JSONL row | 768 KiB |
| Total JSONL artifact | 4 MiB |
| Manifest | 512 KiB |
| Exports retained per active approval | 20 |

Exact-limit values are accepted; one byte/item above is rejected before artifact handoff. Candidate count is checked during both approval and generation.

## Operator steps

1. Import strict full-span evidence using [`full-span-ingest.md`](./full-span-ingest.md).
2. Create and open a blind **Score runs** or **Compare attempts** review.
3. Collect independent human judgments and close the review.
4. Open **Results**, choose the closed result, inspect objective outcomes and human verdicts separately, then select **Approve for training**. Only owners see an enabled approval control.
5. Select **Export approved SFT** or **Export eligible DPO**. Keep the downloaded manifest with the JSONL.
6. Verify the exact artifact and manifest. The Convex integration gate calls `verifyApprovedExportArtifact`; repository verification is:

   ```bash
   npm run test:convex -- --run convex/tests/fullSpanTrainingExport.test.ts
   ```

   The test imports the static sanitized Mogil producer fixture, reviews it as a separate principal, grants explicit owner approval, generates the artifact, and verifies row/dataset hashes without network calls.
7. If authorization changes, select **Revoke training approval**. Do not hand off any prior files; Blind Bench also blocks later downloads.

## Stop before Fireworks

This runbook ends at verified artifact handoff. It does not authorize `firectl`, a Fireworks API call, training spend, deployment, paid comparison, or use of customer/private logs. Those require a separate explicit decision outside this workflow.
