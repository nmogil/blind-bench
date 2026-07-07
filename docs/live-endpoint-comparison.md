# Live endpoint comparison (issue #229)

Runs one eval pack against **two live OpenAI-compatible endpoints** — the current
production/baseline model and a Fireworks candidate routed through Cloudflare AI
Gateway — then scores both sides with the standard scorer pack and emits the
baseline-vs-candidate comparison report with CI exit semantics.

This is the live-capture layer on top of the fixture-based comparison documented
in `baseline-candidate-comparison.md`. The comparison, recommendation, and
report logic are identical; only the source of the outputs differs.

## Run it

```bash
npm run compare:endpoints -- \
  --pack demo/smoke \
  --baseline ./baseline-endpoint.json \
  --candidate fireworks:env \
  --out-dir artifacts
```

Writes `artifacts/live-endpoint-comparison.{md,json}` plus the captured outputs
(`.baseline-outputs.json` / `.candidate-outputs.json`) — the captured files are
replayable offline via `npx tsx src/lib/evals/cli.ts --candidate-fixtures <file>`.

Exit code is non-zero when the recommendation is blocking: any privacy/tool-safety
hard-fail regression, or incomplete candidate coverage (including failed requests —
capture errors fail closed).

## Endpoint config

A JSON file per endpoint:

```json
{
  "label": "baseline (gpt-4o via openrouter)",
  "url": "https://openrouter.ai/api/v1/chat/completions",
  "model": "openai/gpt-4o",
  "headers": { "Authorization": "Bearer $OPENROUTER_API_KEY" }
}
```

Header values use `$ENV_VAR` placeholders resolved from the environment at
request time — **never put raw secrets in config files**. Optional fields:
`max_tokens` (default 512), `temperature` (default 0).

## Fireworks candidate via `fireworks:env`

`--candidate fireworks:env` builds the candidate endpoint from the same env vars
as the routing prototype (`fireworks-cloudflare-routing-prototype.md`):
`CF_ACCOUNT_ID`, `CF_AIG_GATEWAY`, `FIREWORKS_MODEL`, `TENANT_LABEL`, `PRODUCT`
(required), plus `CF_AIG_MODE`, `MODULE`, `PROMPT_VERSION`, `VARIANT`, `RELEASE`,
`ENVIRONMENT` (optional), and the two secrets `FIREWORKS_API_KEY` and
`CF_AIG_TOKEN`. It fails closed when required config is missing. Requests carry
the `cf-aig-metadata` header, so the run's traces land in Gateway logs with the
standard metadata and can be re-ingested via `cloudflareAiGateway.ts`.

## Metrics

- **Latency** — measured client-side around each request.
- **Tokens** — `usage.total_tokens` from the provider response.
- **Cost** — `usage.cost` when the provider reports it (often absent; Cloudflare
  AI Gateway logs are the authoritative cost source — see #220).

## Privacy

The Markdown/JSON reports keep the management-safe contract (case IDs, scorer
IDs, scores, aggregates only). The captured `*-outputs.json` files DO contain raw
model output — they are written to the gitignored `artifacts/` directory for
replay/debugging. The demo pack is fully synthetic; when running packs
derived from production logs, treat the captured output files per the case's
`privacy_class`.
