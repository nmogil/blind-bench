# Local eval runner

This document covers the local, infrastructure-free eval runner for the customer AI quality bench MVP.

## Scope

The runner is intentionally local-only:

- no hosted Blind Bench infrastructure
- no Convex persistence dependency
- no Cloudflare API dependency
- no external LLM judge calls
- synthetic fixtures only for the committed customer pilot smoke pack

It is designed to prove the trace-to-eval loop before wiring real Cloudflare AI Gateway imports or the human review console.

## Pack

The first pack is:

```text
demo/smoke
```

It contains 50 synthetic cases:

- 25 doc-summarizer cases
- 25 support-assistant cases

The pack lives in:

```text
src/lib/evals/packs/demoPack.ts
```

Every committed case is `source: "synthetic"` and uses obvious `TEST` fixture identifiers. Do not commit real customer traces, call transcripts, account numbers, emails, phone numbers, or secrets.

## Scorers

The first deterministic scorer pack lives in:

```text
src/lib/evals/scorers.ts
```

Scorers include:

- `required_clarification`
- `must_assertions`
- `no_hallucinated_data` — hard-fail privacy/safety scorer
- `no_cross_context_leakage` — hard-fail privacy/safety scorer
- `read_only_no_destructive_tool` — hard-fail tool-safety scorer
- `correct_escalation`
- `groundedness`
- `tone_customer_fit`
- `cost_latency_threshold`

LLM judges are isolated behind the `LlmJudgeAdapter` interface. No provider implementation is wired in this local runner.

## Run locally

Default smoke run, allowing the intentionally planted hard-fail fixture:

```bash
npx tsx src/lib/evals/cli.ts \
  --pack demo/smoke \
  --source fixtures \
  --output /tmp/blindbench-report.json \
  --markdown /tmp/blindbench-report.md \
  --allow-failures
```

Without `--allow-failures`, the default pack exits non-zero because it includes one intentional hard-fail fixture to prove CI gating works:

```bash
npx tsx src/lib/evals/cli.ts --pack demo/smoke --source fixtures
```

Expected behavior:

- `demo/smoke`: 49/50 pass, 1 intentional hard-fail
- `demo/smoke-pass`: 50/50 pass, 0 hard-fails

All-pass smoke run:

```bash
npx tsx src/lib/evals/cli.ts --pack demo/smoke-pass --source fixtures
```

## Baseline vs candidate

The runner supports baseline-vs-candidate comparison with fixture JSON files shaped as:

```json
{
  "case-id": {
    "text": "candidate output",
    "tool_calls": [],
    "raw": { "cost_usd": 0.001, "latency_ms": 900 }
  }
}
```

Run with:

```bash
npx tsx src/lib/evals/cli.ts \
  --pack demo/smoke \
  --baseline-fixtures /path/to/baseline.json \
  --candidate-fixtures /path/to/candidate.json \
  --output /tmp/blindbench-compare.json \
  --markdown /tmp/blindbench-compare.md
```

The comparison reports cases that regressed from pass to fail and cases that were fixed from fail to pass.

## Verification

Run eval tests:

```bash
npm run test:evals
```

Focused type-check for the eval layer:

```bash
npx tsc --ignoreConfig --noEmit --skipLibCheck \
  --module ESNext \
  --moduleResolution bundler \
  --target ES2022 \
  --types node \
  --strict \
  --noUnusedLocals \
  --noUnusedParameters \
  --noUncheckedIndexedAccess \
  src/lib/evals/*.ts src/lib/evals/packs/*.ts
```
