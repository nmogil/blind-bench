# Blind Bench — Positioning One-Pager

*v2 · 2026-07-10 · Decision of record: ingestion-first, execution-neutral human review. Working history and persona detail live in [[Blind Bench - Positioning]]; where they conflict, this one-pager wins.*

---

## One-liner

**Bring your traces. Blind Bench turns them into defensible human judgment.**

Blind Bench is the blind human-review layer for AI agents and model outputs; it does not run the agent for you.

Your domain experts review agent trajectories — and plain model outputs — without
knowing which version, model, or harness produced them. Their judgment becomes
ratings, regression sets, training data, and evidence you can defend.

## The problem

Teams shipping agents have delegated quality judgment to LLM judges, and the
evidence says judges can't carry that weight alone: position bias,
self-preference, agreement without validity. The working consensus has settled
into *judges for 100% of traffic, humans for calibration, golden sets, and
high-stakes calls*. But every tool serving that human slot shows reviewers
exactly what they're rating — "this is the new version," "this is Claude" — so
the highest-stakes signal in the pipeline inherits the reviewer's anchoring
bias. The one practice vendors themselves recommend (OpenAI's guidance: build
randomized, blinded human tests) is the one no platform ships.

## What Blind Bench is

- **Blind by construction, not by toggle.** Provenance is stripped at the API
  boundary and enforced by 13 anti-leak rules — opaque tokens, no metadata in
  the DOM or clipboard, EXIF stripping, one-way blinding of roles. For
  multi-step trajectories we say it plainly: *bias reduction, not anonymity* —
  a determined reviewer can fingerprint a harness from its tool patterns.
- **Built for the right reviewer, whoever that is.** The GC for legal tone, the
  CX lead for a support agent, the senior engineer for a coding-agent trace.
  No-account, link-based review; plain-language surfaces; minutes, not an
  engineer-mediated CSV export.
- **The unit of review is the change, not the run.** Review Cycles compare
  candidate against control on the same cases, blind, and roll preferences up
  to standings. The question answered is the one that matters: *did it get
  better?*
- **Judgment flows somewhere.** Ratings and comments re-attach to trace IDs,
  promote to regression sets and training data (SFT/DPO), and feed prompt
  revisions that cite the specific reviewer comments they address — never a
  dead dashboard.

## What Blind Bench is not

Not an observability platform, not an LLM-judge vendor, not a labeling workforce, not a crowd arena, and not a hosted agent runtime or sandbox orchestrator. Keep Pi, Claude Code, Braintrust, LangSmith, Langfuse, your gateway, CI, and your judges. They execute or observe; Blind Bench sits above them as the judgment layer they feed into. The original prompt playground remains available for focused experiments, but it is secondary.

## How agent data gets in

One versioned public contract — `eval-record` v1, plain JSON over HTTPS — with
adapters meeting data where it lives: mapped CSV for flat interactions, Pi and Claude Code session JSONL for coding trajectories, OpenTelemetry / AI-gateway push and file upload, and thin customer-side exporters from existing trace platforms. Per-project tokens, counts-only
responses, BYOK throughout: Blind Bench never holds your model, gateway, or
platform credentials.

## Why us, durably

Annotation queues are commodity, and every one of them is attribution-visible.
Incumbents can add a blinding toggle — but their growth story is judge
automation, and they can't *lead* with blind human judgment without arguing
against their own pitch. The moat isn't the toggle: it's audit-grade blinding
plus the reviewer workflow plus the evidence artifact — who reviewed, what they
saw, what was hidden, what they decided. The same machinery points forward:
blind calibration of your LLM judges, by your experts, un-anchored by the
judges' own scores. Nobody sells that.

**Stop guessing whether your agent got better. Know.**
