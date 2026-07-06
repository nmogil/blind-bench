# Cloudflare AI Gateway — user onboarding guide

End-to-end checklist for a Blind Bench user to take a Cloudflare AI Gateway from
"logs exist somewhere" to "I have a baseline scorecard and a shortlist of rows
worth training on." It stitches together the pieces that already ship:

- The in-app onboarding page — `src/routes/orgs/GatewayOnboarding.tsx`
- The no-code import page — `src/routes/orgs/GatewayImport.tsx`
- The live log import path — [`cloudflare-gateway-live-import.md`](./cloudflare-gateway-live-import.md)
- The baseline / candidate eval runner — [`baseline-candidate-comparison.md`](./baseline-candidate-comparison.md)
- The Fireworks → Gateway routing runbook — [`fireworks-cloudflare-routing-prototype.md`](./fireworks-cloudflare-routing-prototype.md)

**Data boundary, up front.** Blind Bench makes **no calls to Cloudflare**. You
export logs from your own gateway and paste/upload them; Blind Bench never holds
a Cloudflare credential (see `cloudflare-gateway-live-import.md` §3). Real
production logs stay `prod_sensitive` and customer-scoped inside the workspace —
never commit them to the repo. The repo and any demo use **synthetic or redacted
samples only**.

---

## Onboarding checklist

Work top to bottom. Steps 1–6 need **no Fireworks credentials** — you can reach a
published baseline scorecard before any model-training work. Fireworks enters
only at step 7.

