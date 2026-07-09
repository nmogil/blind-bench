# EvaluationRow compatibility export

Blind Bench does **not** adopt Eval Protocol, the Python SDK, Fireworks-hosted tracing, or Fireworks proxy credentials. This export is only a local compatibility hedge for a future customer who explicitly wants Blind Bench review/training rows serialized into an EvaluationRow-style JSONL shape.

## Command

```bash
npm run export:evaluation-rows
npm run export:evaluation-rows -- --json
npm run export:evaluation-rows -- --out /tmp/evaluation-row-export
npm run export:evaluation-rows -- --generated-at 2026-01-01T00:00:00Z
```

Default output:

```text
artifacts/evaluation-row-export/
├── evaluation-rows.jsonl
├── evaluation-rows.manifest.json
└── evaluation-rows.report.md
```

## What it writes

`evaluation-rows.jsonl` contains one JSON object per line with the EvaluationRow-style fields:

- `messages`
- `tools`
- `input_metadata`
- `rollout_status`
- `ground_truth`
- `evaluation_result`
- `execution_metadata`
- `created_at`
- `eval_metadata`

The manifest/report contain only management-safe summary fields:

- format/schema family
- generated timestamp
- dataset name
- row count
- split counts
- row hashes
- dataset hash
- caveats

The console output intentionally omits raw prompts, completions, tool arguments, and row JSON.

## Data boundary

The default command compiles from Blind Bench's synthetic demo training rows only. Real operator/customer rows must pass the existing Blind Bench data-boundary controls before serialization:

1. consent and tenancy boundary approved;
2. privacy classification set honestly;
3. training export approval granted;
4. forbidden-substring / leak guards applied where relevant;
5. local artifact verification completed before handoff.

Do not use this command as approval evidence. It is a serializer/reporting tool, not a policy decision engine.

## Why this exists

Issue #275 concluded that Blind Bench should not adopt Eval Protocol as a runtime dependency because it does not match the BYOK/no-vendor-creds and TypeScript-first architecture. The useful hedge is a small serializer: Blind Bench can manufacture human judgment and later serialize it for a customer-owned Fireworks RFT/Eval Protocol pipeline if explicitly requested.
