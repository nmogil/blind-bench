# Baseline vs candidate comparison runner

A local, deterministic eval runner that scores **one eval pack against two fixture
sets** — a *baseline* and a *candidate*, standing in for two model endpoints — and
emits a management-safe Markdown + JSON comparison report with an explicit
promote / hold / reject recommendation.

For running the same comparison against two **live** endpoints (baseline model +
Fireworks candidate via Cloudflare AI Gateway), see `live-endpoint-comparison.md`.

Issue #229. Source: `src/lib/evals/modelComparison.ts`. Tests:
`src/lib/evals/modelComparison.test.ts`.

## What it does

- Runs a pack's synthetic fixtures through its deterministic scorers (via
  `runPack`) for both sides.
- Diffs the two `Summary` objects: pass-rate delta, mean-score delta, fixed /
  regressed cases, and **privacy/tool-safety hard-fail regressions** (blocking).
- Aggregates and diffs **cost / latency / token** metrics from `output.raw`.
- Reports fixture coverage so partial runs never overstate confidence.
- Produces an explicit recommendation and a CI-friendly exit code.

## What it is NOT (this PR)

Pure and local. **No** live model providers, Fireworks, Cloudflare, Convex, or
network calls. The runner only scores fixtures. To compare real endpoints later,
capture each endpoint's outputs into a `caseId -> AgentOutput` fixture set and
feed them in — the comparison/recommendation logic is unchanged. The module is
structured so endpoint/provider adapters can be layered on without touching it.

## Run it

```bash
npm run compare:demo
# writes (gitignored):
#   artifacts/model-comparison.md
#   artifacts/model-comparison.json
```

The default demo compares the **planted hard-fail** fixture pack
(`demo/smoke`, baseline) against the **all-pass** fixture pack
(`demo/smoke-pass`, candidate) over the same synthetic cases. The
candidate clears the planted privacy hard-fail, so the recommendation is
**promote** and the CLI exits `0`.

Override the packs positionally:

```bash
npx tsx src/lib/evals/modelComparison.ts <baseline-pack> <candidate-pack>
```

## Recommendation logic

`compareModels(baseline, candidate, { tolerances })` decides:

- **reject** (blocking, exit `1`) if the candidate:
  - introduces **any** privacy/tool-safety hard-fail regression (a case that did
    not hard-fail on baseline but does on candidate), **or**
  - falls below a configured absolute minimum (`min_pass_rate`, `min_mean_score`),
    **or**
  - regresses pass-rate or mean-score beyond a configured drop tolerance
    (`max_pass_rate_drop`, `max_mean_score_drop`).
- **promote** (exit `0`) if not rejected and the candidate is a net improvement
  (clears a hard-fail, fixes a case, or raises pass-rate/mean-score).
- **hold** (exit `0`) otherwise — no blocking regression, but no measurable gain.

All tolerances are optional; absent ones are not enforced.

## Management-safe contract

Mirrors the scorecard contract. The report exposes only case IDs, product labels,
scorer IDs, scores, and aggregate counts/deltas. It **never** includes raw
prompts, raw model output, transcripts, scorer `reason` strings, account IDs,
phone numbers, emails, forbidden sentinels, SSNs, or card-like numbers. The test
suite scans the rendered artifacts to enforce this.

## CI usage

```bash
env -u NODE_ENV npm run compare:demo   # exit 1 blocks the pipeline on a blocking candidate
```

Wire `compare:demo` into CI as a gate: a candidate that introduces a
privacy/tool-safety hard-fail regression — or misses configured minimums — fails
the build.
