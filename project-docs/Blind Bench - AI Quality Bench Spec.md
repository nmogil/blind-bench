---
title: "Blind Bench - AI Quality Bench Spec"
created: 2026-07-05
modified: 2026-07-05
type: product-spec
status: draft
tags:
  - blind-bench
  - product
  - spec
  - m30
---

# Blind Bench — AI Quality Bench Spec

> **DRAFT for Noah's review.** This one-pager defines the M30 "AI Quality Bench"
> product loop. Every capability claim is grounded in a shipped repo file (cited
> inline). **Strategy calls — pricing, ICP prioritization, packaging — are
> stated as recommendations, not decisions.** They are Noah's to make.

> Part of [[MOC - Blind Bench]]. Companion to [[Blind Bench - Positioning]]
> (reviewer-surface framing) and [[Blind Bench - Architecture]].

---

## What this is

The AI Quality Bench is the closed loop that turns a team's live Cloudflare AI
Gateway traffic into measurably better fine-tuned models routed back through the
same Gateway, with a management-safe scorecard as the handoff artifact.

It is a superset framing of Blind Bench's reviewer surface (see
[[Blind Bench - Positioning]]): the human review step stays the honesty mechanic,
but the loop now closes all the way from **production logs → evals → training →
routed candidate → scorecard**.

---

## ICP (recommendation)

**Recommended primary ICP:** a team already running **Cloudflare AI Gateway** in
production for one or more customer-facing LLM surfaces, that needs to prove and
improve output quality without standing up an eval/training stack themselves.

- **Beachhead customer:** Pennie (Migo / Eavesly surfaces) — the pilot the loop
  is being hardened against (`docs/customer-pilot-sow.md`,
  `docs/customer-ai-quality-scorecard-handoff.md`).
- **Generic ICP:** any CF AI Gateway user with enough traffic that a baseline is
  meaningful and enough quality pain to want a fine-tuned candidate.
- **Buyer vs. user (carry-over from Positioning):** the developer/PM who ships
  the prompts is the buyer-influencer; the domain reviewer signs off on quality.

