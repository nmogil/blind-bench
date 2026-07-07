---
title: "Blind Bench - Agent Trace Strategy"
created: 2026-07-07
modified: 2026-07-07
type: strategy
status: draft
tags:
  - blind-bench
  - strategy
  - agent-traces
---

# Blind Bench — Agent Trace Strategy

> **DRAFT for Noah.** Synthesized 2026-07-07 from: a codebase capability audit, a
> GH pipeline audit, market/landscape research (~60 primary sources), and an
> independent Codex review. Strategy calls are marked **[DECISION: Noah]**.
> Companion to [[Blind Bench - Positioning]] (2026-04) and
> [[Blind Bench - AI Quality Bench Spec]] (2026-07, M30).

---

## Aim

Decide what BlindBench builds next, given that the unit of AI work has shifted
from *a prompt's output* to *an agent's trajectory* (task → tool calls →
reasoning → outcome, run by a model+harness combo, often in a sandbox) — and
position BlindBench so the human judgment it collects becomes training data
that improves models over time (Fireworks SFT / DPO / RFT).

## The thesis in one paragraph

Everyone in the observability space has traces; almost nobody has disciplined
human judgment attached to them, and **nobody has blind human judgment**.
Market research (July 2026) confirms the intersection — **blind, step-level
human review of agent traces with training-ready export** — is empty across
all eight living observability platforms, both arena products, and the
labeling vendors. Sandbox execution (Harbor, Daytona, E2B, Modal) and
fine-tuning targets (Fireworks, OpenAI, Together) are commoditized on both
sides of it. The empty middle is exactly the human-judgment layer, and
BlindBench's blind-eval discipline (enforced at the Convex function boundary,
opaque tokens, no provenance in the DOM) is the one asset none of them have.
The open question is **demand density, not competitive occupancy**.

## What changed in the world

1. **Agentic harnesses went mainstream.** Claude Code, Codex CLI, OpenHands
   etc. now do real work — code review, PRs, customer service — as
   long-running agents in their own environments (local or cloud sandboxes:
   Modal, Cloudflare, Vercel Sandbox, Daytona, E2B, Fly).
2. **The harness matters as much as the model.** Harness-Bench (2026) showed
   the same model across harnesses can vary ~32× in cost for near-identical
   output. "Model+harness combo" is now a legitimate unit of comparison —
   and no product lets you compare combos on *your* task with *your* experts.
3. **Trajectory data has no interchange standard.** OTLP is the wire format;
   OTel GenAI semconv is still experimental; Claude Code JSONL, OpenAI Agents
   SDK, SWE-agent `.traj`, OpenHands events are all bespoke. Defining the
   normalization is an opportunity, not a tax. (We already drafted it:
   `src/lib/evals/agentTrace.ts`.)
4. **Fine-tuning demand shifted toward structured expert judgment.** Fireworks
   RFT went GA; rubric-based reward is the wave. Expert-data vendors (Surge,
   Mercor, Handshake) are exploding but enterprise-gated. No product offers
   {self-serve} + {bring your own expert reviewers} + {one-click SFT + DPO
   export}.

## Where we actually are (honest inventory)

Shipped and wired: CF AI Gateway JSONL import + metadata sidecar + dedup +
raw-blob storage; eval-case materialization; deterministic scorers; per-org
scorecard; review cycles with ratings, pairwise matchups (Bradley-Terry),
inline comments; unified invites incl. no-account guest review; Polar billing
foundation.

Designed but **unwired** (lab/CLI only): the multi-step `AgentRunTrace` schema
(tool calls, reasoning, policy events, per-step privacy classes, blind-view
projection); Fireworks SFT dataset compiler with consent gates; review →
promotion workflow; live baseline-vs-candidate endpoint comparison.

**Genuinely absent** — and exactly the heart of the new direction:

