# Cloudflare AI Gateway — live log import

Import production prompt traffic from a customer-owned Cloudflare AI Gateway
into Blind Bench as deduplicated trace imports, so it can become a measurable
eval set.

**Blind Bench makes no calls to Cloudflare.** The customer exports logs from
their own gateway and pastes/uploads them. This keeps the data boundary
one-directional and avoids holding any Cloudflare credentials.

For the full end-to-end onboarding checklist (permissions, metadata, baseline
eval, candidate rows), see [`gateway-onboarding.md`](./gateway-onboarding.md).

## 1. Export from Cloudflare

Pull request logs from the customer's gateway — either path produces JSONL
(one JSON object per line):

- **Dashboard:** AI Gateway → select gateway → Logs → filter by time/product →
  export.
- **API / Logpush:**
  ```
  GET https://api.cloudflare.com/client/v4/accounts/<account>/ai-gateway/gateways/<gateway>/logs
  ```
  or a Logpush job writing the gateway dataset to object storage.

Required token scope: **AI Gateway — Read**, scoped to the specific account and
gateway (not a global key). See the in-app *Gateway onboarding* page for the
metadata conventions (`product`, `module`, `prompt_version`, …) that make
imported logs groupable.

The parser reads common field shapes opportunistically:

| Field | Source paths tried |
| --- | --- |
| dedup id | `log_id`, `id`, `event_id`, `cf.ray_id` (else a content hash) |
| messages | `request.messages`, `request.input.messages`, `request.prompt` |
| output | `response.output_text` / `.text` / `.content`, `response.choices[0].message.content` |
| model / provider | `model`, `request.model`, `response.model` / `provider`, … |
| usage | `usage.*_tokens`, `tokens_in` / `tokens_out` |
| cost / duration | `cost` / `cost_usd`, `duration` / `duration_ms` / `latency_ms` |
| timestamp | `timestamp`, `created_at`, `datetime` |

## 2. Import

1. Org sidebar → **Import Gateway logs** (or *Gateway onboarding → Import
   Gateway logs*).
2. Select the destination project (you must be **owner** or **editor**).
3. Paste the JSONL and click **Import Gateway logs**.

The importer returns a management-safe summary: imported / deduped / parsed
counts, invalid line numbers, missing-request / missing-response counts, the
set of models and providers seen, and the earliest/latest timestamp.

## 3. Data boundary

- **Import identity** is persisted: `(projectId, source, sourceTraceId)` rows
  in the `traceImports` table.
- For each new (non-duplicate) trace, the **raw source record** is persisted to
  **access-controlled Convex storage** (`rawPayloadStorageId`) so imports can
  be re-parsed/materialized into eval sets without re-export. Duplicates are
  never stored again.
- The UI **never renders trace content back** — counts, model/provider names,
  and timestamps only. The stored raw payload is reachable only through
  access-controlled server code, never in a query response or summary.
- Invalid lines are reported by **line number**, never by content, so a
  malformed line can't leak into an error message.

## 4. Limits

| Limit | Value | Behavior on exceed |
| --- | --- | --- |
| Lines per import | 5,000 | Stops early, `truncated: true` in summary |
| Payload size | 8 MB | Importer rejects with a "split into batches" error |
| Invalid lines reported | 50 | Remainder counted but line numbers omitted |

Defaults live in `convex/traceAdapters/cloudflareAiGateway.ts`
(`DEFAULT_LIMITS`).

## 5. Verification

- Pure parser unit tests: `npm run test:convex` (covers
  `convex/traceAdapters/cloudflareAiGateway.test.ts` — no Convex backend
  needed).
- Local exported-JSONL adapter tests: `env -u NODE_ENV npm run test:evals`.
- Manual: paste a small synthetic JSONL sample, confirm the summary counts;
  re-paste the same sample and confirm everything reports as **deduped**.

## 6. Rollback

The change is additive — a new source literal, a parser module, one import
action (plus its internal mutations), one route. To disable:

- **Hide the entry point:** remove the *Import Gateway logs* links in
  `src/components/SideNavContent.tsx` and `GatewayOnboarding.tsx`, and the
  `gateway-import` route in `src/App.tsx`.
- **Disable the importer:** remove/guard `importGatewayLogs` in
  `convex/gatewayImport.ts`.
- The `cloudflare_ai_gateway` source literal in the schema can stay; removing
  it requires there be no rows using it.

No external state is created, so rollback needs no Cloudflare-side action.

## Follow-up (not in this slice)

- **Materialization:** turn imported traces into prompt versions / completed
  run outputs (`setMaterialized` already exists) to drive baseline evals.
- **Sidecar metadata merge:** the local adapter supports a `trace_id`-keyed
  sidecar for fields too large for Gateway custom metadata; the Convex importer
  does not yet accept one.
