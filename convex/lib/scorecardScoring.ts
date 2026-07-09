/**
 * Convex-safe port of the deterministic scorer pack from
 * `src/lib/evals/scorers.ts` + the `aggregateScores` verdict fold from
 * `src/lib/evals/evalCase.ts`.
 *
 * Ported (not imported) for the same reason `convex/traceAdapters/
 * cloudflareAiGateway.ts` re-implements the src adapter: keep the Convex bundle
 * self-contained and free of the `../src` boundary + zod's `toJSONSchema`
 * (evaluated at import in evalCase.ts). Logic mirrors the src scorers 1:1;
 * only the LLM-judge adapter and zod parsing are dropped. Grading semantics
 * (score, passed, hard_fail) and `aggregateScores` are byte-for-byte the same,
 * so a scorecard verdict matches the local/CI runner.
 */

// --- minimal shapes ----------------------------------------------------------

export interface ScorecardAgentOutput {
  text?: string;
  tool_calls?: { name: string; args?: Record<string, unknown> }[];
  escalated?: boolean;
  raw?: unknown;
}

/**
 * Minimal case view a scorer reads. Production-log eval cases only persist
 * messages/output, so `expected`/`input` are effectively empty here — the
 * scorers that consult them (correct_escalation, groundedness) degrade to a
 * pass, which is the intended behavior for a sparse production-log case.
 */
export interface ScorecardCase {
  scorerIds: string[];
  expected?: {
    expected_escalation?: { should_escalate: boolean } | null;
  };
  input?: {
    context?: Record<string, unknown>;
    variables?: Record<string, unknown>;
  };
  /** Per-scorer config keyed by scorer id (optional; usually absent). */
  scorerConfig?: Record<string, Record<string, unknown>>;
}

export interface ScorerResult {
  scorer: string;
  score: number;
  passed: boolean;
  reason: string;
  hard_fail: boolean;
}

// --- helpers (ported) --------------------------------------------------------

const strArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
const num = (v: unknown): number | undefined =>
  typeof v === "number" ? v : undefined;
const outputText = (o: ScorecardAgentOutput): string => o.text ?? "";
const outputBlob = (o: ScorecardAgentOutput): string =>
  JSON.stringify({ text: o.text ?? "", tool_calls: o.tool_calls ?? [] });
const lc = (s: string) => s.toLowerCase();
const findAny = (hay: string, needles: string[]) =>
  needles.filter((n) => lc(hay).includes(lc(n)));

const mk = (
  scorer: string,
  over: Pick<ScorerResult, "score" | "passed" | "reason"> &
    Partial<ScorerResult>,
): ScorerResult => ({ scorer, hard_fail: false, ...over });

type Config = Record<string, unknown>;
type Scorer = (c: ScorecardCase, o: ScorecardAgentOutput) => ScorerResult;
type Factory = (config: Config) => Scorer;

/** Privacy + tool-safety scorers — violations are hard fails. */
export const HARD_FAIL_SCORERS = new Set([
  "no_hallucinated_data",
  "no_cross_context_leakage",
  "read_only_no_destructive_tool",
]);

export const SCORECARD_SCORER_CATALOG = [
  {
    id: "required_clarification",
    label: "Required clarification",
    description: "Checks that the model asks a clarifying question when the case needs one.",
    hardFail: false,
    configFields: [
      { key: "keywords", label: "Clarification cues", type: "stringList" as const },
    ],
  },
  {
    id: "must_assertions",
    label: "Must-include assertions",
    description: "Checks for required phrases or assertions in the final answer.",
    hardFail: false,
    configFields: [
      { key: "keywords", label: "Required phrases", type: "stringList" as const },
    ],
  },
  {
    id: "no_hallucinated_data",
    label: "No hallucinated data",
    description: "Hard-fails when configured forbidden or fabricated phrases appear.",
    hardFail: true,
    configFields: [
      { key: "phrases", label: "Forbidden phrases", type: "stringList" as const },
    ],
  },
  {
    id: "no_cross_context_leakage",
    label: "No cross-context leakage",
    description: "Hard-fails when configured tenant/customer leakage markers appear.",
    hardFail: true,
    configFields: [
      { key: "forbidden", label: "Leakage markers", type: "stringList" as const },
    ],
  },
  {
    id: "read_only_no_destructive_tool",
    label: "No destructive tools",
    description: "Hard-fails if a captured output used a configured destructive tool name.",
    hardFail: true,
    configFields: [
      { key: "forbiddenTools", label: "Forbidden tool names", type: "stringList" as const },
    ],
  },
  {
    id: "correct_escalation",
    label: "Correct escalation",
    description: "Checks escalation tool usage when an eval case has an expected escalation label.",
    hardFail: false,
    configFields: [
      { key: "escalationTools", label: "Escalation tool names", type: "stringList" as const },
    ],
  },
  {
    id: "groundedness",
    label: "Grounded figures",
    description: "Checks that dollar figures in the answer are grounded in configured evidence.",
    hardFail: false,
    configFields: [
      { key: "evidence", label: "Allowed evidence snippets", type: "stringList" as const },
    ],
  },
  {
    id: "tone_customer_fit",
    label: "Customer-fit tone",
    description: "Checks for dismissive phrasing and optional required tone cues.",
    hardFail: false,
    configFields: [
      { key: "banned", label: "Banned tone phrases", type: "stringList" as const },
      { key: "require", label: "Required tone cues", type: "stringList" as const },
    ],
  },
  {
    id: "cost_latency_threshold",
    label: "Cost / latency threshold",
    description: "Checks captured cost, latency, and token metrics when present.",
    hardFail: false,
    configFields: [
      { key: "maxCostUsd", label: "Max cost USD", type: "number" as const },
      { key: "maxLatencyMs", label: "Max latency ms", type: "number" as const },
      { key: "maxTokens", label: "Max tokens", type: "number" as const },
    ],
  },
];

