# Canonical demo readiness selfcheck

Run the local readiness selfcheck before customer-test demos or PR handoff:

```bash
npx tsx scripts/canonical-demo-readiness.ts
```

The command is deterministic and local-only. It uses synthetic/internal fixture data and does **not** call Cloudflare, Fireworks, model providers, Convex production, or customer systems.

It writes:

- `artifacts/canonical-demo-readiness.md`
- `artifacts/canonical-demo-readiness.json`
- the underlying scorecard, comparison, and training dataset demo artifacts

## What it proves

The selfcheck consolidates the current repeatable demo loop:

1. Generate a management-safe customer scorecard from the synthetic demo pack.
2. Generate a baseline-vs-candidate comparison report.
3. Generate Fireworks-compatible SFT JSONL demo splits plus a manifest.
4. Write one handoff report with status, counts, artifact paths, data-boundary guardrails, and live-operator next steps.

## What it does not prove

- It does not run Fireworks training or deployment.
- It does not import live Cloudflare AI Gateway logs.
- It does not prove customer data consent, redaction, or retention approval.
- It does not replace human blind review on a real imported trace.

Use it as the local readiness gate before moving to an explicit, approved live Gateway/Fireworks operator smoke.
