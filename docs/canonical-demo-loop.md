# Canonical demo loop

Blind Bench's agent-first demo should stay narrow enough that a buyer can repeat
it without understanding the whole platform.

## One path we lead with

1. **Bring in completed runs** — mapped CSV, native `eval-record` v1, OTLP JSON or live OTLP, Pi session JSONL, Claude Code JSONL, Gateway logs, or another thin adapter. The adapter choice is not the story; every path normalizes into the same agent-trace spine.
2. **Send one blind review link** — a domain expert opens the run or matchup
   without version/model/harness provenance. For trajectories, the promise is
   bias reduction, not perfect anonymity.
3. **Get a verdict** — rating, step comment, or A/B next-action choice. Optimize
   for time-to-verdict over full-trace inspection.
4. **Route it back** — use the verdict as a regression case, training export
   row, or cited revision input.

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

`agent run imported → blind review opened → verdict/comment submitted → result reused`

Until this is repeatable, new adapters and matrix features should be pilot- or
demo-driven only.