1. **Connect Gateway logs (API, Logpush, or dashboard export).** Get request
   logs out of your Cloudflare AI Gateway as JSONL (one JSON object per line).
   Three ways, covered under [Two ways to feed logs in](#two-ways-to-feed-logs-in)
   below. Requires an **AI Gateway — Read** scoped token (see
   [Required Cloudflare permissions](#required-cloudflare-permissions)).
2. **Set metadata conventions.** Before (or as) you generate traffic, tag each
   Gateway request with the [metadata conventions](#metadata-conventions) so
   imported logs are groupable by product, module, and prompt version. Retrofitting
   metadata onto already-logged traffic is not possible — logs only carry the
   metadata that was attached at request time.
3. **Pick a product / use-case + eval pack.** Choose one or two high-traffic
   prompts to onboard first so the baseline is meaningful. Blind Bench ships
   synthetic example surfaces (`migo`, `eavesly`) in
   `src/routes/orgs/GatewayOnboarding.tsx` to model your own against. The eval
   pack is the set of deterministic scorers you will run — the shipped pilot pack
   is `customer-pilot/smoke` (see `docs/customer-ai-quality-scorecard-handoff.md`).
4. **Create your first dataset from filtered logs.** Filter the export by
   product / time window, then import it (step 1's path). Each new, non-duplicate
   trace is stored as a deduplicated `traceImports` row; the importer returns a
   summary (imported / deduped / parsed / invalid counts, models, providers, and
   the time window). **Manual/planned:** turning imported traces into runnable
   eval cases uses `setMaterialized` in the backend, but the Convex importer does
   not yet expose materialization in the UI (see
   `cloudflare-gateway-live-import.md` "Follow-up"). Today the local path
   (`normalizeCloudflareAiGatewayLog → convertTraceToEvalCase`) is how a trace
   becomes an eval case.
5. **Run a baseline eval.** Score the current production prompt against the pack
   to establish the baseline scorecard. The runner is
   `src/lib/evals/modelComparison.ts` (`npm run compare:customer-pilot`), and the
   customer-facing scorecard is `npm run scorecard:customer-pilot`. Both are
   local, deterministic, and management-safe — they emit only case IDs, product
   labels, scorer IDs, scores, and aggregate counts, never raw prompts or outputs
   (see [`baseline-candidate-comparison.md`](./baseline-candidate-comparison.md)).
6. **Identify candidate rows for training / synthetic expansion.** From the
   baseline, pull the rows worth improving: hard-fail cases, low-scoring cases, or
   thin coverage areas you want to expand with synthetic edge cases. These become
   the review candidates that later feed the training-dataset compiler
   (`src/lib/evals/trainingDataset.ts`, see
   [`training-dataset-compiler.md`](./training-dataset-compiler.md)). Real rows
   still require explicit training approval and a policy flag before they can be
   exported.
7. **(Later) Add Fireworks credentials + candidate model.** Only once a baseline
   exists do you wire a Fireworks-hosted candidate to A/B against production. This
   is the **only** step that needs a Fireworks API key — see
   [Where Fireworks credentials enter](#where-fireworks-credentials-enter).

---

## Required Cloudflare permissions

Use an **API token scoped to the specific account and gateway** — never a global
API key.

| Capability | Scope needed | When |
| --- | --- | --- |
| Read / export Gateway request logs (API or Logpush) | **AI Gateway — Read** | Steps 1 and 4 — every import path. |
| Configure gateways or metadata rules | **AI Gateway — Edit** | Only if you set up gateways or metadata routing yourself. |
| Logpush job to object storage | Logpush configured on the account + the storage destination's own credentials | Only if you use Logpush instead of the logs API. |

Notes:

- The `AI Gateway — Read` token is the `CF_API_TOKEN` used by the live smoke
  script to read back the logs API (`fireworks-cloudflare-routing-prototype.md`
  §"Auth & key handling"). It is distinct from the gateway edge-auth token
  (`CF_AIG_TOKEN`) and from any upstream provider key.
- Blind Bench never receives any of these tokens — you run the export yourself
  and paste the resulting JSONL.

---

## Metadata conventions

Attach these keys to every Gateway request so logs stay groupable after import.
The convention (from `fireworks-cloudflare-routing-prototype.md` §3 and the
in-app onboarding page):

| Key | Meaning |
| --- | --- |
| `product` | Top-level product, e.g. `migo` / `eavesly`. |
| `module` | Sub-surface within the product, e.g. `assistant` / `summarizer`. |
| `prompt_version` | Version tag of the prompt that produced the output. |
| `variant` | `control` / `candidate` — which arm of an A/B. |
| `release` | App release or deploy identifier. |
| `environment` | `prod` / `staging` / `dev` — keep prod data customer-scoped. |
| `tenant` | Tenant label for log attribution and per-tenant isolation. |
| `trace_id` | Request trace id, to correlate with app logs. Use a **real unique** value per request. |
| `session_id` | Conversation / session id where available. |

**Cloudflare custom-metadata limits.** AI Gateway stores **at most 5 custom
metadata entries per request and silently drops the rest** (verified live
2026-07-06: a 9-key `cf-aig-metadata` header came back in the log with only its
first 5 keys). Choose your ≤5 keys deliberately — `trace_id` must always be one
of them, or you lose log↔app correlation entirely. Blind Bench's default
priority is `trace_id, tenant, product, prompt_version, variant`
(`SMOKE_METADATA_KEYS` in `src/lib/evals/fireworksGatewaySmoke.ts`). Values must
also stay short. Anything larger — full prompt text, long ids, structured
context, and any keys that didn't make the cut — goes in a **sidecar record
keyed by `trace_id`**, not inline in Gateway metadata. Note that the Convex
importer does **not yet accept a sidecar** (the local exported-JSONL adapter
does — see `cloudflare-gateway-live-import.md` "Follow-up"), so for now keep
everything you need for grouping inside your 5 metadata keys.

Metadata travels two ways on a request: in the request body's `metadata` field
and in a `cf-aig-metadata` header
(`fireworks-cloudflare-routing-prototype.md` §3). The Gateway log records the
first 5 header keys, where `src/lib/evals/cloudflareAiGateway.ts` /
`convex/traceAdapters/cloudflareAiGateway.ts` read them back.

---

## Two ways to feed logs in

### No-code / manual path (Gateway Import UI)

Described by `src/routes/orgs/GatewayImport.tsx` and
`src/routes/orgs/GatewayOnboarding.tsx` — do not change that code; this is what
the user sees:

1. Cloudflare dashboard → **AI Gateway** → select your gateway → **Logs**.
2. Filter by product / time window and **export** the log set (JSON/JSONL).
3. In Blind Bench, open the org sidebar → **Gateway onboarding**, then
   **Import Gateway logs** (route `/orgs/<slug>/gateway-import`).
4. Select the destination **project** (you must be project **owner** or
   **editor**).
5. Paste the JSONL and click **Import Gateway logs**.
6. Read the **import summary** card: imported / deduped / parsed / invalid-line
   counts, missing-request / missing-response counts, the set of models and
   providers seen, and the earliest/latest timestamp. The UI **never renders
   trace content back** — counts, model/provider names, and timestamps only.

Batch limits (from `convex/traceAdapters/cloudflareAiGateway.ts` `DEFAULT_LIMITS`):
**5,000 lines** and **8 MB** per import — split larger exports into batches; the
summary flags `truncated` when it stops early.

### CLI / API path

Use the logs API (or a Logpush job) to pull JSONL, then normalize and score
locally:

```bash
# Export: pull request logs as JSONL (AI Gateway — Read token)
GET https://api.cloudflare.com/client/v4/accounts/<account>/ai-gateway/gateways/<gateway>/logs

# Normalize exported JSONL → eval cases (src/lib/evals/cloudflareAiGateway.ts)
#   parseCloudflareAiGatewayJsonl(...) → convertTraceToEvalCase(...)

# Baseline / candidate comparison + scorecard (local, deterministic)
npm run compare:customer-pilot
npm run scorecard:customer-pilot
```

The same JSONL can also be pasted into the no-code importer above — the two paths
share the parser. For a live, env-gated smoke that sends one synthetic request
through the Gateway and verifies the log round-trip, see
`scripts/fireworks-gateway-smoke.ts` (`npm run smoke:fireworks-gateway`) in
`fireworks-cloudflare-routing-prototype.md`.

---

## Where Fireworks credentials enter

Fireworks credentials enter the flow **only at model training / deployment and
the live smoke** — never for log import or for running evals on existing traffic:

- **Not needed** for steps 1–6: connecting logs, setting metadata, importing,
  baseline evals, and identifying candidate rows all run without any Fireworks
  key. Everything the local eval runner and scorecard do is offline.
- **Needed** at step 7 only: creating/deploying the Fireworks fine-tuned model
  (`FIREWORKS_API_KEY`, used by `firectl` and the direct-serve check) and routing
  it through the Gateway for a head-to-head. See
  [`fireworks-cloudflare-routing-prototype.md`](./fireworks-cloudflare-routing-prototype.md)
  §§1–3.

Three credentials stay distinct and env-only — none ever enters the repo,
artifacts, or Gateway logs (routing runbook §"Auth & key handling"):

| Credential | Job |
| --- | --- |
| `FIREWORKS_API_KEY` | Authenticates to Fireworks (the provider running the model). |
| `CF_AIG_TOKEN` | Authenticates the caller to the Cloudflare AI Gateway edge. |
| `CF_API_TOKEN` | Reads back the Gateway logs API (the AI Gateway — Read token). |

Per-tenant isolation: prefer a **separate gateway per tenant**, or at minimum a
distinct `metadata.tenant` label **plus BYOK / model-deployment namespacing** so
one tenant's key can never route another tenant's traffic. Isolation is enforced
at the credential and gateway boundary (routing runbook §"Per-tenant separation
requirements").
