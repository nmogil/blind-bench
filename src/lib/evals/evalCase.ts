/**
 * Blind Bench portable eval-case schema and scorer contract.
 *
 * Single source of truth for:
 *  - eval case shape (synthetic / production-log-derived / replay scenarios)
 *  - expected-behavior assertions (must / may / must_not, tools, escalation, data policy, privacy)
 *  - the scorer contract (deterministic checks + LLM judges) with score / pass-fail /
 *    reason / evidence spans / hard-fail semantics
 *  - the platform-agnostic result row that can be uploaded later to
 *    Cloudflare / Braintrust / Langfuse / local JSONL.
 *
 * Zod is the source of truth; TS types are inferred and JSON Schema is exported
 * (see `evalCaseJsonSchema`) so the contract is portable to non-TS consumers.
 *
 * Deliberately platform-agnostic: `product`, tool names, data-policy labels, and
 * input shape are open strings/records, not closed enums, so the same schema
 * serves Pennie / Eavesly / Migo and future Blind Bench customers.
 */
// zod 3.25 exposes the v4 API on this subpath; use it for JSON Schema export.
import { z } from "zod/v4";

// --- Scenario provenance -----------------------------------------------------

/** How a case was obtained. Drives sampling/weighting, not scoring. */
export const ScenarioSource = z.enum(["synthetic", "production_log", "replay"]);
export type ScenarioSource = z.infer<typeof ScenarioSource>;

/**
 * Privacy classification of the data a case carries. `synthetic` cases must use
 * fake data; real data must be classed honestly so runners can gate storage.
 */
export const PrivacyClass = z.enum([
  "public",
  "internal",
  "confidential",
  "pii",
  "phi",
]);
export type PrivacyClass = z.infer<typeof PrivacyClass>;

// --- Case input --------------------------------------------------------------

const Message = z.object({
  role: z.string().describe("e.g. system | user | assistant | tool"),
  content: z.string(),
});

/**
 * The scenario presented to the agent under test. Kept open: synthetic cases set
 * `messages`/`variables`; replay and production-log cases may carry a full prior
 * `transcript` plus arbitrary `context`.
 */
export const CaseInput = z.object({
  messages: z.array(Message).optional(),
  /** Template variables / structured params for the prompt under test. */
  variables: z.record(z.string(), z.unknown()).optional(),
  /** Prior turns for replay/production-log cases. */
  transcript: z.array(Message).optional(),
  /** Free-form, platform-specific context (account state, flags, fixtures). */
  context: z.record(z.string(), z.unknown()).optional(),
});
export type CaseInput = z.infer<typeof CaseInput>;

// --- Expected behavior -------------------------------------------------------

export const ExpectedToolCall = z.object({
  name: z.string(),
  /** Expected argument subset; deterministic scorers match these as a partial. */
  args: z.record(z.string(), z.unknown()).optional(),
  /** false = allowed-if-present; true (default) = must be called. */
  required: z.boolean().default(true),
});
export type ExpectedToolCall = z.infer<typeof ExpectedToolCall>;

export const ExpectedEscalation = z.object({
  should_escalate: z.boolean(),
  /** Target queue/role/human, e.g. "human_agent", "tier2". */
  to: z.string().optional(),
  reason: z.string().optional(),
});
export type ExpectedEscalation = z.infer<typeof ExpectedEscalation>;

/**
 * Data-policy expectation for the case: which data the agent may read/emit. Labels
 * are open strings so each product names its own sources (e.g. "credit_report",
 * "call_recording").
 */
export const DataPolicy = z.object({
  allowed_data: z.array(z.string()).optional(),
  forbidden_data: z.array(z.string()).optional(),
  /** Retention expectation, e.g. "ephemeral", "30d", "do_not_store". */
  retention: z.string().optional(),
});
export type DataPolicy = z.infer<typeof DataPolicy>;

export const ExpectedBehavior = z.object({
  /** Assertions that MUST hold. Any failure is a case failure. */
  must: z.array(z.string()).default([]),
  /** Allowed/optional behaviors. Presence neither passes nor fails on its own. */
  may: z.array(z.string()).default([]),
  /** Forbidden behaviors. Any occurrence is a (typically hard) failure. */
  must_not: z.array(z.string()).default([]),
  expected_tool_calls: z.array(ExpectedToolCall).default([]),
  /** null = escalation not relevant to this case. */
  expected_escalation: ExpectedEscalation.nullable().default(null),
  data_policy: DataPolicy.optional(),
  privacy_class: PrivacyClass,
});
export type ExpectedBehavior = z.infer<typeof ExpectedBehavior>;

// --- Eval case ---------------------------------------------------------------

export const ScorerKind = z.enum(["deterministic", "llm_judge"]);
export type ScorerKind = z.infer<typeof ScorerKind>;

/** Serializable per-case assignment consumed by local/CI runners. */
export const ScorerAssignment = z.object({
  id: z.string(),
  kind: ScorerKind.optional(),
  required: z.boolean().default(true),
  weight: z.number().positive().default(1),
  hard_fail_on_failure: z.boolean().default(false),
  config: z.record(z.string(), z.unknown()).optional(),
});
export type ScorerAssignment = z.infer<typeof ScorerAssignment>;

