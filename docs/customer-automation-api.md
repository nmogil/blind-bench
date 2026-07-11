# Blind Bench customer automation API

Use this API to upload completed `eval-record` v1 artifacts and automate blind verdict reviews without access to the Blind Bench backend repository.

## Prerequisite and authentication

A project owner or editor must currently issue the token in the Blind Bench app:

1. Open the project.
2. Go to **Settings → Data sources → Continuous ingest**.
3. Choose **Automation (ingest + manage reviews)**, issue the token, and copy it immediately. The full token is shown once; later lists show only a masked preview.

Send the token in either header:

```http
Authorization: Bearer $BLINDBENCH_API_TOKEN
```

or:

```http
x-blindbench-api-token: $BLINDBENCH_API_TOKEN
```

Tokens are project-scoped and use an exact capability allowlist:

| Scope | Allows |
|---|---|
| `traces:write` | Upload native `eval-record` v1 or OTLP traces |
| `reviews:write` | Create/open and close verdict reviews |
| `reviews:read` | Read management-safe review status |

The default **Ingest only** preset grants only `traces:write`. Tokens issued before scoped tokens existed are also ingest-only. Revocation immediately disables every endpoint.

Set the API base URL to the project's Convex HTTP Actions site, for example `https://example.convex.site`. This is the `.convex.site` URL, not `.convex.cloud`.

## Upload `eval-record` v1

```bash
curl -X POST "$BLINDBENCH_URL/ingest/v1/traces" \
  -H "Authorization: Bearer $BLINDBENCH_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @eval-record.json
```

The endpoint accepts one record, a JSON array, or `{ "records": [...] }`. Its response is counts-only:

```json
{
  "traces": 1,
  "imported": 1,
  "deduped": 0,
  "steps": 2,
  "requestMissing": 0,
  "responseMissing": 0,
  "invalid": 0,
  "truncated": false
}
```

Keep the stable record/trace IDs used by your artifacts. Review creation resolves the resulting `agentTraces.traceId` values, not Blind Bench database IDs. For native records with `id: "case-123"`, the stable trace ID is `native-case-123`.

## Create and open a review

`POST /api/v1/reviews` requires `reviews:write`.

```bash
curl -X POST "$BLINDBENCH_URL/api/v1/reviews" \
  -H "Authorization: Bearer $BLINDBENCH_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Release candidate review",
    "instructions": "Judge correctness and completeness.",
    "trace_ids": ["native-case-123", "native-case-124"],
    "idempotency_key": "release-2026-07-11"
  }'
```

All trace IDs must resolve to ready runs in the token's project. A review contains 1–50 unique runs. Creation opens the review immediately.

```json
{
  "review_id": "k57...",
  "status": "open",
  "item_count": 2,
  "review_url": "https://blindbench.dev/review/verdict/opaque-token"
}
```

Give `review_url` to reviewers. The share token is deliberately not returned as a separate field.

`idempotency_key` is scoped to the project. Retrying an identical request with the same key returns the same review and URL. Reusing the key with a different name, instructions, or trace list returns HTTP `409`.

## Read safe status

`GET /api/v1/reviews?id=<review_id>` requires `reviews:read`.

```bash
curl "$BLINDBENCH_URL/api/v1/reviews?id=k57..." \
  -H "Authorization: Bearer $BLINDBENCH_API_TOKEN"
```

```json
{
  "review_id": "k57...",
  "status": "open",
  "item_count": 2,
  "judgment_count": 3,
  "reviewed_item_count": 2,
  "aggregate": {
    "best": 1,
    "acceptable": 1,
    "weak": 1,
    "disagreement": 1
  }
}
```

`aggregate.disagreement` counts reviewed runs that received more than one distinct verdict. This management projection never includes prompts, outputs, instructions, comments, reviewer names, model/harness/source provenance, source IDs, run IDs, or the share token.

## Close a review

`POST /api/v1/reviews/close` requires `reviews:write`.

```bash
curl -X POST "$BLINDBENCH_URL/api/v1/reviews/close" \
  -H "Authorization: Bearer $BLINDBENCH_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"review_id":"k57..."}'
```

The response has the same safe shape as status with `"status": "closed"`. Closing an already closed review succeeds and returns the same state. A closed review preserves submitted judgments and accepts no new ones.

## CLI

The repository includes a standalone, dependency-light TypeScript CLI. It imports no Convex backend modules and can be copied into an independent package with a TypeScript runner.

```bash
export BLINDBENCH_URL="https://example.convex.site"
export BLINDBENCH_API_TOKEN="..."

npm run blindbench -- --help
npm run blindbench -- upload ./eval-record.json
npm run blindbench -- create \
  --name "Release candidate review" \
  --instructions "Judge correctness and completeness." \
  --idempotency-key "release-2026-07-11" \
  --trace-id native-case-123 \
  --trace-id native-case-124
npm run blindbench -- status --review-id 'k57...'
npm run blindbench -- close --review-id 'k57...'
```

The CLI never prints the API token or raw artifact records. Upload output is counts-only; review output is restricted to IDs, status/counts, and the reviewer URL.

## Errors and limits

All endpoint errors are JSON: `{ "error": "..." }`.

| HTTP status | Meaning |
|---|---|
| `400` | Invalid JSON, missing/unknown field, malformed ID, duplicate trace ID |
| `401` | Missing, invalid, or revoked token |
| `403` | Token lacks the exact required scope |
| `404` | Review or trace is absent from the token's project (including cross-project IDs) |
| `409` | Trace is not ready, idempotency conflict, or invalid lifecycle transition |
| `413` | Request body is too large or more than 50 trace IDs were supplied |

Review API endpoints do not expose wildcard CORS headers. Call them from server-side automation or the CLI, not untrusted browser code.
