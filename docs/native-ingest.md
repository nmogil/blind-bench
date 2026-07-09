# Native JSON ingest — the `eval-record` v1 contract

Blind Bench's own versioned native schema is the **durable public contract** for
getting model interactions into a project. OTLP and the Cloudflare AI Gateway
import are **adapters** that normalize *into* this same schema — they are not
separate products. Concretely:

- **Native JSON (this doc)** — POST `eval-record` v1 records straight to Blind
  Bench. This is the contract of record; nothing else here is more authoritative.
- **OTLP** — POST OpenTelemetry GenAI spans to `/otlp/v1/traces`. A customer with
  a gateway (or any OTel exporter) points it here for **live** capture; Blind
  Bench normalizes the spans into `eval-record` v1 on arrival.
- **Cloudflare AI Gateway import** — export/upload gateway logs to backfill. See
  [`gateway-onboarding.md`](./gateway-onboarding.md) for that adapter path end to
  end.

**You do not need to adopt OpenTelemetry to use Blind Bench.** If you have a
gateway, point its OTLP exporter at `/otlp/v1/traces` (live) or upload logs to
backfill. If you don't, POST the native JSON described here. All three paths land
in the same normalized trace store.

---

## Endpoint

```
POST https://{deployment}.convex.site/ingest/v1/traces
Content-Type: application/json
```

> **⚠️ Use `.convex.site`, not `.convex.cloud`.** HTTP actions (this endpoint and
> the OTLP one) are served from the `.convex.site` host. The `.convex.cloud` host
> serves the query/mutation API and will not route `/ingest/v1/traces`.

## Auth

Per-project **ingest token** — the **same tokens as the OTLP endpoint**. Send it
either way:

```
Authorization: Bearer <token>
```

or

```
x-blindbench-ingest-token: <token>
```