> **Open strategy call (Noah):** whether to lead go-to-market with Pennie-style
> hands-on pilots or the self-serve generic CF user. The billing foundation
> supports self-serve (see [Billing](#billing-shipped-foundation)); the pilot SOW
> supports hands-on. Recommendation: land 1–2 hands-on pilots first, use them to
> harden the loop, then open self-serve. Not decided here.

## Wedge

**"You already send every prompt through Cloudflare AI Gateway. We turn those
logs into a quality scorecard and a fine-tuned model that beats your baseline —
without rebuilding your gateway or your training stack."**

Why it wedges:

- The logs already exist; onboarding is an export/paste, not an integration
  project. Blind Bench holds **no Cloudflare credentials** and makes **no calls
  to Cloudflare** (`docs/cloudflare-gateway-live-import.md`).
- The two hard parts — the eval harness that is management-safe by construction,
  and the training-data curation that is default-deny on customer data — are the
  parts nobody wants to build in-house and that we already ship.

---

## The core loop (8 steps)

| # | Step | Owner | Shipped? — where |
| --- | --- | --- | --- |
| 1 | Connect CF AI Gateway / Logpush; export request logs | Cloudflare emits; user exports | ✅ `docs/cloudflare-gateway-live-import.md`, `docs/gateway-onboarding.md` |
| 2 | Normalize logs into deduplicated traces | Blind Bench | ✅ `convex/traceAdapters/cloudflareAiGateway.ts`, `src/lib/evals/cloudflareAiGateway.ts`, `convex/gatewayImport.ts` |
| 3 | Curate datasets / eval suites from real traffic + synthetic edge cases | Blind Bench | ✅ (parse/dedup + local materialize); ⚠️ UI materialization of imported traces is **planned** — `docs/cloudflare-gateway-live-import.md` "Follow-up" |
| 4 | Run baseline evals (management-safe scorecard) | Blind Bench | ✅ `src/lib/evals/modelComparison.ts`, `npm run scorecard:customer-pilot` — `docs/baseline-candidate-comparison.md`, `docs/customer-ai-quality-scorecard-handoff.md` |
| 5 | Compile training / eval data for Fireworks fine-tuning / RFT | Blind Bench (curation); user approves | ✅ `src/lib/evals/trainingDataset.ts` — `docs/training-dataset-compiler.md` (default-deny on real data) |
| 6 | Deploy candidate on Fireworks (fine-tune → serve) | Fireworks; user operates | ✅ runbook only (manual `firectl`) — `docs/fireworks-cloudflare-routing-prototype.md` §1 |
| 7 | Route candidate through Gateway (custom provider / dynamic routing) | Cloudflare; user configures | ✅ prototype + live smoke — `docs/fireworks-cloudflare-routing-prototype.md` §§2–3, `scripts/fireworks-gateway-smoke.ts` |
| 8 | Compare baseline vs candidate; publish scorecard | Blind Bench | ✅ `src/lib/evals/modelComparison.ts` (`compare:customer-pilot`) — promote / hold / reject recommendation, `docs/baseline-candidate-comparison.md` |

**Honest status of the loop:** the two ends (import + normalize; baseline /
candidate comparison + scorecard) are shipped and tested. The middle —
turning imported production traces into runnable eval cases **through the UI** —
is partially manual today: the local path
(`normalizeCloudflareAiGatewayLog → convertTraceToEvalCase`) works, but the Convex
importer does not yet expose materialization or sidecar merge
(`docs/cloudflare-gateway-live-import.md` "Follow-up"). Fireworks fine-tune +
deploy (step 6) is an operator runbook (`firectl`), not an automated product step.

---

## What Blind Bench owns vs Cloudflare vs Fireworks

| Concern | Owner | Notes |
| --- | --- | --- |
| Prompt traffic capture, gateway, routing, log storage | **Cloudflare** | AI Gateway + Logpush + dynamic/custom-provider routing. We consume its logs and its routing surface; we do not reproduce them. |
| Model training (SFT / RFT), model hosting, inference | **Fireworks** | Fine-tune via `firectl`, serve serverless/dedicated. We compile the dataset and read the results; we do not host or train. |
| Log normalization + deduplication | **Blind Bench** | `traceImports` identity, access-controlled raw payload storage. |
| Eval packs + deterministic, management-safe scoring | **Blind Bench** | Scorecard exposes only IDs/labels/scores/aggregates — never raw prompts, outputs, or scorer reason strings. |
| Human review / blind sign-off | **Blind Bench** | The reviewer surface (see [[Blind Bench - Positioning]]). |
| Training-data curation with data-boundary gates | **Blind Bench** | Default-deny compiler; real rows need explicit training approval + policy flag. |
| Baseline↔candidate comparison + promote/hold/reject | **Blind Bench** | The decision artifact management actually reads. |
| Billing / entitlements | **Blind Bench** (via Polar) | See below. |

### Build / buy boundaries

- **Do not rebuild the Gateway.** No log storage, no routing engine, no proxy of
  our own. We export from and route through Cloudflare. The data boundary is
  one-directional by design (`docs/cloudflare-gateway-live-import.md` §3).
- **Do not rebuild Fireworks training.** No training infra, no model hosting. We
  compile a Fireworks-compatible JSONL dataset + manifest
  (`docs/training-dataset-compiler.md`) and hand it off; `firectl`/Fireworks does
  the fine-tune and serving.
- **Do build** the management-safe eval + scorecard layer, the curation/consent
  gates, and the reviewer surface — the parts that are our defensible work and
  that neither Cloudflare nor Fireworks provides.

---

## MVP success criteria

### For Pennie (beachhead pilot)

1. Real Migo/Eavesly Gateway logs import cleanly (dedup + summary), staying
   `prod_sensitive` and customer-scoped — no raw prompt/output ever leaves the
   workspace or reaches the repo.
2. A baseline scorecard is generated and is management-safe (only IDs / labels /
   scores / aggregates), suitable as the paid handoff artifact
   (`docs/customer-ai-quality-scorecard-handoff.md`).
3. A Fireworks candidate is trained from **training-approved** rows and routed
   through the Gateway; the comparison runner returns an explicit
   **promote / hold / reject** with no privacy/tool-safety hard-fail regression
   (`docs/baseline-candidate-comparison.md`).
4. The live smoke passes end-to-end (send → poll logs → verify round-trip),
   proving the loop works on real infra (`scripts/fireworks-gateway-smoke.ts`).

### For a generic CF AI Gateway user

1. Self-serve onboarding: follow `docs/gateway-onboarding.md`, export with an
   **AI Gateway — Read** scoped token, import via the no-code page
   (`src/routes/orgs/GatewayImport.tsx`) with no Blind Bench↔Cloudflare
   integration work.
2. Reach a baseline scorecard **without any Fireworks credentials** — Fireworks
   is needed only at the candidate step.
3. Metadata conventions (`product`, `module`, `prompt_version`, `variant`,
   `release`, `environment`, `tenant`, `trace_id`, `session_id`) let logs group
   by surface, within Cloudflare's custom-metadata size/count limits.
4. Optional: purchase a package via Polar self-serve to unlock eval credits /
   reviewer seats / import headroom.

> **Open strategy call (Noah):** the numeric bars (how much lift over baseline
> counts as a win; minimum traffic volume; pilot price). Recommendation: define a
> per-pilot quality-lift target with the customer at SOW time rather than a global
> threshold. Not decided here.

---

## Billing (shipped foundation)

Self-serve packages through **Polar**, owner-scoped per workspace
(`docs/polar-self-serve-billing.md`, `convex/lib/billingPlans.ts`):

- Package keys `starter` / `team` / `scale` / `enterprise`; `enterprise` is
  manual/contact-sales.
- Each package grants eval credits, reviewer seats, and trace-import headroom.
- A free trial grant exists in config (50 credits / 2 seats / 10 imports); trial
  provisioning is not yet auto-seeded.
- Payment state is isolated from trace data — billing tables never reference
  trace/eval content.

> **Open strategy call (Noah):** actual prices and what each package includes are
> config placeholders, not committed pricing. Recommendation: hold pricing until
> the first pilots reveal willingness-to-pay. Not decided here.

---

## Non-goals

- Not a tracing platform and not an LLM-as-judge harness (carry-over from
  [[Blind Bench - Positioning]] — that fight is Cloudflare's / a commodity).
- Not a model host or training platform (Fireworks owns that).
- Not a Cloudflare replacement or proxy.

## Known gaps / next (not claims of "done")

- UI materialization of imported traces into eval cases + sidecar-metadata merge
  in the Convex importer (`docs/cloudflare-gateway-live-import.md` "Follow-up").
- Fireworks fine-tune/deploy is an operator runbook, not an in-product step.
- Real endpoint-vs-endpoint comparison currently ingests captured fixtures; the
  comparison/recommendation logic is endpoint-agnostic and ready for a live
  adapter (`docs/baseline-candidate-comparison.md` "What it is NOT").
- Trial auto-provisioning and final pricing (see Billing).
