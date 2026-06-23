# Eval case schema & scorer contract

Portable foundation for grading agent behavior across support, voice, chat, and agentic workflows and
future Blind Bench customers. Source of truth: `src/lib/evals/evalCase.ts` (zod).
Types are inferred from the zod schemas; JSON Schema artifacts are exported for
non-TypeScript consumers (`schemas/*.schema.json`).

This is foundation only — no runner, CLI, or UI yet.

## Files

| Path | What |
| --- | --- |
| `src/lib/evals/evalCase.ts` | Schemas, types, `Scorer` interface, `aggregateScores`, JSON Schema exports |
| `src/lib/evals/examples.ts` | Two **synthetic** example cases (Eavesly, Migo) — fake data only |
| `src/lib/evals/evalCase.test.ts` | Validates examples, scorer-result shape, hard-fail semantics, schema-artifact drift |
| `schemas/eval-case.schema.json`, `schemas/eval-result.schema.json` | Generated JSON Schema (`npx tsx schemas/generate.ts` to refresh) |

## Verification

- `npm run test:evals` runs the Node/Vitest eval-contract tests.
- `npm run test:convex` remains scoped to Convex edge-runtime tests so Node-only schema drift checks do not run in the edge test environment.

## Eval case

```
EvalCase {
  id, product, title, description?, source, tags[], input, expected, metadata?
}
```

- **`source`** — `synthetic` | `production_log` | `replay`. Scenario provenance for
  synthetic, production-log-derived, and replay cases. Affects sampling, not scoring.
- **`product`** — open string (`"eavesly"`, `"migo"`, …) so the schema is portable,
  not tied to one customer.
- **`input`** — open: `messages` / `variables` for synthetic cases, plus `transcript`
  and `context` for replay / production-log cases.

### Expected behavior

```
expected {
  must[], may[], must_not[],
  expected_tool_calls[{ name, args?, required }],
  expected_escalation: { should_escalate, to?, reason? } | null,
  data_policy?: { allowed_data?, forbidden_data?, retention? },
  privacy_class
}
```

- **`must` / `may` / `must_not`** — assertions that must hold / are allowed / are forbidden.
- **`expected_tool_calls`** — `args` is a partial match; `required:false` means allowed-if-present.
- **`expected_escalation`** — `null` when escalation is irrelevant to the case.

## Data-policy & privacy boundaries

- **`privacy_class`** — `public` | `internal` | `confidential` | `pii` | `phi`.
  Real data must be classed honestly so a runner can gate where outputs are stored.
- **Synthetic cases must use fake data.** The example cases tag fake identifiers with
  `TEST`; a test enforces `source === "synthetic"`. Do not commit real customer PII.
- **`data_policy`** declares which data the agent may read/emit and a retention
  expectation (e.g. `ephemeral`, `do_not_store_call_audio`); labels are open strings so
  each product names its own sources.

## Scorer contract

A scorer grades one `(case, output)` pair. Same interface for deterministic checks and
LLM judges — judges are just async.

```ts
interface Scorer {
  id: string;
  kind: "deterministic" | "llm_judge";
  score(c: EvalCase, out: AgentOutput): ScorerResult | Promise<ScorerResult>;
}

ScorerResult {
  scorer, kind, score /* [0,1] */, passed, reason,
  evidence: { source, start?, end?, snippet? }[],
  hard_fail   // forces the whole case to fail regardless of score
}
```

`aggregateScores(scores)` collapses results into the case verdict: mean `score`,
`passed` (all scorers pass **and** no hard-fail), and `hard_failed`.

## Platform-agnostic results

`EvalResult` is the portable row — no Blind Bench internal ids — written one-per-line as
JSONL and uploadable later to Cloudflare / Braintrust / Langfuse / a local file:

```
EvalResult { case_id, run_id?, output, scores[], score, passed, hard_failed, timestamp? }
```
