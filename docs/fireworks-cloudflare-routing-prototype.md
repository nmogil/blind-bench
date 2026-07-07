# Fireworks custom model → Cloudflare AI Gateway routing (operator runbook)

Exact, customer-generic steps to deploy a Fireworks fine-tuned/custom model and route it
through Cloudflare AI Gateway, then feed the captured logs into the existing eval pipeline.

For the user-facing onboarding checklist that precedes this runbook (connect logs → metadata
→ baseline eval → candidate rows), see [`gateway-onboarding.md`](./gateway-onboarding.md).

**No production or customer data.** Use synthetic prompts (support-assistant/doc-summarizer-style) for the smoke
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

### Exact deployment path (`firectl`)

Concrete, customer-generic command sequence. Ids below are placeholders; the real account is
`accounts/<account>` and `firectl` reads `FIREWORKS_API_KEY` from the env (never inline it).

```bash
# 0. Auth (key stays in the env / secret store).
export FIREWORKS_API_KEY=…

# 1. Upload the approved, synthetic-or-reviewed dataset (JSONL of {messages:[…]} rows).
firectl create dataset example-eval-ft-0001 ./artifacts/training-dataset.jsonl
#   → dataset id: accounts/<account>/datasets/example-eval-ft-0001

# 2. Launch supervised fine-tuning against a base model.
firectl create fine-tuning-job \
  --base-model accounts/fireworks/models/llama-v3p1-8b-instruct \
  --dataset accounts/<account>/datasets/example-eval-ft-0001 \
  --output-model example-eval-ft-0001
#   → job id: accounts/<account>/fineTuningJobs/<job>
#   Poll: firectl get fine-tuning-job accounts/<account>/fineTuningJobs/<job>
#   On COMPLETED the tuned model id is: accounts/<account>/models/example-eval-ft-0001

# 3a. Serverless: many tuned models serve on-demand with no explicit deployment —
#     skip to the direct-serve check below and use the model id as-is.
# 3b. Dedicated: create a deployment for guaranteed capacity / low latency.
firectl create deployment accounts/<account>/models/example-eval-ft-0001
#   → deployment id: accounts/<account>/deployments/<deployment>
```

- **Model id format**: `accounts/<account>/models/<custom-model>` — this is `FIREWORKS_MODEL`.
- **Deployment id format**: `accounts/<account>/deployments/<deployment>` — optional
  (`FIREWORKS_DEPLOYMENT_ID`), only for dedicated deployments.
- **Confirm it serves directly before the Gateway hop** (isolates provider vs. gateway):

  ```bash
  curl -sS https://api.fireworks.ai/inference/v1/chat/completions \
    -H "Authorization: Bearer $FIREWORKS_API_KEY" \
    -H "Content-Type: application/json" \
    -d '{"model":"accounts/<account>/models/example-eval-ft-0001",
         "messages":[{"role":"user","content":"Synthetic smoke prompt. Reply with: ok."}],
         "max_tokens":16}'
  ```

  A normal completion here means the model serves; only then add the Cloudflare Gateway.

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
   request also sends a `cf-aig-metadata` header). **The Gateway keeps at most 5 metadata
   entries per request and silently drops the rest** (verified live 2026-07-06), so the smoke
   sends exactly the priority set `trace_id`, `tenant`, `product`, `prompt_version`, `variant`
   (`SMOKE_METADATA_KEYS` / `capMetadataForGateway` in `fireworksGatewaySmoke.ts`). `trace_id`
   must always survive the cap — it is the only way to correlate the log back to the request.
3. Use a **real unique** `trace_id` per request; the generated synthetic ids are
   deterministic placeholders for review only.

### Automated: live smoke + log verification

`scripts/fireworks-gateway-smoke.ts` (`npm run smoke:fireworks-gateway`) is the automated,
env-gated version of steps 3–5: it sends one synthetic request through the Gateway with a
freshly generated unique `trace_id`, polls the Gateway logs API until that trace appears,
normalizes it with `cloudflareAiGateway.ts`, runs `verifyGatewayLog`, and writes a **redacted**
report to `artifacts/fireworks-gateway-smoke.{json,md}` (gitignored). It exits non-zero on
verification failure.

