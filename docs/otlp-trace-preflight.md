# OTLP trace payload preflight

A local-only sanity check for an OTLP/OpenTelemetry Gen-AI JSON payload **before**
you point a live exporter at BlindBench's ingest endpoint. It reuses the exact
`mapOtlpToTraces` mapper the `/otlp/v1/traces` importer runs, so "does my payload
map to trajectories?" is answered by the real code path — not a second parser.

It does **not** send anything, import into Convex, or read ingest tokens. It only
reads a file and prints counts + label-only fields.

## Usage

```bash
# Text summary
npm run preflight:otlp -- path/to/otlp-export.json
# or directly:
npx tsx scripts/otlp-trace-preflight.ts path/to/otlp-export.json

# Machine-readable (same safe fields as JSON)
npx tsx scripts/otlp-trace-preflight.ts path/to/otlp-export.json --json
```

Get the payload by capturing what your exporter would POST — e.g. write your
OTLP/HTTP exporter's request body to a file, or export a batch to JSON.

## Output

```
OTLP trace preflight — READY

  traces:          1
  spans:           2
  steps:           4
  requestMissing:  1
  responseMissing: 1
  models:          gpt-4o
  harnesses:       openai
  trace refs:      …ight-xyz

Caveats:
  - 1 span(s) had no request/prompt body.
  - 1 span(s) had no response/completion body.
```

- **traces / spans / steps** — how many trajectories, spans, and trajectory steps
  the mapper produced.
- **requestMissing / responseMissing** — spans with no prompt / no completion body
  (these still map; the gateway importer counts them the same way).
- **models / harnesses** — `gen_ai.request.model|response.model` and
  `gen_ai.system|provider` names, if present.
- **trace refs** — capped, suffix-only references (never full ids or raw payload).
- **readiness / caveats** — `READY` when at least one trace mapped; caveats flag
  missing bodies, missing model attributes, and capped reference lists.

The summary is built only from counts and label-only fields — it never prints raw
prompts, completions, span bodies, tool arguments, account ids, credentials, or the
invalid JSON itself.

## Exit codes

| Code | Meaning |
| ---- | ------- |
| 0 | At least one trace mapped |
| 1 | Zero traces mapped (payload has no `resourceSpans[].scopeSpans[].spans` with `gen_ai.*` attributes) |
| 2 | Bad input — missing path argument, unreadable file, or invalid JSON |

## Mapping to Ingest Endpoint setup

In the app, **Settings → Ingest Endpoint** issues a token and shows the
`/otlp/v1/traces` URL for your OTLP/HTTP exporter. Run this preflight against a
captured payload first:

1. **READY with the models/harness you expect** → your exporter's attributes match
   the Gen-AI conventions the importer reads; safe to configure the live exporter.
2. **NOT READY (zero traces)** → the exporter isn't emitting
   `resourceSpans[].scopeSpans[].spans` with `gen_ai.*` attributes; fix the
   exporter/instrumentation before wiring up the endpoint.
3. **High requestMissing / responseMissing** → spans are arriving without
   prompt/completion bodies; expected if you strip bodies, otherwise check your
   `gen_ai.prompt*` / `gen_ai.completion*` attribute emission.
