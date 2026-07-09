# Synthetic agent trace fixtures

Use these fixtures for local dry runs before importing any real operator-owned trace data. The generator writes deterministic, synthetic-only examples for the core supported trace shapes.

```bash
npm run fixtures:agent-traces
npm run fixtures:agent-traces -- --out /tmp/blindbench-agent-trace-fixtures
```

Default output:

```text
artifacts/agent-trace-fixtures/
├── claude-code-session.jsonl
├── cloudflare-gateway.jsonl
├── otlp-genai.json
├── manifest.json
└── README.md
```

## What the fixtures cover

| File | Shape | Parser / mapper exercised |
| --- | --- | --- |
| `claude-code-session.jsonl` | Claude Code JSONL session | `parseClaudeCodeSession` |
| `cloudflare-gateway.jsonl` | Cloudflare AI Gateway exported JSONL | `parseCloudflareAiGatewayJsonl` |
| `otlp-genai.json` | OTLP/OpenTelemetry GenAI JSON payload | `mapOtlpToTraces` |

The generated manifest includes only safe metadata:

- file names;
- format labels;
- trace/span/step counts;
- model labels;
- fixed `generated_at` timestamp;
- safety flags.

## Safety contract

The fixtures are deliberately synthetic:

- no customer/design-partner data;
- no real Claude sessions;
- no real Cloudflare AI Gateway exports;
- no real OTLP exports;
- no authentication material, account secrets, or real account identifiers;
- no network calls;
- no Convex import or mutation;
- no Fireworks/model-provider calls.

## Operator flow

1. Generate fixtures locally:

   ```bash
   npm run fixtures:agent-traces
   ```

2. Use the generated files to exercise parser/preflight commands as those PRs land. Examples:

   ```bash
   npm run preflight:claude-code -- artifacts/agent-trace-fixtures/claude-code-session.jsonl
   npm run preflight:gateway -- artifacts/agent-trace-fixtures/cloudflare-gateway.jsonl
   npm run preflight:otlp -- artifacts/agent-trace-fixtures/otlp-genai.json
   ```

3. Use the resulting safe summaries for dry-run handoff evidence. Do not treat these fixtures as customer data, evaluation truth, or training examples.

## Review notes

The fixture generator validates its own output against the existing parser/mappers before writing the manifest. If parser behavior changes, the focused fixture test should fail before customer data is touched.
