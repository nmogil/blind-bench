# Ingestion-first operator guide

Blind Bench reviews completed AI behavior. It does not execute Pi, Claude Code, arbitrary harness code, or customer sandboxes.

## Choose an input

Use the authenticated project **Import runs** tab for files up to 8 MiB:

| Input | Best for | Required shape |
| --- | --- | --- |
| CSV | Flat prompt/output or interaction batches | Header row, then map input and output; optional ID, system, timestamp, model, provider, harness, product, module, environment, privacy class, and metadata columns |
| OpenTelemetry JSON | Captured multi-span GenAI traces | OTLP/HTTP `resourceSpans`; only recognized GenAI spans import |
| Pi session JSONL | One coding-agent trajectory | Pi session v3 header and tree-linked entries; importer follows one deterministic active leaf path |
| Claude Code JSONL | One Claude Code trajectory | Claude Code session transcript records |

For continuous collection, use the token-authenticated native `eval-record` v1 or OTLP endpoints documented in [`native-ingest.md`](./native-ingest.md). Cloudflare Gateway exports remain available through the Gateway import flow.

## Import contract

Every adapter:

1. authenticates and checks project editor/owner access;
2. enforces bounded input before persistence;
3. normalizes into the shared `agentTraces` / paginated `agentTraceSteps` spine;
4. stores raw provenance and large full/blind step bodies in access-controlled file storage;
5. returns counts and caveats without echoing raw prompts, outputs, tool bodies, or malformed lines;
6. deduplicates retries by a stable source/content identity.

CSV is intentionally flat. Use OTLP or harness JSONL when order, tool calls, branches, compactions, or multi-step structure matter.

## Review and reuse

After import:

1. Open **Review** and create or use the opaque trace-review session link.
2. Send the link to a reviewer who does not already have owner/editor provenance access.
3. The reviewer submits an independent verdict, comment, or matchup decision.
4. Owners may reveal provenance after review and route judgments into regression/evidence or training export.

Blind trajectory review is provenance stripping and bias reduction, not a claim of perfect anonymity. Tool patterns may still fingerprint a harness.

DPO export is default-deny: both options must have the same persisted trajectory-prefix hash and independent reviewer decisions must resolve to one winner. Prefix mismatch, disagreement, tie, skip, or missing decisions are explicit exclusions. SFT/evidence exports remain available under their own approval rules.

## Data boundary

Structured key-name redaction protects recognized sensitive tool fields. Free-text prompts, outputs, logs, and attachments are not guaranteed to be scrubbed. Import only data the workspace is approved to store and review.

Before live customer/operator logs:

```bash
npm run readiness:customer-testing
```

A blocked result is intentional. A generated launch packet or sanitized customer label is not consent and does not approve live-log import. Follow [`customer-testing-readiness.md`](./customer-testing-readiness.md) and [`customer-test-launch-packet.md`](./customer-test-launch-packet.md).