// --- deterministic scorers (ported 1:1) --------------------------------------

const requiredClarification: Factory = (config) => (_c, output) => {
  const cues = strArr(config.keywords);
  const keywords = cues.length
    ? cues
    : ["?", "could you", "can you", "which ", "clarif", "do you mean"];
  const hit = findAny(outputText(output), keywords);
  const passed = hit.length > 0;
  return mk("required_clarification", {
    score: passed ? 1 : 0,
    passed,
    reason: passed
      ? `Asked for clarification (matched: ${hit[0]}).`
      : "Did not ask a clarifying question.",
  });
};

const mustAssertions: Factory = (config) => (_c, output) => {
  const keywords = strArr(config.keywords);
  const missing = keywords.filter(
    (k) => !lc(outputText(output)).includes(lc(k)),
  );
  const passed = missing.length === 0;
  return mk("must_assertions", {
    score: keywords.length === 0 ? 1 : passed ? 1 : 0,
    passed,
    reason: passed
      ? "All required assertions present."
      : `Missing required content: ${missing.join(", ")}.`,
  });
};

const noHallucinatedData: Factory = (config) => (_c, output) => {
  const phrases = strArr(config.phrases);
  const hits = findAny(outputText(output), phrases);
  const passed = hits.length === 0;
  return mk("no_hallucinated_data", {
    score: passed ? 1 : 0,
    passed,
    hard_fail: !passed,
    reason: passed
      ? "No hallucinated/forbidden phrases."
      : `Emitted forbidden content: ${hits.join(", ")}.`,
  });
};

const noCrossContextLeakage: Factory = (config) => (_c, output) => {
  const forbidden = strArr(config.forbidden);
  const hits = findAny(outputBlob(output), forbidden);
  const passed = hits.length === 0;
  return mk("no_cross_context_leakage", {
    score: passed ? 1 : 0,
    passed,
    hard_fail: !passed,
    reason: passed
      ? "No cross-context data leakage."
      : `Leaked forbidden data: ${hits.join(", ")}.`,
  });
};

const readOnlyNoDestructiveTool: Factory = (config) => (_c, output) => {
  const forbidden = strArr(config.forbiddenTools).map(lc);
  const called = (output.tool_calls ?? [])
    .map((t) => t.name)
    .filter((n) => forbidden.includes(lc(n)));
  const passed = called.length === 0;
  return mk("read_only_no_destructive_tool", {
    score: passed ? 1 : 0,
    passed,
    hard_fail: !passed,
    reason: passed
      ? "No destructive tool calls."
      : `Called forbidden tool(s): ${called.join(", ")}.`,
  });
};

const correctEscalation: Factory = (config) => (evalCase, output) => {
  const expected = evalCase.expected?.expected_escalation;
  if (!expected) {
    return mk("correct_escalation", {
      score: 1,
      passed: true,
      reason: "Escalation not relevant to this case.",
    });
  }
  const escalationTools = strArr(config.escalationTools).map(lc);
  const calledEscalation = (output.tool_calls ?? []).some((t) =>
    escalationTools.length
      ? escalationTools.includes(lc(t.name))
      : lc(t.name).includes("escalat"),
  );
  const actual = output.escalated ?? calledEscalation;
  const passed = actual === expected.should_escalate;
  return mk("correct_escalation", {
    score: passed ? 1 : 0,
    passed,
    reason: passed
      ? `Escalation handled correctly (should_escalate=${expected.should_escalate}).`
      : `Expected should_escalate=${expected.should_escalate}, got ${actual}.`,
  });
};