| Gap | Detail |
|---|---|
| Trace-step persistence | No Convex table stores steps. `evalCases` is flat messages+outputText. Convex ~1MB doc limit forces step bodies to file storage with light inline pointers (pattern already exists: `rawPayloadStorageId`). |
| Step-level annotation | All comment anchors are text ranges in one immutable document, or whole-output notes. No `{kind:"step"}` / `{kind:"tool_call"}` anchor, no per-step render surface. |
| Sandbox / harness execution | Nothing. Explicit non-goal to date. |
| Preference → training bridge | Ratings + pairwise matchups are collected in prod; the SFT compiler exists in the lab; **no bridge between them** and no export UI/endpoint. |

## The positioning tension (must resolve)

Three artifacts point three directions:

- **Positioning (April):** non-technical reviewers; developers are the
  *anti-persona*; "not a tracing platform."
- **AI Quality Bench spec (July, M30):** CF-Gateway-centric closed loop;
  technical buyer; reviewer is one step, not the headline.
- **New direction (this doc):** agent trajectories; the qualified reviewer of
  a Claude Code trace is usually a senior engineer or domain expert.

**Resolution (recommended):** the through-line was never "non-technical" — it
was **"the person whose judgment matters, reviewing without bias, without
living in a dashboard."** For brand voice that's a VP of Marketing; for a
customer-service agent it's a CX lead; for a coding agent it's a senior
engineer. The persona generalizes from "non-technical reviewer" to **domain
expert reviewer**. What survives from April: blind-by-default, shareable-link
zero-friction review, plain-language reviewer surfaces, feedback that goes
somewhere. What's retired: "developers are the anti-persona" (they're now a
first-class *reviewer*, not just buyer-influencer). What stays true: we are
still not a tracing platform — we are the **judgment layer** that tracing
platforms, harnesses, and sandboxes feed into.

Fit with the DPO constraint (verified): Fireworks/OpenAI/Together DPO is
single-turn — preference over the *final assistant message*. Whole-trajectory
preferences don't map to DPO directly; **step-level preferences do** ("the
best next action at step k given an identical prefix" is exactly a single-turn
pair). Whole-run judgments feed trajectory-filtered SFT and RFT rubrics
instead. The training-data angle *requires* step-level review — the product
thesis and the export format reinforce each other.

## Options considered

