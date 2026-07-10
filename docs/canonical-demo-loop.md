# Canonical demo loop

Blind Bench's agent-first demo should stay narrow enough that a buyer can repeat
it without understanding the whole platform.

## One path we lead with

The product model and primary navigation are **Run → Review → Judgment → Result** and **Runs · Reviews · Results**.

1. **Bring in completed runs** — mapped CSV, native `eval-record` v1, OTLP JSON or live OTLP, Pi session JSONL, Claude Code JSONL, Gateway logs, or another thin adapter. The adapter choice is not the story; every path normalizes into the same agent-trace spine.
2. **Create one review** — choose only **Score runs** or **Compare attempts**, select runs, confirm reviewer guidance and blind preview, then open and share one opaque link.
3. **Get a judgment** — a domain expert sees run context/outcome/steps without owner-visible version/model/harness provenance, then submits a verdict, preference, or comment. For multi-step runs, the promise is bias reduction, not perfect anonymity.
4. **Use the result** — after closing the review, copy an evidence summary, promote eligible regression cases, or export eligible SFT/DPO rows. Every ineligible row is counted and explained.

## Guardrails

- Do not lead with adapter breadth. Native JSON is the public contract; OTLP,
  Cloudflare Gateway, Claude Code, Harbor, and future emitters are adapters.
- Do not lead with or own sandbox orchestration. Pi, Claude Code, CI, Harbor/Daytona, gateways, and customer harnesses own execution; Blind Bench owns import, blind judgment, and evidence artifacts. The prompt playground remains secondary.
- Do not lead with DPO unless the captured review data is comparable and
  non-degenerate. Exclusions must be reported.
- Do not claim trace anonymity. Say "blind review" and explain it as provenance
  stripping plus bias reduction.
- Do not show billing credits as decorative numbers: if credits are visible,
  trial grants and consumption must be real.

## Activation metric

The loop is activated when a workspace completes:

`run imported → review created/opened → opaque link opened → judgment submitted → review closed → result reused`

Until this is repeatable, new adapters and matrix features should be pilot- or
demo-driven only.
