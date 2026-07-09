# Live native emitter — auto-instrument a running harness

The native ingest endpoint ([`native-ingest.md`](./native-ingest.md)) is the
durable contract. This doc covers the **client-side capture ergonomics**: a thin
reference emitter a running agent/harness installs so model + tool interactions
flush to `POST /ingest/v1/traces` without hand-rolling `curl` or batching logic.

Reference implementation: [`src/lib/evals/liveEmitter.ts`](../src/lib/evals/liveEmitter.ts).
Runnable example + selfcheck: [`src/lib/evals/liveEmitterSelfcheck.ts`](../src/lib/evals/liveEmitterSelfcheck.ts)
(`npm run selfcheck:emitter`).

It is a **reference emitter, not a packaged SDK** — copy it or import it. No npm
dependencies; it uses the global `fetch` and is Node 18+ / browser-compatible.

## Enable it

Disabled by default. `emitterFromEnv()` returns a **no-op** unless tracing is
explicitly enabled *and* an endpoint + token are configured. Importing it never
sends anything until the operator opts in.

```ts
import { emitterFromEnv } from "@/lib/evals/liveEmitter";

// No-op unless BLINDBENCH_TRACE_ENABLED=true + URL + token are set.
const emitter = emitterFromEnv();

// In your model call path:
emitter.enqueueInteraction({
  id: requestId,
  model: "anthropic/claude-4.7-opus",
  provider: "anthropic",
  messages,                     // the request messages
  content: answerText,          // the model's final text
  toolCalls,                    // [{ id, name, arguments }]
  toolResults,                  // [{ tool_call_id, name, result }]
  usage: { input_tokens, output_tokens, cost_usd, duration_ms },
});

// On shutdown, drain the queue:
await emitter.close();
```

`enqueueInteraction` returns immediately; the emitter batches in the background.
Prefer `createEmitter(config)` if you resolve endpoint/token yourself instead of
from env.

### Environment variables

| Var | Required | Meaning |
| --- | --- | --- |
| `BLINDBENCH_TRACE_ENABLED` | **yes** | Must equal `"true"`. Anything else → no-op. |
| `BLINDBENCH_INGEST_URL` | **yes** | Full `…/ingest/v1/traces` URL (`.convex.site`). |
| `BLINDBENCH_INGEST_TOKEN` | **yes** | Per-project ingest token (bearer). |
| `BLINDBENCH_PRODUCT` | no | Default `product` grouping stamped on each record. |
| `BLINDBENCH_MODULE` | no | Default `module` grouping. |
| `BLINDBENCH_ENVIRONMENT` | no | Default `environment` grouping (e.g. `prod`). |

Any of these can be overridden in code via the first arg to `emitterFromEnv`.

### Tuning (via `createEmitter` / `emitterFromEnv` overrides)

| Option | Default | Meaning |
| --- | --- | --- |
| `maxBatchSize` | `20` | Flush when the queue reaches this many records. |
| `flushIntervalMs` | `2000` | Flush a partial queue after this idle interval. `0` disables the timer. |
| `maxRetries` | `2` | Extra send attempts after the first, on failure. |
| `harness` | — | `{ name, version, sdk }` stamped on every record. |
| `fetchImpl` | global `fetch` | Injectable transport (tests / custom clients). |
| `onError` | — | `(err, droppedRecords)` hook for dropped batches. Must not throw. |

## Failure semantics

The agent path must never be interrupted by trace capture:

- **`enqueue*` never throws.** It pushes to an in-memory queue and returns.
- **Network / HTTP failures are swallowed and counted**, never re-raised into
  the agent run. Dropped records increment `status().dropped`; the batch is
  reported via the optional `onError` hook.
- **`4xx` fails fast** (bad token / bad request won't fix on retry). **`5xx` and
  network errors retry** up to `maxRetries`, then the batch is dropped.
- **`flush()` / `close()` return a `FlushResult`** (`{ ok, sent, dropped,
  batches, error? }`) you *can* inspect — the one place failures are visible.
- **The queue is in-memory only.** Records still queued when the process dies are
  lost; call `close()` on shutdown. (No disk spooling — see the ponytail note in
  the source. Add a durable spool only if at-least-once delivery is required.)

Re-sends are safe: ingest dedups on `id`, so a retried batch counts as `deduped`,
never double-imported. Pass a stable `id` per interaction to get idempotency.

## Harness event → `EvalRecordV1` mapping

`enqueueInteraction(i)` maps the ergonomic `ModelInteraction` onto the wire
`EvalRecordV1` (one record = one model interaction):

| Harness event field | `EvalRecordV1` field | Notes |
| --- | --- | --- |
| `i.id` | `id` | Dedup key. Omit → server derives a deterministic id. |
| `i.timestamp` | `timestamp` | ISO-8601. |
| `i.model` | `model` | e.g. `anthropic/claude-4.7-opus`. |
| `i.provider` | `provider` | e.g. `anthropic`. |
| `i.messages` | `input.messages` | Request messages. **Non-empty** — ingest rejects empty. |
| `i.content` | `output.content` | The model's final text answer. |
| `i.toolCalls` | `output.tool_calls` | `[{ id?, name, arguments }]`. |
| `i.toolResults` | `output.tool_results` | `[{ tool_call_id, name?, result? }]`. |
| `i.usage` | `usage` | `{ input_tokens?, output_tokens?, total_tokens?, cost_usd?, duration_ms? }`. |
| `i.product` / `i.module` / `i.environment` | same | Fall back to emitter/env defaults. |
| `i.metadata` | `metadata` | Arbitrary object, stored as-is. |
| `i.privacyClass` | `privacy_class` | Governance signal; may raise (never lower) the inferred class. |
| emitter `harness` config | `harness` | `{ name, version, sdk }`. |

`output` is omitted entirely when there is no `content`, tool call, or tool
result. Server-side redaction still applies at ingest (key-name based) — see the
data boundary section of [`native-ingest.md`](./native-ingest.md). Free-text
message/answer content is **not** auto-scrubbed; don't emit secrets in it.

Raw records (already `EvalRecordV1`) can be pushed with `enqueueRecord(record)`.