```bash
# Fails CLOSED unless all of these are set (secrets stay env-only, never committed):
export CF_ACCOUNT_ID=…      # gateway account
export CF_AIG_GATEWAY=…     # gateway id/name
export CF_AIG_TOKEN=…       # gateway edge-auth token
export FIREWORKS_API_KEY=…  # upstream provider key
export FIREWORKS_MODEL=accounts/<account>/models/example-eval-ft-0001
export CF_API_TOKEN=…       # Cloudflare API token — reads the Gateway logs API (live only)

npm run smoke:fireworks-gateway -- --dry-run   # prints the redacted request, sends nothing
npm run smoke:fireworks-gateway                 # live send → poll logs → verify → artifacts
```

`--dry-run` needs only the five required vars (not `CF_API_TOKEN`) and never touches the
network. Expected live output:

```text
Sending synthetic smoke request (trace_id=smoke-…)…
Gateway responded HTTP 200.
Polling Gateway logs for trace_id (timeout 60s)…
Verification: PASS
  note: cost_usd present: 0.0001            # or "absent … not fatal"
  note: body redaction observed …           # only if bodies stripped by log settings
Wrote artifacts/fireworks-gateway-smoke.{json,md}.
```

The verifier asserts provider slug, resolved model id, usage tokens, `duration_ms`, metadata
round-trip (incl. `trace_id`), and success status. `cost_usd` being null and body redaction are
reported as **notes, not failures**.

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
| `metadata` | the ≤5 sent keys round-trip (Gateway cap — see §3). |
| `status` | success/error. |
| `redaction` | if bodies are stripped by log settings, the normalizer flags them — expected/safe. |

Export via Logpush or the Gateway logs API as JSONL.

## 5. Normalize → score

```ts
import { parseCloudflareAiGatewayJsonl } from "@/lib/evals/cloudflareAiGateway";
const traces = parseCloudflareAiGatewayJsonl(exportedJsonl, { defaultProduct, defaultEnvironment });
```

Then `convertTraceToEvalCase()` to seed eval cases and run the scorecard
(`npm run scorecard:demo`). Replay seeds derived from real traces stay
`customer_scoped_review_only`.

## Auth & key handling / tenant isolation

Three **distinct** credentials, each with one job. All env-only — they never enter the repo,
the generated artifacts, or Gateway logs. The smoke CLI redacts the two request secrets to
`$FIREWORKS_API_KEY` / `$CF_AIG_TOKEN` placeholders before printing or writing anything.

| Credential | Where it lives | What it does |
| --- | --- | --- |
| `FIREWORKS_API_KEY` | request `Authorization: Bearer …` header (upstream) | Authenticates to Fireworks — the provider that actually runs the model. |
| `CF_AIG_TOKEN` | request `cf-aig-authorization: Bearer …` header (gateway edge) | Authenticates the caller **to the Cloudflare AI Gateway** (Authenticated Gateway). Separate from the upstream key. |
| `CF_API_TOKEN` | logs read (`Authorization: Bearer …` on the Cloudflare API) | Reads back the Gateway logs API for verification. Never sent to Fireworks. |

**Per-tenant separation requirements:**

- **One Fireworks key + one Gateway (+ `metadata.tenant`) per tenant.** Do not share keys,
  gateways, or models across tenants — isolation is enforced at the credential and gateway
  boundary, with the `tenant` metadata label for log attribution.
- Never share a Fireworks account across tenants without model/deployment namespacing; prefer
  a **separate gateway** per tenant, or at minimum a distinct `metadata.tenant` label **plus
  BYOK** so one tenant's key can never route another tenant's traffic.
- Keys never enter the repo, artifacts, or logs. Rotate out of band; revoking `CF_AIG_TOKEN`
  cuts routing without touching the upstream key, and revoking `CF_API_TOKEN` cuts log access
  without touching either.
- Keep environments (`staging` vs `production`) on separate gateways or clearly separated by
  the `environment` metadata so logs never cross-pollinate.
