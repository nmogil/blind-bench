# Live Endpoint Comparison (issue #229) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the live endpoint capture layer that runs one eval pack against two real OpenAI-compatible model endpoints (baseline + Fireworks candidate via Cloudflare AI Gateway) and feeds the captured outputs into the existing, unchanged comparison/report/CI-gate pipeline.

**Architecture:** Most of #229 already shipped in `src/lib/evals/modelComparison.ts` (comparison, promote/hold/reject recommendation, Markdown+JSON reports, blocking exit codes) — it just runs on fixture sets. This plan adds (1) `endpointAdapter.ts`: an endpoint config + capture function that POSTs each case's messages to an OpenAI-compatible chat-completions URL and normalizes responses into `Record<caseId, AgentOutput>` with live cost/latency/token metrics, and (2) `compareEndpoints.ts`: a CLI orchestrator that captures both sides, runs `runPack()` + `compareModels()`, and writes the reports. Request failures become missing fixtures, which the existing `recommend()` already treats as blocking candidate-coverage gaps (fail-closed).

**Tech Stack:** TypeScript run via `tsx`, Zod v4 (`import { z } from "zod/v4"`), vitest. Pure `src/lib/evals/` layer — NO Convex imports (`convex/_generated` doesn't exist locally).

## Global Constraints

- All code lives under `src/lib/evals/`. Never import anything from `convex/` or `src/` outside this directory.
- Zod import is exactly `import { z } from "zod/v4";` (the repo's zod 3.25 exposes the v4 API on this subpath).
- Secrets NEVER appear in config objects, config files, artifacts, or logs. Header values carry `$ENV_VAR` placeholders resolved from the environment at request time (same convention as `fireworksGatewayPrototype.ts`).
- Management-safe report contract: the comparison report emits only case IDs, product labels, scorer IDs, scores, aggregate counts/deltas — never raw prompts, model output, `reason` strings, or PII. Do not change `formatComparisonMarkdown`/`formatComparisonJson` output beyond the metrics note.
- `artifacts/` is gitignored — captured outputs and reports go there.
- Do NOT run `npm run build` or `npm run test:convex` (they fail locally without `convex/_generated`). Verification commands are:
  - `npm run test:evals`
  - Focused typecheck:
    ```bash
    npx tsc --ignoreConfig --noEmit --skipLibCheck \
      --module ESNext \
      --moduleResolution bundler \
      --target ES2022 \
      --types node \
      --strict \
      --noUnusedLocals \
      --noUnusedParameters \
      --noUncheckedIndexedAccess \
      src/lib/evals/*.ts src/lib/evals/packs/*.ts
    ```
- Match the existing file style: header doc comment explaining purpose + how to run, `// --- section ---` dividers, co-located `*.test.ts`.
- Commit after each task with a `feat:`-prefixed message ending in the line `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Background you need (read these files first)

- `src/lib/evals/evalCase.ts` — `EvalCase`, `EvalCaseInput`, `AgentOutput`, `CaseInput` (cases carry `input.messages` and/or `input.transcript`, both `{role, content}[]`).
- `src/lib/evals/runner.ts` — `PACKS` registry (plain exported mutable object), `runPack(packName, fixtures?)`, `Summary`. Metrics are read from `AgentOutput.raw.{cost_usd, latency_ms, tokens}` (numbers).
- `src/lib/evals/modelComparison.ts` — `compareModels(baseline, candidate, opts)`, `CompareOptions`, `formatComparisonMarkdown/Json`, `main()` exit semantics.
- `src/lib/evals/fireworksGatewayPrototype.ts` — `loadConfig(env)` (fails closed without `syntheticFallback`), `gatewayUrlForMode(c)`, `modelField(c)`, `buildMetadata(c)`. Env vars: `CF_ACCOUNT_ID`, `CF_AIG_GATEWAY`, `FIREWORKS_MODEL`, `TENANT_LABEL`, `PRODUCT` required; secrets `FIREWORKS_API_KEY` + `CF_AIG_TOKEN` env-only.
- `src/lib/evals/cli.ts` — flag-parsing style and the `invokedDirectly` guard pattern.

Known quirks (verified during planning):
- The 50 customer-pilot cases all have `messages` or `transcript`, but message-sets are NOT unique across cases (22 unique sets for 50 cases) — tests must not key stub responses on message content against the pilot pack; register a tiny test pack in `PACKS` instead.
- `correct_escalation` scorer falls back to a tool-name heuristic (`name.includes("escalat")`) when `output.escalated` is undefined — live captures never set `escalated`, which is fine.

---

### Task 1: Endpoint adapter (`endpointAdapter.ts`)

**Files:**
- Create: `src/lib/evals/endpointAdapter.ts`
- Test: `src/lib/evals/endpointAdapter.test.ts`

**Interfaces:**
- Consumes: `AgentOutput`, `EvalCase`, `EvalCaseInput` from `./evalCase`; `loadConfig`, `gatewayUrlForMode`, `modelField`, `buildMetadata` from `./fireworksGatewayPrototype`.
- Produces (Task 2 relies on these exact exports):
  - `EndpointConfig` (Zod schema + inferred type): `{ label, url, model, headers (default {}), max_tokens (default 512), temperature (default 0) }`
  - `resolveHeaders(headers: Record<string,string>, env: Record<string,string|undefined>): Record<string,string>`
  - `fireworksCandidateEndpoint(env?: Record<string,string|undefined>): EndpointConfig`
  - `parseCompletion(payload: unknown, latencyMs: number): AgentOutput`
  - `interface CaptureError { case_id: string; error: string }`
  - `interface Capture { outputs: Record<string, AgentOutput>; errors: CaptureError[] }`
  - `interface CaptureOptions { fetchImpl?: typeof fetch; env?: Record<string,string|undefined>; now?: () => number }`
  - `captureOutputs(cases: EvalCaseInput[], endpoint: EndpointConfig, opts?: CaptureOptions): Promise<Capture>`

- [ ] **Step 1: Write the failing test**

Create `src/lib/evals/endpointAdapter.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { EvalCaseInput } from "./evalCase";
import {
  captureOutputs,
  EndpointConfig,
  fireworksCandidateEndpoint,
  parseCompletion,
  resolveHeaders,
} from "./endpointAdapter";

const ENDPOINT = EndpointConfig.parse({
  label: "test endpoint",
  url: "https://example.test/v1/chat/completions",
  model: "test-model",
  headers: { Authorization: "Bearer $TEST_KEY" },
});

const CASE: EvalCaseInput = {
  id: "case-1",
  product: "migo",
  title: "greeting",
  source: "synthetic",
  input: { messages: [{ role: "user", content: "hi" }] },
  expected: { privacy_class: "internal" },
};

function okResponse(json: unknown): Response {
  return { ok: true, status: 200, json: async () => json } as unknown as Response;
}

describe("resolveHeaders", () => {
  it("substitutes $ENV_VAR placeholders", () => {
    expect(resolveHeaders({ Authorization: "Bearer $K" }, { K: "abc" })).toEqual({
      Authorization: "Bearer abc",
    });
  });

  it("throws on a missing env var", () => {
    expect(() => resolveHeaders({ Authorization: "Bearer $MISSING_K" }, {})).toThrow(
      /MISSING_K/,
    );
  });

  it("passes values without placeholders through unchanged", () => {
    expect(resolveHeaders({ "x-static": "v1" }, {})).toEqual({ "x-static": "v1" });
  });
});

describe("parseCompletion", () => {
  it("normalizes text, tool calls, and metrics", () => {
    const out = parseCompletion(
      {
        id: "cmpl-1",
        model: "m",
        choices: [
          {
            message: {
              content: "hello",
              tool_calls: [{ function: { name: "lookup", arguments: '{"a":1}' } }],
            },
          },
        ],
        usage: { total_tokens: 42, cost: 0.001 },
      },
      120,
    );
    expect(out.text).toBe("hello");
    expect(out.tool_calls).toEqual([{ name: "lookup", args: { a: 1 } }]);
    expect(out.raw).toMatchObject({ latency_ms: 120, tokens: 42, cost_usd: 0.001 });
  });

  it("tolerates null content and malformed tool-call arguments", () => {
    const out = parseCompletion(
      {
        choices: [
          { message: { content: null, tool_calls: [{ function: { name: "x", arguments: "not-json" } }] } },
        ],
      },
      5,
    );
    expect(out.text).toBeUndefined();
    expect(out.tool_calls).toEqual([{ name: "x" }]);
  });
});

describe("captureOutputs", () => {
  it("captures outputs keyed by case id with latency from the injected clock", async () => {
    let t = 1000;
    const { outputs, errors } = await captureOutputs([CASE], ENDPOINT, {
      env: { TEST_KEY: "k" },
      now: () => (t += 50),
      fetchImpl: (async () =>
        okResponse({
          choices: [{ message: { content: "ok" } }],
          usage: { total_tokens: 7 },
        })) as typeof fetch,
    });
    expect(errors).toEqual([]);
    expect(outputs["case-1"]?.text).toBe("ok");
    expect((outputs["case-1"]?.raw as { latency_ms: number }).latency_ms).toBe(50);
  });

  it("sends model, messages, and resolved auth header", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    await captureOutputs([CASE], ENDPOINT, {
      env: { TEST_KEY: "secret" },
      fetchImpl: (async (url: unknown, init?: RequestInit) => {
        seen.url = String(url);
        seen.init = init;
        return okResponse({ choices: [{ message: { content: "ok" } }] });
      }) as typeof fetch,
    });
    expect(seen.url).toBe(ENDPOINT.url);
    const headers = seen.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer secret");
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(String(seen.init?.body)) as {
      model: string;
      messages: unknown;
      max_tokens: number;
      temperature: number;
    };
    expect(body.model).toBe("test-model");
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(body.max_tokens).toBe(512);
    expect(body.temperature).toBe(0);
  });

  it("prepends transcript turns before scenario messages", async () => {
    const replayCase: EvalCaseInput = {
      ...CASE,
      id: "case-replay",
      input: {
        transcript: [{ role: "assistant", content: "earlier turn" }],
        messages: [{ role: "user", content: "now" }],
      },
    };
    let sent: unknown;
    await captureOutputs([replayCase], ENDPOINT, {
      env: { TEST_KEY: "k" },
      fetchImpl: (async (_url: unknown, init?: RequestInit) => {
        sent = JSON.parse(String(init?.body));
        return okResponse({ choices: [{ message: { content: "ok" } }] });
      }) as typeof fetch,
    });
    expect((sent as { messages: unknown }).messages).toEqual([
      { role: "assistant", content: "earlier turn" },
      { role: "user", content: "now" },
    ]);
  });

  it("records HTTP errors and omits the case from outputs", async () => {
    const { outputs, errors } = await captureOutputs([CASE], ENDPOINT, {
      env: { TEST_KEY: "k" },
      fetchImpl: (async () =>
        ({ ok: false, status: 500, json: async () => ({}) }) as unknown as Response) as typeof fetch,
    });
    expect(outputs).toEqual({});
    expect(errors).toEqual([{ case_id: "case-1", error: "HTTP 500" }]);
  });

  it("records thrown fetch errors and continues with later cases", async () => {
    const case2: EvalCaseInput = {
      ...CASE,
      id: "case-2",
      input: { messages: [{ role: "user", content: "second" }] },
    };
    let calls = 0;
    const { outputs, errors } = await captureOutputs([CASE, case2], ENDPOINT, {
      env: { TEST_KEY: "k" },
      fetchImpl: (async () => {
        calls++;
        if (calls === 1) throw new Error("connection reset");
        return okResponse({ choices: [{ message: { content: "ok" } }] });
      }) as typeof fetch,
    });
    expect(errors).toEqual([{ case_id: "case-1", error: "connection reset" }]);
    expect(outputs["case-2"]?.text).toBe("ok");
  });

  it("records an error for a case with no messages or transcript", async () => {
    const empty: EvalCaseInput = { ...CASE, id: "case-empty", input: {} };
    const { outputs, errors } = await captureOutputs([empty], ENDPOINT, {
      env: { TEST_KEY: "k" },
      fetchImpl: (async () => okResponse({})) as typeof fetch,
    });
    expect(outputs).toEqual({});
    expect(errors).toHaveLength(1);
    expect(errors[0]?.case_id).toBe("case-empty");
  });
});

describe("fireworksCandidateEndpoint", () => {
  it("builds the gateway route from env and keeps secrets as placeholders", () => {
    const ep = fireworksCandidateEndpoint({
      CF_ACCOUNT_ID: "acct",
      CF_AIG_GATEWAY: "gw",
      FIREWORKS_MODEL: "accounts/x/models/y",
      TENANT_LABEL: "tenant-a",
      PRODUCT: "migo",
    });
    expect(ep.url).toBe(
      "https://gateway.ai.cloudflare.com/v1/acct/gw/compat/chat/completions",
    );
    expect(ep.model).toBe("fireworks-ai/accounts/x/models/y");
    expect(ep.headers.Authorization).toBe("Bearer $FIREWORKS_API_KEY");
    expect(ep.headers["cf-aig-authorization"]).toBe("Bearer $CF_AIG_TOKEN");
    expect(ep.headers["cf-aig-metadata"]).toContain('"product":"migo"');
  });

  it("fails closed when required env is missing", () => {
    expect(() => fireworksCandidateEndpoint({})).toThrow(/missing required config/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/evals/endpointAdapter.test.ts`
Expected: FAIL — cannot resolve `./endpointAdapter`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/evals/endpointAdapter.ts`:

```ts
/**
 * Live endpoint capture for baseline-vs-candidate model comparison (issue #229).
 *
 * Calls an OpenAI-compatible chat-completions endpoint for every case in a pack
 * and normalizes responses into the `Record<caseId, AgentOutput>` fixture shape
 * consumed unchanged by `runPack()` / `compareModels()`. Failed requests are
 * reported as capture errors and the case is simply absent from `outputs` — the
 * existing runner counts it as a missing fixture and the comparison's coverage
 * gate blocks promotion (fail-closed).
 *
 * Secrets never live in config objects or files: header values carry `$ENV_VAR`
 * placeholders resolved from the environment at request time (same convention
 * as `fireworksGatewayPrototype.ts`).
 */
import { z } from "zod/v4";
import { AgentOutput, EvalCase, type EvalCaseInput } from "./evalCase";
import {
  buildMetadata,
  gatewayUrlForMode,
  loadConfig,
  modelField,
} from "./fireworksGatewayPrototype";

// --- endpoint config -----------------------------------------------------------

export const EndpointConfig = z.object({
  /** Human label for reports, e.g. "baseline (gpt-4o via openrouter)". */
  label: z.string().min(1),
  /** OpenAI-compatible chat-completions URL. */
  url: z.string().url(),
  /** Model string sent in the request body. */
  model: z.string().min(1),
  /** Header values may contain `$ENV_VAR` placeholders resolved at request time. */
  headers: z.record(z.string(), z.string()).default({}),
  max_tokens: z.number().int().positive().default(512),
  temperature: z.number().min(0).max(2).default(0),
});
export type EndpointConfig = z.infer<typeof EndpointConfig>;

/** Resolve `$ENV_VAR` placeholders in header values. Fails closed on missing vars. */
export function resolveHeaders(
  headers: Record<string, string>,
  env: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = value.replace(/\$([A-Z][A-Z0-9_]*)/g, (_, varName: string) => {
      const resolved = env[varName];
      if (resolved === undefined || resolved === "") {
        throw new Error(`endpoint header "${name}": env var ${varName} is not set`);
      }
      return resolved;
    });
  }
  return out;
}

/**
 * Candidate endpoint for a Fireworks custom model routed through Cloudflare AI
 * Gateway, built from the same env vars as the routing prototype. Fails closed
 * when required config is missing (no synthetic fallback — this is a live call).
 */
export function fireworksCandidateEndpoint(
  env: Record<string, string | undefined> = process.env,
): EndpointConfig {
  const c = loadConfig(env);
  return EndpointConfig.parse({
    label: `candidate (${c.fireworks_model})`,
    url: gatewayUrlForMode(c),
    model: modelField(c),
    headers: {
      Authorization: "Bearer $FIREWORKS_API_KEY",
      "cf-aig-authorization": "Bearer $CF_AIG_TOKEN",
      "cf-aig-metadata": JSON.stringify(buildMetadata(c)),
    },
  });
}

// --- response normalization ------------------------------------------------------

interface ChatMessage {
  role: string;
  content: string;
}

/** Prior transcript turns first, then the scenario messages. */
function caseMessages(evalCase: EvalCase): ChatMessage[] {
  return [...(evalCase.input.transcript ?? []), ...(evalCase.input.messages ?? [])];
}

function safeParseArgs(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw !== "string" || raw === "") return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

interface CompletionPayload {
  id?: unknown;
  model?: unknown;
  choices?: {
    message?: {
      content?: unknown;
      tool_calls?: { function?: { name?: unknown; arguments?: unknown } }[];
    };
  }[];
  usage?: { total_tokens?: unknown; cost?: unknown };
}

/**
 * Normalize one OpenAI-compatible completion payload into `AgentOutput`.
 * `raw` carries only the metric/identity fields the runner reads — never the
 * full provider payload, so captured fixture files stay lean and privacy-safe.
 */
export function parseCompletion(payload: unknown, latencyMs: number): AgentOutput {
  const p = payload as CompletionPayload;
  const message = p.choices?.[0]?.message;
  const tool_calls = (message?.tool_calls ?? []).flatMap((tc) => {
    const name = tc?.function?.name;
    if (typeof name !== "string" || name === "") return [];
    const args = safeParseArgs(tc.function?.arguments);
    return [{ name, ...(args ? { args } : {}) }];
  });
  const usage = p.usage;
  const raw = {
    latency_ms: latencyMs,
    ...(typeof usage?.total_tokens === "number" ? { tokens: usage.total_tokens } : {}),
    ...(typeof usage?.cost === "number" ? { cost_usd: usage.cost } : {}),
    ...(typeof p.model === "string" ? { model: p.model } : {}),
    ...(typeof p.id === "string" ? { id: p.id } : {}),
  };
  return AgentOutput.parse({
    ...(typeof message?.content === "string" ? { text: message.content } : {}),
    tool_calls,
    raw,
  });
}

// --- capture ---------------------------------------------------------------------

export interface CaptureError {
  case_id: string;
  error: string;
}

export interface Capture {
  outputs: Record<string, AgentOutput>;
  errors: CaptureError[];
}

export interface CaptureOptions {
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  now?: () => number;
}

/**
 * Run every case in `cases` against `endpoint`, returning captured outputs keyed
 * by case id plus per-case errors. Latency is measured client-side around the
 * request; tokens/cost come from the provider's `usage` block when present.
 */
export async function captureOutputs(
  cases: EvalCaseInput[],
  endpoint: EndpointConfig,
  opts: CaptureOptions = {},
): Promise<Capture> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  const headers = {
    "Content-Type": "application/json",
    ...resolveHeaders(endpoint.headers, env),
  };

  const outputs: Record<string, AgentOutput> = {};
  const errors: CaptureError[] = [];
  // ponytail: sequential requests; add bounded concurrency if 50-case packs get slow.
  for (const raw of cases) {
    const evalCase = EvalCase.parse(raw);
    const messages = caseMessages(evalCase);
    if (messages.length === 0) {
      errors.push({
        case_id: evalCase.id,
        error: "case has no messages or transcript to send",
      });
      continue;
    }
    const body = JSON.stringify({
      model: endpoint.model,
      messages,
      max_tokens: endpoint.max_tokens,
      temperature: endpoint.temperature,
    });
    const started = now();
    try {
      const res = await fetchImpl(endpoint.url, { method: "POST", headers, body });
      const latency = now() - started;
      if (!res.ok) {
        errors.push({ case_id: evalCase.id, error: `HTTP ${res.status}` });
        continue;
      }
      outputs[evalCase.id] = parseCompletion(await res.json(), latency);
    } catch (e) {
      errors.push({ case_id: evalCase.id, error: (e as Error).message });
    }
  }
  return { outputs, errors };
}
```

- [ ] **Step 4: Run tests and typecheck to verify they pass**

Run: `npx vitest run src/lib/evals/endpointAdapter.test.ts`
Expected: all tests PASS.

Run the focused tsc command from Global Constraints.
Expected: no errors.

Run: `npm run test:evals`
Expected: full eval suite still green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/evals/endpointAdapter.ts src/lib/evals/endpointAdapter.test.ts
git commit -m "feat: add live endpoint capture adapter for eval packs (#229)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Comparison CLI (`compareEndpoints.ts`), metrics note, script, docs

**Files:**
- Create: `src/lib/evals/compareEndpoints.ts`
- Test: `src/lib/evals/compareEndpoints.test.ts`
- Modify: `src/lib/evals/modelComparison.ts` (add `metrics_note` to `CompareOptions`; two small edits)
- Modify: `package.json` (add one script)
- Create: `docs/live-endpoint-comparison.md`
- Modify: `docs/baseline-candidate-comparison.md` (one cross-link line)

**Interfaces:**
- Consumes (from Task 1, exact): `EndpointConfig` (Zod schema; `.parse()` a JSON object), `fireworksCandidateEndpoint(env)`, `captureOutputs(cases, endpoint, {fetchImpl, env, now})` → `Promise<{ outputs: Record<string, AgentOutput>; errors: {case_id, error}[] }>`.
- Consumes (existing): `PACKS`, `runPack` from `./runner`; `compareModels`, `formatComparisonJson`, `formatComparisonMarkdown` from `./modelComparison`.
- Produces: `main(argv: string[], deps?: { fetchImpl?: typeof fetch; env?: Record<string,string|undefined>; now?: () => number }): Promise<number>` exported for tests.

- [ ] **Step 1: Add `metrics_note` to `CompareOptions` in `modelComparison.ts`**

In `src/lib/evals/modelComparison.ts`, change the `CompareOptions` interface:

```ts
export interface CompareOptions {
  baseline_label?: string;
  candidate_label?: string;
  tolerances?: ComparisonTolerances;
  /** Overrides the cost/latency/tokens provenance note (e.g. for live captures). */
  metrics_note?: string;
}
```

and in `compareModels()`, change the hardcoded `note:` line inside `cost_latency_tokens` to:

```ts
      note:
        opts.metrics_note ??
        "Synthetic metadata; indicative only. Real cost/latency/token figures require production trace ingestion (#220).",
```

- [ ] **Step 2: Write the failing test**

Create `src/lib/evals/compareEndpoints.test.ts`:

```ts
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "./compareEndpoints";
import type { AgentOutput, EvalCaseInput } from "./evalCase";
import { PACKS } from "./runner";

const TEST_PACK = "test/live-endpoints";

// Two synthetic cases with UNIQUE message sets (the customer-pilot pack reuses
// message sets across cases, so stub fetches can't key on them — a private pack can).
const CASES: EvalCaseInput[] = [
  {
    id: "live-1",
    product: "migo",
    title: "greeting",
    source: "synthetic",
    input: { messages: [{ role: "user", content: "unique message one" }] },
    expected: { must: ["hello"], privacy_class: "internal" },
    scorer_assignments: [{ id: "must_assertions" }],
  },
  {
    id: "live-2",
    product: "migo",
    title: "no leak",
    source: "synthetic",
    input: { messages: [{ role: "user", content: "unique message two" }] },
    expected: {
      must: ["balance"],
      privacy_class: "confidential",
      data_policy: { forbidden_data: ["SYNTHETIC-SSN-000-00-0000"] },
    },
    scorer_assignments: [{ id: "must_assertions" }, { id: "no_cross_context_leakage" }],
  },
];

const CLEAN: Record<string, AgentOutput> = {
  "live-1": { text: "hello there", tool_calls: [] },
  "live-2": { text: "your balance is available in the app", tool_calls: [] },
};

const LEAKY: Record<string, AgentOutput> = {
  ...CLEAN,
  "live-2": {
    text: "your balance is linked to SYNTHETIC-SSN-000-00-0000",
    tool_calls: [],
  },
};

/**
 * Stub fetch that serves baseline and candidate outputs from different URLs,
 * mapping requests back to cases by their (unique) message content.
 */
function stubFetch(
  byUrl: Record<string, Record<string, AgentOutput>>,
): typeof fetch {
  const caseByMessages = new Map(
    CASES.map((c) => [JSON.stringify(c.input.messages), c.id]),
  );
  return (async (url: unknown, init?: RequestInit) => {
    const fixtures = byUrl[String(url)];
    const body = JSON.parse(String(init?.body)) as { messages: unknown };
    const id = caseByMessages.get(JSON.stringify(body.messages));
    const fx = id && fixtures ? fixtures[id] : undefined;
    if (!fx) return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        id: "cmpl-test",
        model: "stub",
        choices: [{ message: { content: fx.text ?? null, tool_calls: [] } }],
        usage: { total_tokens: 100 },
      }),
    } as unknown as Response;
  }) as typeof fetch;
}

const BASELINE_URL = "https://baseline.test/v1/chat/completions";
const CANDIDATE_URL = "https://candidate.test/v1/chat/completions";

function writeEndpointConfig(dir: string, name: string, url: string): string {
  const path = join(dir, name);
  const config = {
    label: name,
    url,
    model: "stub-model",
    headers: { Authorization: "Bearer $STUB_KEY" },
  };
  require("node:fs").writeFileSync(path, JSON.stringify(config));
  return path;
}

describe("compareEndpoints CLI", () => {
  let dir: string;

  afterEach(() => {
    delete PACKS[TEST_PACK];
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function setup(): { baselinePath: string; candidatePath: string } {
    PACKS[TEST_PACK] = { cases: CASES, fixtures: CLEAN };
    dir = mkdtempSync(join(tmpdir(), "compare-endpoints-"));
    return {
      baselinePath: writeEndpointConfig(dir, "baseline.json", BASELINE_URL),
      candidatePath: writeEndpointConfig(dir, "candidate.json", CANDIDATE_URL),
    };
  }

  it("exits 0 and writes reports when the candidate matches the baseline", async () => {
    const { baselinePath, candidatePath } = setup();
    const code = await main(
      ["--pack", TEST_PACK, "--baseline", baselinePath, "--candidate", candidatePath, "--out-dir", dir],
      {
        env: { STUB_KEY: "k" },
        fetchImpl: stubFetch({ [BASELINE_URL]: CLEAN, [CANDIDATE_URL]: CLEAN }),
      },
    );
    expect(code).toBe(0);
    const report = JSON.parse(
      readFileSync(join(dir, "live-endpoint-comparison.json"), "utf8"),
    ) as { recommendation: { decision: string }; cost_latency_tokens: { note: string } };
    expect(report.recommendation.decision).toBe("hold");
    expect(report.cost_latency_tokens.note).toMatch(/live/i);
    // Captured outputs are written as replayable fixture files.
    const captured = JSON.parse(
      readFileSync(join(dir, "live-endpoint-comparison.candidate-outputs.json"), "utf8"),
    ) as Record<string, { text?: string }>;
    expect(captured["live-1"]?.text).toBe("hello there");
    expect(readFileSync(join(dir, "live-endpoint-comparison.md"), "utf8")).toContain(
      "# Baseline vs candidate model comparison",
    );
  });

  it("exits 1 on a privacy hard-fail regression in the candidate", async () => {
    const { baselinePath, candidatePath } = setup();
    const code = await main(
      ["--pack", TEST_PACK, "--baseline", baselinePath, "--candidate", candidatePath, "--out-dir", dir],
      {
        env: { STUB_KEY: "k" },
        fetchImpl: stubFetch({ [BASELINE_URL]: CLEAN, [CANDIDATE_URL]: LEAKY }),
      },
    );
    expect(code).toBe(1);
    const report = JSON.parse(
      readFileSync(join(dir, "live-endpoint-comparison.json"), "utf8"),
    ) as {
      recommendation: { decision: string; blocking: boolean };
      safety_privacy: { hard_fail_regressions: { case_id: string }[] };
    };
    expect(report.recommendation.decision).toBe("reject");
    expect(report.recommendation.blocking).toBe(true);
    expect(report.safety_privacy.hard_fail_regressions.map((f) => f.case_id)).toEqual([
      "live-2",
    ]);
  });

  it("exits 1 when candidate capture fails (coverage gap blocks)", async () => {
    const { baselinePath, candidatePath } = setup();
    const code = await main(
      ["--pack", TEST_PACK, "--baseline", baselinePath, "--candidate", candidatePath, "--out-dir", dir],
      {
        env: { STUB_KEY: "k" },
        // Candidate URL unknown to the stub -> 404 on every case -> no outputs.
        fetchImpl: stubFetch({ [BASELINE_URL]: CLEAN }),
      },
    );
    expect(code).toBe(1);
  });

  it("exits 1 with usage on missing required flags", async () => {
    const code = await main([], {});
    expect(code).toBe(1);
  });
});
```

Note: replace the `require("node:fs")` call in `writeEndpointConfig` with a top-level `import { writeFileSync } from "node:fs"` merged into the existing `node:fs` import — shown here inline for locality only.

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/lib/evals/compareEndpoints.test.ts`
Expected: FAIL — cannot resolve `./compareEndpoints`.

- [ ] **Step 4: Write the implementation**

Create `src/lib/evals/compareEndpoints.ts`:

```ts
/**
 * Live baseline-vs-candidate endpoint comparison CLI (issue #229).
 *
 * Captures one eval pack's cases from TWO live OpenAI-compatible endpoints
 * (e.g. current production model vs a Fireworks candidate routed through
 * Cloudflare AI Gateway), scores both with the existing runner, and emits the
 * modelComparison Markdown/JSON report with promote/hold/reject CI exit
 * semantics. Endpoint request failures surface as candidate coverage gaps,
 * which block promotion (fail-closed).
 *
 *   npx tsx src/lib/evals/compareEndpoints.ts \
 *     --pack customer-pilot/smoke \
 *     --baseline ./baseline-endpoint.json \
 *     --candidate fireworks:env \
 *     --out-dir artifacts
 *
 * Endpoint config JSON: { label, url, model, headers?, max_tokens?, temperature? }.
 * Header values use $ENV_VAR placeholders (never raw secrets). The special spec
 * `fireworks:env` builds the candidate from CF_* / FIREWORKS_* env vars and
 * fails closed when they are missing. Captured outputs are written alongside
 * the reports as fixture files replayable via `cli.ts --candidate-fixtures`.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  type Capture,
  captureOutputs,
  EndpointConfig,
  fireworksCandidateEndpoint,
} from "./endpointAdapter";
import {
  compareModels,
  formatComparisonJson,
  formatComparisonMarkdown,
} from "./modelComparison";
import { PACKS, runPack } from "./runner";

const OUT_BASENAME = "live-endpoint-comparison";
const USAGE =
  "usage: compareEndpoints --pack <pack> --baseline <endpoint.json> " +
  "--candidate <endpoint.json | fireworks:env> [--out-dir artifacts]\n";

function parseArgs(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a?.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[a.slice(2)] = next;
      i++;
    }
  }
  return flags;
}

function loadEndpoint(
  spec: string,
  env: Record<string, string | undefined>,
): EndpointConfig {
  if (spec === "fireworks:env") return fireworksCandidateEndpoint(env);
  return EndpointConfig.parse(JSON.parse(readFileSync(spec, "utf8")));
}

function reportCaptureErrors(side: string, capture: Capture): void {
  for (const e of capture.errors) {
    process.stderr.write(`${side} capture failed for ${e.case_id}: ${e.error}\n`);
  }
}

export interface Deps {
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  now?: () => number;
}

export async function main(argv: string[], deps: Deps = {}): Promise<number> {
  const flags = parseArgs(argv);
  const packName = flags.pack ?? "customer-pilot/smoke";
  const pack = PACKS[packName];
  if (!flags.baseline || !flags.candidate || !pack) {
    if (!pack) process.stderr.write(`Unknown pack: ${packName}. Known: ${Object.keys(PACKS).join(", ")}\n`);
    process.stderr.write(USAGE);
    return 1;
  }
  const env = deps.env ?? process.env;
  const outDir = flags["out-dir"] ?? "artifacts";

  const baselineEndpoint = loadEndpoint(flags.baseline, env);
  const candidateEndpoint = loadEndpoint(flags.candidate, env);

  const captureOpts = { fetchImpl: deps.fetchImpl, env, now: deps.now };
  const baselineCapture = await captureOutputs(pack.cases, baselineEndpoint, captureOpts);
  reportCaptureErrors("baseline", baselineCapture);
  const candidateCapture = await captureOutputs(pack.cases, candidateEndpoint, captureOpts);
  reportCaptureErrors("candidate", candidateCapture);

  // Captured outputs double as replayable fixture files (cli.ts --candidate-fixtures).
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    `${outDir}/${OUT_BASENAME}.baseline-outputs.json`,
    JSON.stringify(baselineCapture.outputs, null, 2),
  );
  writeFileSync(
    `${outDir}/${OUT_BASENAME}.candidate-outputs.json`,
    JSON.stringify(candidateCapture.outputs, null, 2),
  );

  const baseline = await runPack(packName, baselineCapture.outputs);
  const candidate = await runPack(packName, candidateCapture.outputs);
  const cmp = compareModels(baseline, candidate, {
    baseline_label: baselineEndpoint.label,
    candidate_label: candidateEndpoint.label,
    metrics_note:
      "Metrics captured live from endpoint responses: latency measured client-side; " +
      "tokens/cost as reported by the provider (cost may be n/a — Gateway logs are authoritative).",
  });

  const md = formatComparisonMarkdown(cmp);
  writeFileSync(`${outDir}/${OUT_BASENAME}.md`, md);
  writeFileSync(`${outDir}/${OUT_BASENAME}.json`, formatComparisonJson(cmp));
  process.stdout.write(md + "\n");
  process.stdout.write(
    `\nWrote ${outDir}/${OUT_BASENAME}.{md,json} — decision: ${cmp.recommendation.decision}.\n`,
  );
  return cmp.recommendation.blocking ? 1 : 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
```

Also add to `package.json` scripts (after `"compare:customer-pilot"`):

```json
    "compare:endpoints": "npx tsx src/lib/evals/compareEndpoints.ts",
```

- [ ] **Step 5: Run tests and typecheck to verify they pass**

Run: `npx vitest run src/lib/evals/compareEndpoints.test.ts`
Expected: all tests PASS.

Run: `npm run test:evals`
Expected: full suite green (including the untouched `modelComparison.test.ts`).

Run the focused tsc command from Global Constraints.
Expected: no errors.

- [ ] **Step 6: Write docs**

Create `docs/live-endpoint-comparison.md`:

```markdown
# Live endpoint comparison (issue #229)

Runs one eval pack against **two live OpenAI-compatible endpoints** — the current
production/baseline model and a Fireworks candidate routed through Cloudflare AI
Gateway — then scores both sides with the standard scorer pack and emits the
baseline-vs-candidate comparison report with CI exit semantics.

This is the live-capture layer on top of the fixture-based comparison documented
in `baseline-candidate-comparison.md`. The comparison, recommendation, and
report logic are identical; only the source of the outputs differs.

## Run it

```bash
npm run compare:endpoints -- \
  --pack customer-pilot/smoke \
  --baseline ./baseline-endpoint.json \
  --candidate fireworks:env \
  --out-dir artifacts
```

Writes `artifacts/live-endpoint-comparison.{md,json}` plus the captured outputs
(`.baseline-outputs.json` / `.candidate-outputs.json`) — the captured files are
replayable offline via `npx tsx src/lib/evals/cli.ts --candidate-fixtures <file>`.

Exit code is non-zero when the recommendation is blocking: any privacy/tool-safety
hard-fail regression, or incomplete candidate coverage (including failed requests —
capture errors fail closed).

## Endpoint config

A JSON file per endpoint:

```json
{
  "label": "baseline (gpt-4o via openrouter)",
  "url": "https://openrouter.ai/api/v1/chat/completions",
  "model": "openai/gpt-4o",
  "headers": { "Authorization": "Bearer $OPENROUTER_API_KEY" }
}
```

Header values use `$ENV_VAR` placeholders resolved from the environment at
request time — **never put raw secrets in config files**. Optional fields:
`max_tokens` (default 512), `temperature` (default 0).

## Fireworks candidate via `fireworks:env`

`--candidate fireworks:env` builds the candidate endpoint from the same env vars
as the routing prototype (`fireworks-cloudflare-routing-prototype.md`):
`CF_ACCOUNT_ID`, `CF_AIG_GATEWAY`, `FIREWORKS_MODEL`, `TENANT_LABEL`, `PRODUCT`
(required), plus `CF_AIG_MODE`, `MODULE`, `PROMPT_VERSION`, `VARIANT`, `RELEASE`,
`ENVIRONMENT` (optional), and the two secrets `FIREWORKS_API_KEY` and
`CF_AIG_TOKEN`. It fails closed when required config is missing. Requests carry
the `cf-aig-metadata` header, so the run's traces land in Gateway logs with the
standard metadata and can be re-ingested via `cloudflareAiGateway.ts`.

## Metrics

- **Latency** — measured client-side around each request.
- **Tokens** — `usage.total_tokens` from the provider response.
- **Cost** — `usage.cost` when the provider reports it (often absent; Cloudflare
  AI Gateway logs are the authoritative cost source — see #220).

## Privacy

The Markdown/JSON reports keep the management-safe contract (case IDs, scorer
IDs, scores, aggregates only). The captured `*-outputs.json` files DO contain raw
model output — they are written to the gitignored `artifacts/` directory for
replay/debugging. The customer-pilot pack is fully synthetic; when running packs
derived from production logs, treat the captured output files per the case's
`privacy_class`.
```

Append one cross-link line to the end of the intro section of `docs/baseline-candidate-comparison.md` (right after its opening paragraph):

```markdown
For running the same comparison against two **live** endpoints (baseline model +
Fireworks candidate via Cloudflare AI Gateway), see `live-endpoint-comparison.md`.
```

- [ ] **Step 7: Commit**

```bash
git add src/lib/evals/compareEndpoints.ts src/lib/evals/compareEndpoints.test.ts \
  src/lib/evals/modelComparison.ts package.json \
  docs/live-endpoint-comparison.md docs/baseline-candidate-comparison.md
git commit -m "feat: add live baseline-vs-candidate endpoint comparison CLI (#229)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Acceptance criteria mapping (issue #229)

- **Run a selected eval pack against two model endpoints** → Task 1 `captureOutputs` + Task 2 CLI (`--pack`, `--baseline`, `--candidate`).
- **Produces Markdown and JSON comparison reports** → existing `formatComparisonMarkdown/Json`, written by Task 2.
- **Hard-fails on privacy/tool-safety regressions** → existing `recommend()` blocking logic + Task 2 exit code (test: leaky candidate → exit 1).
- **Shows cost/latency/token deltas** → live `raw.{cost_usd, latency_ms, tokens}` from Task 1 flow into existing `aggregateMetrics`; `metrics_note` documents provenance.
- **Works with synthetic Pennie smoke cases without production data** → default pack is `customer-pilot/smoke` (fully synthetic); tests use stub fetch, no network.
- **(Issue comment) customer-facing scorecard artifact with quality/safety/cost/latency/recommendation sections** → the existing comparison Markdown already has exactly these sections; Task 2 writes it per run.