export const EvalCase = z.object({
  id: z.string(),
  /** Owning product/agent, open string for portability: "eavesly", "migo", ... */
  product: z.string(),
  title: z.string(),
  description: z.string().optional(),
  source: ScenarioSource,
  tags: z.array(z.string()).default([]),
  input: CaseInput,
  expected: ExpectedBehavior,
  /** Data-driven scorer assignments used by local/CI runners. */
  scorer_assignments: z.array(ScorerAssignment).default([]),
  /** Platform-specific extras; never required for scoring. */
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type EvalCase = z.infer<typeof EvalCase>;
/** Authoring shape (pre-parse): fields with schema defaults are optional. */
export type EvalCaseInput = z.input<typeof EvalCase>;

// --- Agent output under test -------------------------------------------------

const ActualToolCall = z.object({
  name: z.string(),
  args: z.record(z.string(), z.unknown()).optional(),
});

/** What the agent produced for a case; the unit a scorer grades. */
export const AgentOutput = z.object({
  text: z.string().optional(),
  tool_calls: z.array(ActualToolCall).default([]),
  escalated: z.boolean().optional(),
  /** Raw provider payload for evidence/debugging. */
  raw: z.unknown().optional(),
});
export type AgentOutput = z.infer<typeof AgentOutput>;

// --- Scorer contract ---------------------------------------------------------

/**
 * Points at the text supporting a verdict. `source` names where the span lives
 * (e.g. "output.text", "input.transcript[2]"); offsets are optional so an
 * LLM judge can cite a `snippet` without exact indices.
 */
export const EvidenceSpan = z.object({
  source: z.string(),
  start: z.number().int().nonnegative().optional(),
  end: z.number().int().nonnegative().optional(),
  snippet: z.string().optional(),
});
export type EvidenceSpan = z.infer<typeof EvidenceSpan>;

export const ScorerResult = z.object({
  /** Stable id of the scorer that produced this result. */
  scorer: z.string(),
  kind: ScorerKind,
  /** Normalized [0,1]. Deterministic pass/fail scorers use 1 or 0. */
  score: z.number().min(0).max(1),
  passed: z.boolean(),
  reason: z.string(),
  evidence: z.array(EvidenceSpan).default([]),
  /**
   * Hard-fail semantics: a true value forces the whole case to fail regardless
   * of other scores (e.g. a must_not or data-policy violation).
   */
  hard_fail: z.boolean().default(false),
});
export type ScorerResult = z.infer<typeof ScorerResult>;

/**
 * A scorer grades one (case, output) pair. Same interface for deterministic
 * checks and LLM judges — judges are just async. Not a zod schema (functions
 * aren't serializable); this is the runtime contract scorer authors implement.
 */
export interface Scorer {
  id: string;
  kind: ScorerKind;
  score(evalCase: EvalCase, output: AgentOutput): ScorerResult | Promise<ScorerResult>;
}

// --- Platform-agnostic result row -------------------------------------------

/**
 * One graded case. This is the portable JSONL row uploaded to Cloudflare /
 * Braintrust / Langfuse / local file — no Blind Bench internal ids leak in.
 */
export const EvalResult = z.object({
  case_id: z.string(),
  /** Optional grouping id for a batch/experiment. */
  run_id: z.string().optional(),
  output: AgentOutput,
  scores: z.array(ScorerResult),
  /** Mean of scores. */
  score: z.number().min(0).max(1),
  /** All scorers passed AND none hard-failed. */
  passed: z.boolean(),
  hard_failed: z.boolean(),
  /** ISO-8601; set by the runner, not derived here. */
  timestamp: z.string().optional(),
});
export type EvalResult = z.infer<typeof EvalResult>;

/**
 * Combine scorer results into the case verdict. Pure; the runner adds ids,
 * output, and timestamp. Hard-fail dominates: any hard_fail => not passed.
 */
export function aggregateScores(
  scores: ScorerResult[],
): Pick<EvalResult, "score" | "passed" | "hard_failed"> {
  const hard_failed = scores.some((s) => s.hard_fail && !s.passed);
  const mean =
    scores.length === 0
      ? 0
      : scores.reduce((sum, s) => sum + s.score, 0) / scores.length;
  return {
    score: mean,
    passed: scores.length > 0 && scores.every((s) => s.passed) && !hard_failed,
    hard_failed,
  };
}

// --- JSON Schema export (portability for non-TS consumers) -------------------

/**
 * JSON Schema for eval-case authors. Mirrored to schemas/eval-case.schema.json.
 * Use input mode so non-TS producers can omit fields that zod defaults at parse time.
 */
export const evalCaseJsonSchema = z.toJSONSchema(EvalCase, { io: "input" });
/** JSON Schema for a produced result row. Mirrored to schemas/eval-result.schema.json. */
export const evalResultJsonSchema = z.toJSONSchema(EvalResult, { io: "output" });