Tokens are issued and revoked on the project's **Ingest** tab. Each token is
scoped to exactly one project, so ingestion is **per-project isolated** — a
token can never write to another project's traces. A missing or revoked token
returns **401**; Blind Bench holds **no customer credentials** of its own (BYOK —
the customer's provider/gateway keys never reach Blind Bench).

---

## The `eval-record` v1 schema

**One record = one model interaction.** All fields:

| Field | Required | Type | Notes |
| --- | --- | --- | --- |
| `version` | **required** | string | Must be `"1"`. |
| `id` | optional | string | Dedup key — re-POSTing the same `id` is idempotent (counted as `deduped`, never re-imported). If omitted, a deterministic id is derived from record content. |
| `timestamp` | optional | string | ISO-8601. |
| `model` | recommended | string | e.g. `"anthropic/claude-4.7-opus"`. |
| `provider` | recommended | string | e.g. `"anthropic"`. |
| `input` | **required** | object | `{ "messages": [{ "role": string, "content": string }] }`. Must be a **non-empty** `messages` array; each message needs string `role` and `content`. |
| `output` | optional | object | See [output shape](#output-shape) below. |
| `usage` | optional | object | `{ "input_tokens"?, "output_tokens"?, "total_tokens"?, "cost_usd"?, "duration_ms"? }` — all numbers. If `total_tokens` is omitted but both `input_tokens` and `output_tokens` are present, it is summed. |
| `product` | optional | string | Grouping. |
| `module` | optional | string | Grouping. |
| `environment` | optional | string | Grouping, e.g. `"prod"` / `"staging"` / `"dev"`. |
| `harness` | optional | object | `{ "name"?, "version"?, "sdk"? }` — the SDK/tool that emitted the record. |
| `metadata` | optional | object | Arbitrary object, stored as-is. |
| `privacy_class` | optional | string | One of `"public" \| "internal" \| "confidential" \| "pii" \| "phi"`. If set it is honored as an explicit governance signal; if omitted it is inferred (records with redacted sensitive fields infer `pii`, else `internal`). |

### Output shape

`output` is optional; every sub-field is optional:

```json
{
  "content": "string — the assistant's text answer",
  "tool_calls": [
    { "id": "call-1", "name": "lookup_account", "arguments": { "id": "A-42" } }
  ],
  "tool_results": [
    { "tool_call_id": "call-1", "name": "lookup_account", "result": { "status": "active" } }
  ]
}
```

- `tool_calls[]` — `{ "id"?: string, "name": string, "arguments": object }`.
- `tool_results[]` — `{ "tool_call_id": string, "name"?: string, "result"?: any }`.

A record with no `output.content` is still valid; it is counted in
`responseMissing` (see [response](#response)) but imported.

---

## Batching

The endpoint accepts any of three envelope shapes:

- a **single record** object,
- a **bare JSON array** of records, or
- `{ "records": [ … ] }`.

A malformed **individual record** is counted in `invalid` and skipped — the batch
does **not** fail. A malformed **JSON envelope** (unparseable body) returns
**400**; a **missing/invalid token** returns **401**; an oversized body returns
**413**.

---

## Response (counts-only)

`200` responses are **counts only** — the endpoint **never echoes prompt or
output content**:

```json
{
  "traces": 0,
  "imported": 0,
  "deduped": 0,
  "steps": 0,
  "requestMissing": 0,
  "responseMissing": 0,
  "invalid": 0,
  "truncated": false
}
```

| Field | Meaning |
| --- | --- |
| `traces` | Records that normalized successfully (valid `eval-record` v1). |
| `imported` | New traces persisted this request. |
| `deduped` | Records skipped as duplicates of an already-stored `id`. |
| `steps` | Total trace steps stored (messages + tool calls/results across imported traces). |
| `requestMissing` | Always `0` — a record with no `input.messages` is rejected as `invalid` instead. |
| `responseMissing` | Imported records that carried no `output.content`. |
| `invalid` | Malformed records skipped (does not fail the batch). |
| `truncated` | `true` if the batch hit the per-request step cap and stopped early — resend the remainder. |

### Limits

- **8 MB** max request body (UTF-8), **1000** records per request, **2000** messages per record, **10,000** total steps per request. Over the body/record limit → `413`; over the step cap → the batch stops and `truncated` is `true`. Split larger exports into batches.

---

## Idempotency & dedup

Dedup is keyed on `(source "native", id)`. Re-POSTing a record with the same `id`
is a no-op that reports as `deduped` — safe to retry a batch after a network
failure without double-counting. Omit `id` and a deterministic id is derived from
the record's content, so byte-identical records still dedup; records that differ
in any content get distinct derived ids.

---

## Data & redaction boundary

- **Per-project isolation.** The ingest token scopes every write to one project.
  Blind Bench holds no customer credentials; there is no outbound call to your
  provider or gateway.
- **Counts-only responses.** The endpoint returns aggregate counts and never
  echoes stored prompt/output content.
- **Server-side redaction at ingest.** Redaction is **key-name based**: fields
  inside tool arguments, tool results, and state whose key matches a sensitive
  category — `ssn` / `social`, `phone`, `email`, `address`, `token`, `secret`,
  `password`, `account_number`, `card`, `dob` — are replaced with `[REDACTED]`
  for blind/reviewer views before storage.
- **Free-text is not auto-scrubbed.** Key-redaction does **not** scan free-text
  `input.messages[].content` or `output.content` for secrets. **Do not send
  secrets in message or answer text that you don't want stored.**

---

## Example — single record

```bash
curl -X POST "https://{deployment}.convex.site/ingest/v1/traces" \
  -H "Authorization: Bearer $BLINDBENCH_INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "version": "1",
    "id": "req-2026-07-08-0001",
    "timestamp": "2026-07-08T14:03:21Z",
    "model": "anthropic/claude-4.7-opus",
    "provider": "anthropic",
    "product": "support-assistant",
    "module": "assistant",
    "environment": "prod",
    "input": {
      "messages": [
        { "role": "system", "content": "You are a support agent." },
        { "role": "user", "content": "Where is my order?" }
      ]
    },
    "output": {
      "content": "Your order shipped yesterday and arrives Thursday.",
      "tool_calls": [
        { "id": "call-1", "name": "lookup_order", "arguments": { "order_id": "O-42" } }
      ],
      "tool_results": [
        { "tool_call_id": "call-1", "name": "lookup_order", "result": { "status": "shipped" } }
      ]
    },
    "usage": { "input_tokens": 210, "output_tokens": 34, "cost_usd": 0.004, "duration_ms": 1180 },
    "harness": { "name": "support-svc", "version": "1.4.0", "sdk": "blindbench-native" },
    "privacy_class": "internal",
    "metadata": { "tenant": "acme", "prompt_version": "v7" }
  }'
```

## Example — batch

```bash
curl -X POST "https://{deployment}.convex.site/ingest/v1/traces" \
  -H "Authorization: Bearer $BLINDBENCH_INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "records": [
      {
        "version": "1",
        "id": "req-0001",
        "model": "anthropic/claude-4.7-opus",
        "provider": "anthropic",
        "input": { "messages": [{ "role": "user", "content": "Summarize this ticket." }] },
        "output": { "content": "Customer reports a billing discrepancy." }
      },
      {
        "version": "1",
        "id": "req-0002",
        "model": "anthropic/claude-4.7-sonnet",
        "provider": "anthropic",
        "input": { "messages": [{ "role": "user", "content": "Draft a reply." }] },
        "output": { "content": "Hi — thanks for flagging this…" },
        "usage": { "input_tokens": 88, "output_tokens": 120 }
      }
    ]
  }'
```

A bare array (`[ {…}, {…} ]`) is accepted identically.

---

## Related

- [`live-emitter.md`](./live-emitter.md) — a thin **client-side reference
  emitter** (`src/lib/evals/liveEmitter.ts`) that batches a running harness's
  model/tool interactions to this endpoint. Async, env-gated (off by default),
  graceful if the backend is down.
- [`gateway-onboarding.md`](./gateway-onboarding.md) — the Cloudflare AI Gateway
  **adapter** path (export/upload logs to backfill), end to end.
- [`cloudflare-gateway-live-import.md`](./cloudflare-gateway-live-import.md) — the
  gateway log import mechanics.
- **OTLP endpoint** — `POST /otlp/v1/traces` on the same `.convex.site` host,
  authenticated by the **same** per-project ingest tokens. Use it for live
  OTel-based capture; it normalizes into this same `eval-record` v1 spine.
