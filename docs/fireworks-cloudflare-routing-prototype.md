# Fireworks custom model → Cloudflare AI Gateway routing (operator runbook)

Exact, customer-generic steps to deploy a Fireworks fine-tuned/custom model and route it
through Cloudflare AI Gateway, then feed the captured logs into the existing eval pipeline.

**No production or customer data.** Use synthetic prompts (Migo/Eavesly-style) for the smoke
test. Secrets stay in your secret store / env — they never go into the repo, the generated
artifacts, or Gateway logs.

The generator is local-only and makes **no live request**:

```bash
npm run prototype:fireworks-gateway                 # synthetic example → artifacts/
npm run prototype:fireworks-gateway -- --print-curl # also print the redacted cURL
npm run prototype:fireworks-gateway -- --config ./route.json --strict
```

Outputs (gitignored): `artifacts/fireworks-cloudflare-routing-prototype.{json,md}`.

`--strict` (or `PROTOTYPE_STRICT=1`) requires real config and **fails closed** if any of
`CF_ACCOUNT_ID`, `CF_AIG_GATEWAY`, `FIREWORKS_MODEL`, `TENANT_LABEL`, `PRODUCT` is missing.

## 1. Train / deploy the Fireworks custom model

1. Use an **approved, reviewed** training dataset (e.g. the compiler in `trainingDataset.ts`).
   No raw customer transcripts that haven't cleared review.
2. Create the fine-tune in Fireworks (dashboard or `firectl`), producing a model id like
   `accounts/<account>/models/<custom-model>`.
3. Deploy it to a serverless or dedicated deployment; note the deployment id.
4. Confirm the model answers via the Fireworks API directly with a synthetic prompt before
   adding the Gateway hop (isolates provider vs. gateway issues).

## 2. Create / route the Cloudflare AI Gateway provider

1. Create (or reuse) an AI Gateway in the correct Cloudflare account. Record the gateway id/name.
2. Enable **Authenticated Gateway** and mint a Gateway token (`CF_AIG_TOKEN`) — this is
   separate from the upstream Fireworks key.
3. Two routing shapes are emitted; the **compat** path is the default because it uses Cloudflare's OpenAI-compatible Gateway surface. Pick one with `CF_AIG_MODE` after a synthetic smoke confirms logs round-trip:
   - **provider**: `…/<account>/<gateway>/fireworks-ai/chat/completions` (provider-specific candidate; confirm against Cloudflare docs/smoke before relying on it)
   - **compat** (default): `…/<account>/<gateway>/compat/chat/completions`, selecting the provider via the
     `model` field (`fireworks-ai/<model>`).
4. Set env and generate the route plan:
   ```bash
   export CF_ACCOUNT_ID=… CF_AIG_GATEWAY=… FIREWORKS_MODEL=… TENANT_LABEL=… PRODUCT=…
   npm run prototype:fireworks-gateway -- --strict --print-curl
   ```

## 3. Send a synthetic smoke request

1. Export the two secrets as env vars (never inline them):
   ```bash
   export FIREWORKS_API_KEY=…   # upstream provider key
   export CF_AIG_TOKEN=…        # gateway token
   ```
2. Run the redacted cURL from the runbook artifact. The body carries `metadata` (and the
   request also sends a `cf-aig-metadata` header) with: `product`, `module`, `prompt_version`,
   `variant`, `release`, `environment`, `tenant`, `trace_id`, `session_id`.
3. Use a **real unique** `trace_id`/`session_id` per request; the generated synthetic ids are
   deterministic placeholders for review only.

## 4. Export and inspect logs

Confirm the Gateway log for the request captures every normalized field — these map 1:1 to
what `cloudflareAiGateway.ts` reads:

| Field | Expect |
| --- | --- |
| `provider` | Fireworks provider slug. |
| `model` | Resolved custom/fine-tuned model id. |
| `cost_usd` | Per-request cost where reported (may be null). |
| `duration_ms` | End-to-end latency. |
| `usage` | input / output / total tokens. |
| `metadata` | all metadata keys round-trip. |
| `status` | success/error. |
| `redaction` | if bodies are stripped by log settings, the normalizer flags them — expected/safe. |

Export via Logpush or the Gateway logs API as JSONL.

## 5. Normalize → score

```ts
import { parseCloudflareAiGatewayJsonl } from "@/lib/evals/cloudflareAiGateway";
const traces = parseCloudflareAiGatewayJsonl(exportedJsonl, { defaultProduct, defaultEnvironment });
```

Then `convertTraceToEvalCase()` to seed eval cases and run the scorecard
(`npm run scorecard:customer-pilot`). Replay seeds derived from real traces stay
`customer_scoped_review_only`.

## Auth & tenant isolation requirements

- **Two distinct credentials**: upstream `FIREWORKS_API_KEY` and gateway `CF_AIG_TOKEN`.
  Both env-only; never committed, never logged.
- **One Fireworks key + one Gateway (+ `metadata.tenant`) per tenant.** Do not share keys,
  gateways, or models across tenants — isolation is enforced at the credential and gateway
  boundary, with `tenant` metadata for log attribution.
- Rotate keys out of band; revoking the Gateway token cuts routing without touching the
  upstream provider key.
- Keep environments (`staging` vs `production`) on separate gateways or clearly separated by
  the `environment` metadata so logs never cross-pollinate.