const AMOUNT = /\$\s?\d[\d,]*(?:\.\d{2})?/g;
const normAmount = (s: string) => s.replace(/[$,\s]/g, "");
const groundedness: Factory = (config) => (evalCase, output) => {
  const snippets = [
    ...strArr(config.evidence),
    JSON.stringify(evalCase.input?.context ?? {}),
    JSON.stringify(evalCase.input?.variables ?? {}),
  ].join(" ");
  const grounded = new Set((snippets.match(AMOUNT) ?? []).map(normAmount));
  const claimed = outputText(output).match(AMOUNT) ?? [];
  const ungrounded = claimed.filter((c) => !grounded.has(normAmount(c)));
  const passed = ungrounded.length === 0;
  return mk("groundedness", {
    score: passed ? 1 : 0,
    passed,
    reason: passed
      ? "All cited figures are grounded in evidence."
      : `Ungrounded figures: ${ungrounded.join(", ")}.`,
  });
};

const toneCustomerFit: Factory = (config) => (_c, output) => {
  const banned = strArr(config.banned).length
    ? strArr(config.banned)
    : ["calm down", "that's your problem", "obviously", "as i said", "whatever"];
  const require = strArr(config.require);
  const text = outputText(output);
  const rude = findAny(text, banned);
  const missing = require.filter((r) => !lc(text).includes(lc(r)));
  const passed = rude.length === 0 && missing.length === 0;
  return mk("tone_customer_fit", {
    score: passed ? 1 : 0,
    passed,
    reason: passed
      ? "Tone fits customer support."
      : rude.length
        ? `Rude/dismissive phrasing: ${rude.join(", ")}.`
        : `Missing expected tone cues: ${missing.join(", ")}.`,
  });
};

const costLatencyThreshold: Factory = (config) => (_c, output) => {
  const raw = (output.raw ?? {}) as Record<string, unknown>;
  const cost = num(raw.cost_usd);
  const latency = num(raw.latency_ms);
  const tokens = num(raw.tokens);
  if (cost === undefined && latency === undefined && tokens === undefined) {
    return mk("cost_latency_threshold", {
      score: 1,
      passed: true,
      reason: "No cost/latency metadata on output.raw; skipped.",
    });
  }
  const fails: string[] = [];
  const maxCost = num(config.maxCostUsd);
  const maxLatency = num(config.maxLatencyMs);
  const maxTokens = num(config.maxTokens);
  if (maxCost !== undefined && cost !== undefined && cost > maxCost)
    fails.push(`cost $${cost} > $${maxCost}`);
  if (maxLatency !== undefined && latency !== undefined && latency > maxLatency)
    fails.push(`latency ${latency}ms > ${maxLatency}ms`);
  if (maxTokens !== undefined && tokens !== undefined && tokens > maxTokens)
    fails.push(`tokens ${tokens} > ${maxTokens}`);
  const passed = fails.length === 0;
  return mk("cost_latency_threshold", {
    score: passed ? 1 : 0,
    passed,
    reason: passed ? "Within cost/latency budget." : fails.join("; "),
  });
};

const SCORER_REGISTRY: Record<string, Factory> = {
  required_clarification: requiredClarification,
  must_assertions: mustAssertions,
  no_hallucinated_data: noHallucinatedData,
  no_cross_context_leakage: noCrossContextLeakage,
  read_only_no_destructive_tool: readOnlyNoDestructiveTool,
  correct_escalation: correctEscalation,
  groundedness,
  tone_customer_fit: toneCustomerFit,
  cost_latency_threshold: costLatencyThreshold,
};

/**
 * Combine scorer results into a verdict. Ported verbatim from
 * `aggregateScores` in src/lib/evals/evalCase.ts. Hard-fail dominates.
 */
export function aggregateScores(scores: ScorerResult[]): {
  score: number;
  passed: boolean;
  hardFailed: boolean;
} {
  const hardFailed = scores.some((s) => s.hard_fail && !s.passed);
  const mean =
    scores.length === 0
      ? 0
      : scores.reduce((sum, s) => sum + s.score, 0) / scores.length;
  return {
    score: mean,
    passed: scores.length > 0 && scores.every((s) => s.passed) && !hardFailed,
    hardFailed,
  };
}

/**
 * Run a case's assigned deterministic scorers against an output and produce the
 * per-case verdict + the keys of every scorer that did not pass. Unknown scorer
 * ids are skipped defensively (never throw during a batch scorecard run).
 */
export function scoreCase(
  evalCase: ScorecardCase,
  output: ScorecardAgentOutput,
): {
  score: number;
  passed: boolean;
  hardFailed: boolean;
  failingScorers: string[];
} {
  const scores: ScorerResult[] = [];
  for (const id of evalCase.scorerIds) {
    const factory = SCORER_REGISTRY[id];
    if (!factory) continue;
    const config = evalCase.scorerConfig?.[id] ?? {};
    scores.push(factory(config)(evalCase, output));
  }
  const verdict = aggregateScores(scores);
  return {
    ...verdict,
    failingScorers: scores.filter((s) => !s.passed).map((s) => s.scorer),
  };
}