| Option | Why it might work | Risk / friction | First test | Kill signal |
|---|---|---|---|---|
| **A. Trajectory spine**: agent-trace storage + step-level blind review UI over *uploaded* traces | The one data-model shift everything else hangs off; wires existing `agentTrace.ts`; whitespace is verified | Blind projection of traces is hard (tool names fingerprint the harness); review UX for long traces is novel | Import a real Claude Code session, have 2 engineers review it step-level, blind | Reviewers won't finish a trace review; step comments add nothing over whole-run verdicts |
| **B. Ingestion breadth**: Claude Code JSONL importer + OTLP GenAI endpoint (#263) | Every Claude Code user has transcripts on disk today — zero-integration wedge; OTLP is the standard wire format | Format churn (semconv experimental; CC JSONL undocumented) | Ship CC importer, post "get your agent session reviewed by a human, blind" | Nobody uploads |
| **C. Training export bridge** (#53): preferences/matchups → Fireworks SFT + DPO + RFT rubrics | Turns review exhaust into the paid artifact; converged interchange format; nobody else does it | Needs A for step-level pairs; consent/data-boundary care | Compile one real DPO set from existing cyclePreferences; run a Fireworks job | Fine-tune shows no lift customers care about |
| **D. Sandbox execution matrix**: run same task across model+harness combos | The full vision; Harness-Bench legitimizes it; demo-able ("watch 4 harnesses race, judge blind") | Biggest build; infra is commoditized (Harbor already runs CC/Codex/OpenHands across Daytona/Modal/E2B) — **integrate, never build**; cost of runs | One manual Harbor run → import 4 trajectories → blind review | A+B show users only care about their own prod traces, not synthetic matrix runs |
| **E. Finish the Pennie/M30 loop** (billing #236, Fireworks runbook → product step) | Revenue now; hardens the same loop; beachhead reference | Time not spent on the spine; CF-Gateway-specific surface area | Already in flight — SOW milestones | Pilot stalls / churns |

Boring option: E alone (milk the pilot, defer the vision). Wild card: D-first
as a public spectacle (blind harness races as content marketing).

## Recommendation

**Sequence (as decided by Noah, 2026-07-07): A (spine, with Claude Code
upload as its test ingestion) + D (sandbox matrix via Harbor/Daytona
integration — pulled forward per Noah, integrated never built) in parallel →
C (export bridge) → B (OTLP #263), with E continuing in parallel
(pilot-driven).**

Rationale for A+D pairing: the matrix produces trajectories; the spine is
what renders and reviews them. D without A has nothing to show reviewers; A
gets its best demo content from D ("watch 4 model+harness combos run the
same task, judge blind"). D remains an *integration* — Harbor already runs
Claude Code/Codex CLI/OpenHands across Daytona/Modal/E2B; we orchestrate and
import, we do not build sandbox infra.

1. **A. Trajectory spine first** — tiny `agentTraces` parent row + separate
   `agentTraceSteps` rows, large step bodies to file storage, precomputed
   blind projections, pagination (never a reactive subscription over a full
   trace); wire the existing `agentTrace.ts` normalizer into Convex;
   step/tool-call comment anchors; blind projection enforced server-side like
   today's blind mode. **Claude Code JSONL file upload is the spine's first
   ingestion path** — the cheapest real agent traces in the world, zero
   integration, and the dogfood loop (we review our own sessions).
2. **C. Export bridge** — step-level preference pairs → Fireworks DPO;
   whole-trajectory verdicts → filtered SFT; rubric outcomes → RFT reward
   spec. Converts review exhaust into the paid artifact. Do not market DPO
   until the UI actually captures comparable step-level choices.
3. **B. OTLP GenAI endpoint (#263)** after the review surface exists —
   Codex's framing is right: before the spine, OTLP is a telemetry intake
   pipe with no differentiated product.
4. **E continues** as the revenue/hardening track (Pennie pilot; billing).
   Codex would put this outright first; see decision point 4.
5. **D later**, as a thin integration over Harbor or Daytona once A–C prove
   people will review trajectories at all. Running the matrix ourselves is a
   service/demo before it is a product feature.

### Pipeline actions (mechanical, once approved)

- Re-scope **#263** (OTLP GenAI ingest) to follow the trajectory spine, not
  lead it; the spine's first ingestion is Claude Code JSONL file upload.
- Close as obsolete: **#130, #131, #133** (per-SaaS paste adapters), **#136**
  (paste-import UI as scoped), **#55** (public prompt benchmarks — pre-pivot
  framing). Also cleanup: **#209** (test issue), **#219** (mis-filed A2PCheck).
- Pull forward **#261** (configurable scorers) and **#53** (training export).
- New issues to write: trajectory spine (schema + storage + normalizer
  wiring), step-level annotation anchors + trace review UI, blind projection
  layer, Claude Code JSONL importer, preference→Fireworks bridge, Harbor
  integration spike.
- Update **Build Plan** with an M31+ section; update **Positioning** with the
  "domain expert reviewer" resolution.

## Decision points — **DECIDED by Noah, 2026-07-07**

1. **Persona:** ✅ Generalize to "domain expert reviewer." Engineers become
   first-class reviewers; "developers are the anti-persona" is retired; blind-
   by-default, zero-friction links, and plain-language surfaces survive.
2. **Execution layer:** ✅ **Pull the sandbox matrix forward** as a near-term
   milestone (the demo-able expression of the vision), but as an
   *integration* over Harbor/Daytona — not built in-house. Runs in parallel
   with the spine (see Recommendation).
3. **First ingestion wedge:** ✅ Claude Code JSONL upload first; OTLP (#263)
   follows the spine.
4. **Pennie pilot priority:** ✅ Parallel — the pilot continues as the
   revenue/hardening track while the spine starts now (this doc's rec over
   Codex's pilot-first).
5. **Honest risk accepted:** demand density. The niche is empty partly
   because it may be small (teams that run agents seriously AND have in-house
   experts AND want to fine-tune). Mitigation: the spine + CC upload are
   cheap to test — the kill signals are fast and observable.

> **Pipeline actions approved by Noah 2026-07-07** ("aligned with the plan,
> continue") — issue cleanup, re-scopes, and the M31 issue set are being
> executed.

## Risks

- **Blind-eval leakage surface explodes with traces.** Tool names, reasoning
  style, harness metadata all fingerprint the combo. Mitigate: server-side
  step-level redaction/projection (`toScorerVisibleAgentRun` pattern), and
  honesty that blinding traces is *statistical bias reduction*, not perfect
  anonymity.
- **Convex doc limits.** Traces must be storage-backed from day one; inline
  arrays will not survive real Claude Code sessions.
- **Dual code paths** (`src/lib/evals/*` vs `convex/*`) double every trace
  feature. Resolve the duplication before the spine grows.
- **LLM-as-judge encroachment.** Incumbents bet judges replace routine human
  review. Our wedge is high-stakes/expert domains where judges are untrusted
  and "where did it go wrong" is step-level. Don't compete on judge tooling.
- **DPO overpromise.** Never market "human feedback → DPO" naively; the
  single-turn constraint shapes what we can honestly export.

## Codex second opinion (independent review, 2026-07-07)

Codex reviewed the repo and the pivot unanchored by this doc's recommendation.
Convergent on the big calls, divergent on sequencing:

- **Coherence:** the direction is coherent *only* as "blind human judgment
  over AI behavior," not as April's "Google Docs for AI evaluation." It
  becomes a second product if BlindBench tries to own sandbox execution and
  model-harness orchestration. "The April doc should stop controlling
  strategy"; the durable through-line is "domain expert feedback without
  model/vendor bias."
- **Sequencing (Codex's ranking):** 1) finish the Pennie/CF Gateway loop —
  the closest thing to a shipped wedge; get customer evidence before the
  agent-trace bet consumes the company; 2) step-level trace storage + review
  UI over *uploaded* traces, kept narrow; 3) preference→Fireworks export
  bridge (existing reviewer labor → concrete artifact); 4) OTLP (#263) —
  "useful later, dangerous early; a telemetry intake pipe with no
  differentiated product" if it precedes the review surface; 5) sandbox
  execution — "defer hard."
- **Biggest technical risk (verified):** the trace data model. Convex ~1MiB
  doc cap; `AgentRunTrace.steps` inline must never become one document; a
  modest 100-step run at 10KB/step is at the limit. Correct model: tiny
  `agentTraces` parent row, separate `agentTraceSteps` rows, large bodies in
  storage blobs, **precomputed blind projections**, pagination, no reactive
  subscription over a full trace. Second severe risk: blind leakage — the
  current scorer-visible projection still exposes harness/model/tool names,
  and reviewers can fingerprint Claude Code vs Codex from tool names, timing,
  error formats, reasoning style. "Blindness here becomes bias reduction, not
  true anonymity. The product should say that honestly."
- **Kill list:** in-house sandbox execution (clearest path to a second
  product); "developers are the anti-persona"; full-trace inline Convex
  documents; adapter sprawl / tracing-platform ambitions; DPO promises not
  backed by the captured data shape; OTLP as the first agent-trace milestone.
- **Stale-doc catch:** the July spec's "UI materialization not exposed" note
  is outdated — `GatewayImport.tsx` now exposes materialization.

**Where this doc updated after Codex:** OTLP (#263) demoted from "flagship of
the ingestion track" to "follows the spine" — the first ingestion path is
file-upload (Claude Code JSONL), not a streaming endpoint. The export bridge
moved ahead of OTLP. The remaining genuine disagreement is E-vs-A priority
(pilot-first vs spine-first) — left to Noah as decision point 4.

## Next action

Noah reads this doc and approves/amends the Pipeline actions. Then: write the
M31 issue set (trajectory spine + Harbor integration spike + CC JSONL
importer + step-level annotation + export bridge), update the Build Plan with
an M31+ section, update Positioning with the "domain expert reviewer"
resolution, and start the spine schema.
