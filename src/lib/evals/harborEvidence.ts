import type { AgentRunTrace, AgentTraceStep, PrivacyClass } from "./agentTrace.core";

const MAX_RUNS = 50;
const MAX_EVENTS = 2_000;
const MAX_TEXT = 256_000;
const MAX_PATCH = 65_536;
const MAX_STREAM = 8_192;
const MAX_CHANGED_FILES = 500;
const MAX_JSON_FIELD = 256_000;
const SHA256 = /^[0-9a-f]{64}$/;
const EVENT_ID = /^evt-[0-9a-f]{32}$/;
const PRIVACY = new Set(["public", "internal", "confidential", "pii", "phi"]);
const EVENT_KINDS = new Set([
  "user_message", "assistant_message", "assistant_reasoning", "tool_call",
  "tool_result", "tool_error", "final_output", "termination",
]);
const RUN_STATUSES = new Set(["quality_eligible", "fixture_complete", "insufficient"]);
const REVIEWER_ENVIRONMENT_CLASSES = new Set(["docker", "isolated-sandbox"]);
const PROCESS_STATUSES = new Set(["succeeded", "failed"]);
const VERIFIER_STATUSES = new Set(["passed", "failed", "not_run"]);
const INFRASTRUCTURE_STATUSES = new Set(["succeeded", "failed"]);
const EVIDENCE_STATUSES = new Set(["complete", "incomplete"]);
const REQUIRED_OUTCOMES = {
  process: "succeeded",
  verifier: "passed",
  infrastructure: "succeeded",
  evidenceCompleteness: "complete",
} as const;

export const HARBOR_EVIDENCE_MAX_RUNS = MAX_RUNS;

export type OutcomeStatus = { readonly status: string; readonly summary?: string };
export type HarborReviewerEvent = {
  readonly sequence: number;
  readonly kind: string;
  readonly timestamp?: string;
  readonly role?: string;
  readonly content?: string;
  readonly callId?: string;
  readonly toolName?: string;
  readonly status?: string;
  readonly arguments?: unknown;
  readonly result?: unknown;
  readonly error?: string;
  readonly reason?: string;
};
export type HarborReviewerProjection = {
  readonly taskPrompt: string;
  /** Reviewer-safe producer revision. Legacy projections may not contain it. */
  readonly taskRevision?: string;
  readonly timing: { readonly startedAt: string; readonly completedAt: string; readonly durationMs: number };
  readonly events: ReadonlyArray<HarborReviewerEvent>;
  readonly finalOutput: string;
  readonly termination: { readonly status: string; readonly reason: string };
  readonly outcomes: {
    readonly process: OutcomeStatus;
    readonly verifier: OutcomeStatus;
    readonly infrastructure: OutcomeStatus;
  };
  readonly runQualification: "quality_eligible" | "fixture_only" | "insufficient";
  readonly evidenceCompleteness: "complete" | "insufficient";
  readonly evidenceWarning?: string;
  readonly canJudgeTaskSuccess: boolean;
  readonly changedFiles: ReadonlyArray<{ readonly path: string; readonly status?: string }>;
  readonly patch?: string;
  readonly patchTruncated: boolean;
  readonly verifierEvidence?: {
    readonly commandSummary: string;
    readonly exitCode: number | null;
    readonly timedOut: boolean;
    readonly stdout?: string;
    readonly stderr?: string;
    readonly stdoutTruncated: boolean;
    readonly stderrTruncated: boolean;
  };
  readonly integrity: { readonly status: string; readonly checksums: ReadonlyArray<string> };
};
export type ParsedHarborEvidence = {
  readonly run: {
    readonly stableId: string;
    readonly attempt: string;
    readonly status: "quality_eligible" | "fixture_complete" | "insufficient";
  };
  readonly trace: AgentRunTrace;
  readonly projection: HarborReviewerProjection;
  /** SHA-256 of the reviewer-safe task prompt + producer task revision. */
  readonly trainingTaskHash: string;
  readonly objective: {
    readonly process: OutcomeStatus;
    readonly verifier: OutcomeStatus;
    readonly infrastructure: OutcomeStatus;
    readonly evidence: { readonly status: "complete" | "insufficient"; readonly missing: ReadonlyArray<string> };
    readonly rewards: Readonly<Record<string, number>>;
  };
};

type Rec = Record<string, unknown>;
const rec = (value: unknown, at: string): Rec => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${at} must be an object`);
  return value as Rec;
};
const exact = (value: Rec, allowed: ReadonlyArray<string>, at: string): void => {
  const keys = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !keys.has(key));
  if (unknown) throw new Error(`${at} contains unknown field ${unknown}`);
};
const text = (value: unknown, at: string, max = MAX_TEXT): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new Error(`${at} must be a non-empty bounded string`);
  return value;
};
const optionalText = (value: unknown, at: string, max = MAX_TEXT): string | undefined =>
  value === undefined || value === null ? undefined : text(value, at, max);
const bool = (value: unknown, at: string): boolean => {
  if (typeof value !== "boolean") throw new Error(`${at} must be a boolean`);
  return value;
};
const nonnegativeInteger = (value: unknown, at: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${at} must be a non-negative integer`);
  return value as number;
};
const finiteNumber = (value: unknown, at: string, nullable = false): number | undefined => {
  if (nullable && (value === undefined || value === null)) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${at} must be a non-negative finite number`);
  return value;
};
const iso = (value: unknown, at: string): string => {
  const result = text(value, at, 64);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(result) || !Number.isFinite(Date.parse(result))) {
    throw new Error(`${at} must be ISO-8601`);
  }
  return result;
};
const utcIso = (value: unknown, at: string): string => {
  const result = iso(value, at);
  if (!result.endsWith("+00:00")) throw new Error(`${at} must use the producer's canonical UTC ISO-8601 form`);
  return result;
};
const boundedJson = (value: unknown, at: string): unknown => {
  let encoded: string;
  try { encoded = JSON.stringify(value); } catch { throw new Error(`${at} must be JSON-serializable`); }
  if (new TextEncoder().encode(encoded).byteLength > MAX_JSON_FIELD) throw new Error(`${at} is too large`);
  return value;
};

const SECRET_KEY = /(authorization|cookie|credential|password|secret|token|api[_-]?key|private[_-]?key|argv|expected_exit_code)/i;
const HIDDEN_KEY = /(provider|model|harness|source|session|analysis_metadata|artifact.*url|raw.*url|hidden|canary|reviewer)/i;
const SECRET_VALUE = /(bearer\s+[a-z0-9._~+/=-]+|(?:sk|api|key|token|secret|password)[-_][a-z0-9._-]{12,}|HIDDEN_VERIFIER_CANARY_[A-Za-z0-9_-]+)/gi;
const ABSOLUTE_PATH = /(^|[\s"'])(?:[A-Za-z]:\\|\/(?!\/)(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+)/g;
function sanitizeString(value: string): string {
  return value
    .replace(SECRET_VALUE, "[REDACTED]")
    .replace(/authorization\s*[:=]\s*\[REDACTED\]/gi, "[REDACTED]")
    .replace(ABSOLUTE_PATH, "$1[PATH_REDACTED]");
}
function sanitize(value: unknown): unknown {
  if (typeof value === "string") return sanitizeString(value).slice(0, MAX_JSON_FIELD);
  if (Array.isArray(value)) return value.slice(0, 1_000).map(sanitize);
  if (!value || typeof value !== "object") return value;
  const output: Rec = {};
  for (const [key, item] of Object.entries(value as Rec)) {
    if (SECRET_KEY.test(key)) output[key] = "[REDACTED]";
    else if (!HIDDEN_KEY.test(key)) output[key] = sanitize(item);
  }
  return output;
}
function redactKnownProvenance<T>(value: T, hiddenValues: ReadonlyArray<string>): T {
  if (typeof value === "string") {
    let output: string = value;
    for (const hidden of hiddenValues.filter((item) => item.length >= 2)) {
      const escaped = hidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      output = output.replace(new RegExp(`\\b${escaped}\\b`, "gi"), "[PROVENANCE_REDACTED]");
    }
    return output as T;
  }
  if (Array.isArray(value)) return value.map((item) => redactKnownProvenance(item, hiddenValues)) as T;
  if (!value || typeof value !== "object") return value;
  const output: Rec = {};
  for (const [key, item] of Object.entries(value as Rec)) output[key] = redactKnownProvenance(item, hiddenValues);
  return output as T;
}
function safeRelativePath(value: unknown, at: string): string {
  const path = text(value, at, 1_000);
  if (path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/.test(path)) throw new Error(`${at} must be relative`);
  const parts = path.replace(/\\/g, "/").split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error(`${at} must be a safe relative path`);
  return path;
}
function reference(value: unknown, at: string): { readonly path: string; readonly sha256: string } {
  const row = rec(value, at);
  exact(row, ["path", "sha256"], at);
  const sha256 = text(row.sha256, `${at}.sha256`, 64);
  if (!SHA256.test(sha256)) throw new Error(`${at}.sha256 must be lowercase SHA-256`);
  return { path: safeRelativePath(row.path, `${at}.path`), sha256 };
}
function reviewerReference(value: unknown, at: string): {
  readonly path: string;
  readonly sha256: string;
  readonly reviewerSha256: string;
} {
  const row = rec(value, at);
  exact(row, ["path", "sha256", "reviewer_sha256"], at);
  const base = reference({ path: row.path, sha256: row.sha256 }, at);
  const reviewerSha256 = text(row.reviewer_sha256, `${at}.reviewer_sha256`, 64);
  if (!SHA256.test(reviewerSha256)) throw new Error(`${at}.reviewer_sha256 must be lowercase SHA-256`);
  return { ...base, reviewerSha256 };
}
function parseOutcomes(value: unknown, at: string) {
  const row = rec(value, at);
  exact(row, ["process", "verifier", "infrastructure", "evidence_completeness"], at);
  const process = text(row.process, `${at}.process`, 100);
  const verifier = text(row.verifier, `${at}.verifier`, 100);
  const infrastructure = text(row.infrastructure, `${at}.infrastructure`, 100);
  const evidenceCompleteness = text(row.evidence_completeness, `${at}.evidence_completeness`, 100);
  if (!PROCESS_STATUSES.has(process) || !VERIFIER_STATUSES.has(verifier) || !INFRASTRUCTURE_STATUSES.has(infrastructure) || !EVIDENCE_STATUSES.has(evidenceCompleteness)) {
    throw new Error(`${at} contains an unsupported status`);
  }
  return { process, verifier, infrastructure, evidenceCompleteness };
}
function parseRewards(value: unknown, at: string) {
  const row = rec(value, at);
  exact(row, ["reward", "command_exit", "stdout_assertion"], at);
  return {
    reward: finiteNumber(row.reward, `${at}.reward`)!,
    command_exit: finiteNumber(row.command_exit, `${at}.command_exit`)!,
    stdout_assertion: finiteNumber(row.stdout_assertion, `${at}.stdout_assertion`)!,
  };
}
function toolAlias(name: string): string {
  const lower = name.toLowerCase();
  if (/read|cat|view/.test(lower)) return "read_file";
  if (/write|edit|patch/.test(lower)) return "change_file";
  if (/bash|shell|exec|command/.test(lower)) return "run_command";
  if (/test|verify|check/.test(lower)) return "run_check";
  return "tool";
}

export function parseHarborReviewerProjection(raw: unknown): HarborReviewerProjection {
  const row = rec(raw, "reviewer projection");
  exact(row, [
    "taskPrompt", "taskRevision", "timing", "events", "finalOutput", "termination", "outcomes",
    "runQualification", "evidenceCompleteness", "evidenceWarning", "canJudgeTaskSuccess",
    "changedFiles", "patch", "patchTruncated", "verifierEvidence", "integrity",
  ], "reviewer projection");
  text(row.taskPrompt, "reviewer projection.taskPrompt");
  optionalText(row.taskRevision, "reviewer projection.taskRevision", 200);
  text(row.finalOutput, "reviewer projection.finalOutput");
  const timing = rec(row.timing, "reviewer projection.timing");
  exact(timing, ["startedAt", "completedAt", "durationMs"], "reviewer projection.timing");
  iso(timing.startedAt, "reviewer projection.timing.startedAt");
  iso(timing.completedAt, "reviewer projection.timing.completedAt");
  nonnegativeInteger(timing.durationMs, "reviewer projection.timing.durationMs");
  if (!Array.isArray(row.events) || row.events.length === 0 || row.events.length > MAX_EVENTS) throw new Error("reviewer projection events are invalid");
  row.events.forEach((item, index) => {
    const event = rec(item, `reviewer projection.events[${index}]`);
    exact(event, ["sequence", "kind", "timestamp", "role", "content", "callId", "toolName", "status", "arguments", "result", "error", "reason"], `reviewer projection.events[${index}]`);
    if (nonnegativeInteger(event.sequence, `reviewer projection.events[${index}].sequence`) !== index) throw new Error("reviewer projection event sequence is invalid");
    const kind = text(event.kind, `reviewer projection.events[${index}].kind`, 40);
    if (!EVENT_KINDS.has(kind)) throw new Error("reviewer projection event kind is invalid");
    if (event.timestamp !== undefined) utcIso(event.timestamp, `reviewer projection.events[${index}].timestamp`);
    for (const key of ["role", "content", "callId", "toolName", "status", "error", "reason"] as const) {
      if (event[key] !== undefined) text(event[key], `reviewer projection.events[${index}].${key}`);
    }
    if (event.callId !== undefined && !/^operation-\d+$/.test(String(event.callId))) throw new Error("reviewer projection call id is invalid");
    if (event.arguments !== undefined) boundedJson(event.arguments, `reviewer projection.events[${index}].arguments`);
    if (event.result !== undefined) boundedJson(event.result, `reviewer projection.events[${index}].result`);
  });
  const termination = rec(row.termination, "reviewer projection.termination");
  exact(termination, ["status", "reason"], "reviewer projection.termination");
  if (!["quality_eligible", "fixture_complete", "insufficient"].includes(text(termination.status, "reviewer projection.termination.status", 30))) throw new Error("reviewer projection termination status is invalid");
  text(termination.reason, "reviewer projection.termination.reason", 200);
  const outcomes = rec(row.outcomes, "reviewer projection.outcomes");
  exact(outcomes, ["process", "verifier", "infrastructure"], "reviewer projection.outcomes");
  for (const key of ["process", "verifier", "infrastructure"] as const) {
    const outcome = rec(outcomes[key], `reviewer projection.outcomes.${key}`);
    exact(outcome, ["status", "summary"], `reviewer projection.outcomes.${key}`);
    text(outcome.status, `reviewer projection.outcomes.${key}.status`, 100);
    optionalText(outcome.summary, `reviewer projection.outcomes.${key}.summary`, 2_000);
  }
  if (!["quality_eligible", "fixture_only", "insufficient"].includes(String(row.runQualification))) throw new Error("reviewer projection qualification is invalid");
  if (row.evidenceCompleteness !== "complete" && row.evidenceCompleteness !== "insufficient") throw new Error("reviewer projection evidence status is invalid");
  if (typeof row.canJudgeTaskSuccess !== "boolean") throw new Error("reviewer projection verdict gate is invalid");
  if (row.canJudgeTaskSuccess !== (row.runQualification === "quality_eligible")) throw new Error("reviewer projection verdict gate contradicts qualification");
  optionalText(row.evidenceWarning, "reviewer projection.evidenceWarning", 2_000);
  if (!Array.isArray(row.changedFiles) || row.changedFiles.length > MAX_CHANGED_FILES) throw new Error("reviewer projection files are invalid");
  row.changedFiles.forEach((item, index) => {
    const file = rec(item, `reviewer projection.changedFiles[${index}]`);
    exact(file, ["path", "status"], `reviewer projection.changedFiles[${index}]`);
    safeRelativePath(file.path, `reviewer projection.changedFiles[${index}].path`);
    optionalText(file.status, `reviewer projection.changedFiles[${index}].status`, 50);
  });
  optionalText(row.patch, "reviewer projection.patch", MAX_PATCH);
  bool(row.patchTruncated, "reviewer projection.patchTruncated");
  if (row.verifierEvidence !== undefined) {
    const verifier = rec(row.verifierEvidence, "reviewer projection.verifierEvidence");
    exact(verifier, ["commandSummary", "exitCode", "timedOut", "stdout", "stderr", "stdoutTruncated", "stderrTruncated"], "reviewer projection.verifierEvidence");
    text(verifier.commandSummary, "reviewer projection.verifierEvidence.commandSummary", 2_000);
    if (verifier.exitCode !== null) nonnegativeInteger(verifier.exitCode, "reviewer projection.verifierEvidence.exitCode");
    bool(verifier.timedOut, "reviewer projection.verifierEvidence.timedOut");
    optionalText(verifier.stdout, "reviewer projection.verifierEvidence.stdout", MAX_STREAM);
    optionalText(verifier.stderr, "reviewer projection.verifierEvidence.stderr", MAX_STREAM);
    bool(verifier.stdoutTruncated, "reviewer projection.verifierEvidence.stdoutTruncated");
    bool(verifier.stderrTruncated, "reviewer projection.verifierEvidence.stderrTruncated");
  }
  const integrity = rec(row.integrity, "reviewer projection.integrity");
  exact(integrity, ["status", "checksums"], "reviewer projection.integrity");
  if (integrity.status !== "verified_references" && integrity.status !== "incomplete") throw new Error("reviewer projection integrity status is invalid");
  if (!Array.isArray(integrity.checksums) || integrity.checksums.some((item) => typeof item !== "string" || !SHA256.test(item))) throw new Error("reviewer projection integrity checksums are invalid");
  const projection = row as HarborReviewerProjection;
  assertReviewerProjectionSafe(projection, []);
  return projection;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const object = value as Rec;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(",")}}`;
}
async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Derive the canonical training task hash from reviewer-safe task identity. */
export async function deriveTrainingTaskHash(taskPrompt: string, taskRevision: string): Promise<string> {
  return await sha256Text(stableStringify({ prompt: taskPrompt, revision: taskRevision }));
}
function collectPrivateStrings(value: unknown): string[] {
  if (typeof value === "string") return value.length >= 2 ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(collectPrivateStrings);
  if (!value || typeof value !== "object") return [];
  return Object.values(value as Rec).flatMap(collectPrivateStrings);
}
function assertReviewerProjectionSafe(projection: HarborReviewerProjection, privateValues: ReadonlyArray<string>): void {
  const serialized = JSON.stringify(projection);
  if (/HIDDEN_VERIFIER_CANARY_|bearer\s+|authorization\s*[:=]|(?:API_KEY|TOKEN|SECRET|PASSWORD)\s*=/i.test(serialized)) {
    throw new Error("reviewer projection contains forbidden secret or canary material");
  }
  if (ABSOLUTE_PATH.test(serialized)) throw new Error("reviewer projection contains an absolute path");
  ABSOLUTE_PATH.lastIndex = 0;
  for (const value of privateValues.filter((item) => item.length >= 2)) {
    if (serialized.toLowerCase().includes(value.toLowerCase())) throw new Error("reviewer projection contains private provenance");
  }
}

export async function parseHarborEvidenceV1(raw: unknown): Promise<ParsedHarborEvidence> {
  const root = rec(raw, "run artifact");
  exact(root, ["schema", "version", "run", "harness", "raw", "usage", "outcomes", "rewards", "analysis_metadata", "reviewer"], "run artifact");
  if (root.schema !== "mogil.harbor-evidence") throw new Error('schema must be "mogil.harbor-evidence"');
  if (root.version !== "1.0") throw new Error('version must be "1.0"');

  const run = rec(root.run, "run");
  exact(run, ["id", "attempt", "started_at", "ended_at", "status", "termination_reason"], "run");
  const stableId = text(run.id, "run.id", 200);
  const attempt = text(run.attempt, "run.attempt", 200);
  const startedAt = iso(run.started_at, "run.started_at");
  const endedAt = iso(run.ended_at, "run.ended_at");
  if (Date.parse(endedAt) < Date.parse(startedAt)) throw new Error("run.ended_at precedes run.started_at");
  const runStatus = text(run.status, "run.status", 30);
  if (!RUN_STATUSES.has(runStatus)) throw new Error("run.status is unsupported");
  const terminationReason = text(run.termination_reason, "run.termination_reason", 200);

  const harness = rec(root.harness, "harness");
  for (const [key, item] of Object.entries(harness)) {
    text(key, "harness key", 100);
    text(item, `harness.${key}`, 200);
  }
  if (Object.keys(harness).length === 0) throw new Error("harness must not be empty");
  const rawReference = reference(root.raw, "raw");
  boundedJson(root.analysis_metadata, "analysis_metadata");
  const analysis = rec(root.analysis_metadata, "analysis_metadata");

  const usage = rec(root.usage, "usage");
  exact(usage, ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "total_tokens", "cost_usd"], "usage");
  const parsedUsage = {
    inputTokens: finiteNumber(usage.input_tokens, "usage.input_tokens", true),
    outputTokens: finiteNumber(usage.output_tokens, "usage.output_tokens", true),
    cacheReadTokens: finiteNumber(usage.cache_read_tokens, "usage.cache_read_tokens", true),
    cacheWriteTokens: finiteNumber(usage.cache_write_tokens, "usage.cache_write_tokens", true),
    totalTokens: finiteNumber(usage.total_tokens, "usage.total_tokens", true),
    costUsd: finiteNumber(usage.cost_usd, "usage.cost_usd", true),
  };
  for (const [key, item] of Object.entries(parsedUsage)) {
    if (item !== undefined && key !== "costUsd" && !Number.isSafeInteger(item)) throw new Error(`usage.${key} must be an integer`);
  }
  const topOutcomes = parseOutcomes(root.outcomes, "outcomes");
  const topRewards = parseRewards(root.rewards, "rewards");

  const reviewer = rec(root.reviewer, "reviewer");
  exact(reviewer, ["task", "environment_class", "harness_schema", "events", "outcomes", "rewards", "evidence"], "reviewer");
  const environmentClass = text(reviewer.environment_class, "reviewer.environment_class", 32);
  if (!REVIEWER_ENVIRONMENT_CLASSES.has(environmentClass)) {
    throw new Error('reviewer.environment_class must be "docker" or "isolated-sandbox"');
  }
  if (reviewer.harness_schema !== "harbor/pi-jsonl@0.18.0") throw new Error("reviewer.harness_schema is unsupported");
  const task = rec(reviewer.task, "reviewer.task");
  exact(task, ["id", "revision", "privacy_class", "prompt"], "reviewer.task");
  text(task.id, "reviewer.task.id", 200);
  const taskRevision = sanitizeString(text(task.revision, "reviewer.task.revision", 200));
  const privacy = text(task.privacy_class, "reviewer.task.privacy_class", 30);
  if (!PRIVACY.has(privacy)) throw new Error("reviewer.task.privacy_class is unsupported");
  const taskPrompt = sanitizeString(text(task.prompt, "reviewer.task.prompt"));
  const reviewerOutcomes = parseOutcomes(reviewer.outcomes, "reviewer.outcomes");
  const reviewerRewards = parseRewards(reviewer.rewards, "reviewer.rewards");

  const hiddenProvenance = [
    ...Object.values(harness).filter((item): item is string => typeof item === "string"),
    environmentClass,
    reviewer.harness_schema,
    rawReference.path,
    ...collectPrivateStrings(analysis),
  ] as string[];

  if (!Array.isArray(reviewer.events) || reviewer.events.length === 0 || reviewer.events.length > MAX_EVENTS) throw new Error(`reviewer.events must contain 1 to ${MAX_EVENTS} events`);
  const eventIds = new Set<string>();
  const openCalls = new Map<string, number>();
  const resolvedCalls = new Set<string>();
  const projectionEvents: HarborReviewerEvent[] = [];
  const traceSteps: AgentTraceStep[] = [];
  let finalOutput = "";
  let terminationSeen = false;
  let previousTimestamp = Number.NEGATIVE_INFINITY;

  for (let index = 0; index < reviewer.events.length; index++) {
    const event = rec(reviewer.events[index], `reviewer.events[${index}]`);
    exact(event, [
      "id", "sequence", "kind", "timestamp", "content", "call_id", "tool_name",
      "arguments", "result", "stop_reason",
    ], `reviewer.events[${index}]`);
    const id = text(event.id, `reviewer.events[${index}].id`, 36);
    if (!EVENT_ID.test(id) || eventIds.has(id)) throw new Error(`reviewer.events[${index}].id is invalid or duplicated`);
    eventIds.add(id);
    const sequence = nonnegativeInteger(event.sequence, `reviewer.events[${index}].sequence`);
    if (sequence !== index) throw new Error("reviewer event sequence must be contiguous and ordered");
    const kind = text(event.kind, `reviewer.events[${index}].kind`, 40);
    if (!EVENT_KINDS.has(kind)) throw new Error(`reviewer.events[${index}].kind is unsupported`);
    const timestamp = event.timestamp === undefined || event.timestamp === null
      ? undefined
      : utcIso(event.timestamp, `reviewer.events[${index}].timestamp`);
    if (timestamp !== undefined) {
      const millis = Date.parse(timestamp);
      if (millis < previousTimestamp) throw new Error("reviewer event timestamps must be chronological");
      previousTimestamp = millis;
    }
    const content = optionalText(event.content, `reviewer.events[${index}].content`);
    const stopReason = optionalText(
      event.stop_reason,
      `reviewer.events[${index}].stop_reason`,
      100,
    );
    const callId = optionalText(event.call_id, `reviewer.events[${index}].call_id`, 200);
    const toolName = optionalText(event.tool_name, `reviewer.events[${index}].tool_name`, 200);
    const hasArguments = event.arguments !== undefined && event.arguments !== null;
    const hasResult = event.result !== undefined && event.result !== null;
    if (terminationSeen) throw new Error("termination must be the final event");

    if (["user_message", "assistant_message", "assistant_reasoning", "final_output", "termination"].includes(kind)) {
      const assistantEmission = [
        "assistant_message",
        "assistant_reasoning",
        "final_output",
      ].includes(kind);
      if (
        !content ||
        callId ||
        toolName ||
        hasArguments ||
        hasResult ||
        (stopReason !== undefined && !assistantEmission)
      ) {
        throw new Error(`reviewer.events[${index}] fields do not match ${kind}; stop_reason is assistant-only`);
      }
      const safeContent = sanitizeString(content);
      if (kind === "final_output") {
        if (finalOutput) throw new Error("reviewer events must contain exactly one final output");
        finalOutput = safeContent;
        projectionEvents.push({ sequence, kind, timestamp, content: safeContent });
      } else if (kind === "termination") {
        if (safeContent !== sanitizeString(terminationReason)) throw new Error("termination content must match run.termination_reason");
        terminationSeen = true;
        projectionEvents.push({ sequence, kind, timestamp, reason: safeContent });
      } else {
        const role = kind === "user_message" ? "user" : kind === "assistant_reasoning" ? "thinking" : "assistant";
        traceSteps.push({ type: "message", index: traceSteps.length, timestamp, message: { role, content: safeContent } });
        projectionEvents.push({ sequence, kind, timestamp, role, content: safeContent });
      }
    } else if (kind === "tool_call") {
      if (!callId || !toolName || !hasArguments || content || stopReason || hasResult || typeof event.arguments !== "object" || Array.isArray(event.arguments)) throw new Error(`reviewer.events[${index}] fields do not match tool_call`);
      if (openCalls.has(callId) || resolvedCalls.has(callId)) throw new Error("tool call id is duplicated");
      const ordinal = openCalls.size + resolvedCalls.size + 1;
      openCalls.set(callId, ordinal);
      const safeArgs = sanitize(boundedJson(event.arguments, `reviewer.events[${index}].arguments`));
      traceSteps.push({ type: "tool_call", index: traceSteps.length, timestamp, tool_call_id: callId, name: toolName, args: safeArgs as Rec, redacted_args: safeArgs as Rec, privacy_class: privacy as PrivacyClass });
      projectionEvents.push({ sequence, kind, timestamp, callId: `operation-${ordinal}`, toolName: toolAlias(toolName), arguments: safeArgs });
    } else {
      if (!callId || !toolName || content || stopReason || hasArguments) throw new Error(`reviewer.events[${index}] fields do not match ${kind}`);
      const ordinal = openCalls.get(callId);
      if (ordinal === undefined) throw new Error("tool result/error has no preceding unresolved call");
      openCalls.delete(callId);
      resolvedCalls.add(callId);
      const safeResult = sanitize(boundedJson(event.result ?? null, `reviewer.events[${index}].result`));
      const status = kind === "tool_error" ? "error" : "success";
      traceSteps.push({ type: "tool_result", index: traceSteps.length, timestamp, tool_call_id: callId, name: toolName, result: { status, value: safeResult }, redacted_result: { status, value: safeResult }, privacy_class: privacy as PrivacyClass });
      projectionEvents.push({ sequence, kind, timestamp, callId: `operation-${ordinal}`, toolName: toolAlias(toolName), status, ...(kind === "tool_error" ? { error: typeof safeResult === "string" ? safeResult : JSON.stringify(safeResult) } : { result: safeResult }) });
    }
  }
  if (openCalls.size || !terminationSeen || !finalOutput) throw new Error("reviewer events are incomplete or unlinked");

  const evidence = rec(reviewer.evidence, "reviewer.evidence");
  exact(evidence, [
    "changed_files", "changed_files_reference", "patch", "patch_truncated", "patch_reference",
    "verifier_command_summary", "verifier_exit_code", "verifier_timed_out", "verifier_stdout",
    "verifier_stderr", "verifier_stdout_truncated", "verifier_stderr_truncated", "verifier_references",
  ], "reviewer.evidence");
  if (!Array.isArray(evidence.changed_files) || evidence.changed_files.length > MAX_CHANGED_FILES) throw new Error("reviewer.evidence.changed_files is invalid");
  const changedFilesSource = evidence.changed_files.map((item, index) => {
    const file = rec(item, `reviewer.evidence.changed_files[${index}]`);
    const path = safeRelativePath(file.path, `reviewer.evidence.changed_files[${index}].path`);
    const status = text(file.status, `reviewer.evidence.changed_files[${index}].status`, 50);
    return { path, status };
  });
  const changedFiles = changedFilesSource.map((file) => ({ ...file, path: sanitizeString(file.path) }));
  const changedReference = reviewerReference(evidence.changed_files_reference, "reviewer.evidence.changed_files_reference");
  if (typeof evidence.patch !== "string" || new TextEncoder().encode(evidence.patch).byteLength > MAX_PATCH) throw new Error("reviewer.evidence.patch is invalid");
  const rawPatch = evidence.patch;
  const patch = rawPatch === "" ? undefined : rawPatch;
  const patchTruncated = bool(evidence.patch_truncated, "reviewer.evidence.patch_truncated");
  const patchReference = reviewerReference(evidence.patch_reference, "reviewer.evidence.patch_reference");
  const commandSummary = sanitizeString(text(evidence.verifier_command_summary, "reviewer.evidence.verifier_command_summary", 2_000));
  const verifierExitCode = evidence.verifier_exit_code === null ? null : nonnegativeInteger(evidence.verifier_exit_code, "reviewer.evidence.verifier_exit_code");
  const verifierTimedOut = bool(evidence.verifier_timed_out, "reviewer.evidence.verifier_timed_out");
  if (typeof evidence.verifier_stdout !== "string" || new TextEncoder().encode(evidence.verifier_stdout).byteLength > MAX_STREAM) throw new Error("reviewer.evidence.verifier_stdout is invalid");
  if (typeof evidence.verifier_stderr !== "string" || new TextEncoder().encode(evidence.verifier_stderr).byteLength > MAX_STREAM) throw new Error("reviewer.evidence.verifier_stderr is invalid");
  const rawStdout = evidence.verifier_stdout;
  const rawStderr = evidence.verifier_stderr;
  const stdout = rawStdout === "" ? undefined : sanitizeString(rawStdout);
  const stderr = rawStderr === "" ? undefined : sanitizeString(rawStderr);
  const stdoutTruncated = bool(evidence.verifier_stdout_truncated, "reviewer.evidence.verifier_stdout_truncated");
  const stderrTruncated = bool(evidence.verifier_stderr_truncated, "reviewer.evidence.verifier_stderr_truncated");
  if (!Array.isArray(evidence.verifier_references) || evidence.verifier_references.length === 0 || evidence.verifier_references.length > 20) throw new Error("reviewer.evidence.verifier_references is invalid");
  const verifierReferences = evidence.verifier_references.map((item, index) => reviewerReference(item, `reviewer.evidence.verifier_references[${index}]`));
  const verifierReferenceByPath = new Map(verifierReferences.map((item) => [item.path, item.sha256]));
  const requiredVerifierReferences = ["verifier/stdout.txt", "verifier/stderr.txt"];
  const referencePathsValid =
    rawReference.path === "agent/pi.txt" &&
    changedReference.path === "workspace/changed-files.json" &&
    patchReference.path === "workspace/patch.diff" &&
    requiredVerifierReferences.every((path) => verifierReferenceByPath.has(path));
  const changedFilesHashBound = await sha256Text(stableStringify(changedFilesSource)) === changedReference.reviewerSha256;
  const patchHashBound = await sha256Text(rawPatch) === patchReference.reviewerSha256;
  const stdoutReference = verifierReferences.find((item) => item.path === "verifier/stdout.txt");
  const stderrReference = verifierReferences.find((item) => item.path === "verifier/stderr.txt");
  const stdoutHashBound = stdoutReference !== undefined && await sha256Text(rawStdout) === stdoutReference.reviewerSha256;
  const stderrHashBound = stderrReference !== undefined && await sha256Text(rawStderr) === stderrReference.reviewerSha256;

  if (!changedFilesHashBound || !patchHashBound || !stdoutHashBound || !stderrHashBound) throw new Error("reviewer inline evidence hash mismatch");
  if (JSON.stringify(topOutcomes) !== JSON.stringify(reviewerOutcomes)) throw new Error("top-level and reviewer outcomes must match");
  if (JSON.stringify(topRewards) !== JSON.stringify(reviewerRewards)) throw new Error("top-level and reviewer rewards must match");
  if (topOutcomes.verifier === "passed" && (verifierExitCode !== 0 || verifierTimedOut)) throw new Error("passed verifier outcome contradicts verifier execution evidence");
  const outcomeComplete =
    topOutcomes.process === REQUIRED_OUTCOMES.process &&
    topOutcomes.verifier === REQUIRED_OUTCOMES.verifier &&
    topOutcomes.infrastructure === REQUIRED_OUTCOMES.infrastructure &&
    topOutcomes.evidenceCompleteness === REQUIRED_OUTCOMES.evidenceCompleteness;
  const rewardsComplete = topRewards.reward === 1 && topRewards.command_exit === 1 && topRewards.stdout_assertion === 1;
  if (outcomeComplete && !rewardsComplete) throw new Error("successful outcomes contradict reward dimensions");
  const toolCalls = traceSteps.filter((step) => step.type === "tool_call");
  const meaningfulToolActivity =
    toolCalls.length > 0 &&
    traceSteps.some((step) => step.type === "tool_result") &&
    toolCalls.some((step) => /edit|write|patch|bash|shell|command/i.test(step.name));
  const evidenceComplete =
    meaningfulToolActivity && changedFiles.length > 0 && patch !== undefined &&
    verifierExitCode === 0 && !verifierTimedOut && (rawStdout.length > 0 || rawStderr.length > 0) &&
    referencePathsValid && changedFilesHashBound && patchHashBound && stdoutHashBound && stderrHashBound;
  const objectiveComplete = outcomeComplete && rewardsComplete && evidenceComplete && terminationReason === "completed";
  if ((runStatus === "quality_eligible" || runStatus === "fixture_complete") && !objectiveComplete) {
    throw new Error(`${runStatus} contradicts objective, trajectory, verifier, or integrity evidence`);
  }
  const eligible = runStatus === "quality_eligible" && objectiveComplete;
  const fixtureOnly = runStatus === "fixture_complete";
  const evidenceCompleteness: "complete" | "insufficient" = objectiveComplete ? "complete" : "insufficient";
  const missing = [
    ...(!outcomeComplete ? ["objective_outcomes"] : []),
    ...(!rewardsComplete ? ["reward_dimensions"] : []),
    ...(!meaningfulToolActivity ? ["meaningful_tool_activity"] : []),
    ...(!evidenceComplete ? ["reviewer_evidence_or_integrity"] : []),
    ...(terminationReason !== "completed" ? ["successful_termination"] : []),
  ];
  const evidenceWarning = fixtureOnly
    ? "Fixture-only evidence is inspectable, but it is not eligible for a real task-success verdict. Qualitative feedback remains available."
    : !eligible
      ? `Evidence is not quality eligible${missing.length ? ` (${missing.join(", ")})` : ""}. Qualitative feedback is allowed, but this run cannot receive a task-success verdict.`
      : undefined;

  const projection: HarborReviewerProjection = {
    taskPrompt,
    taskRevision,
    timing: { startedAt, completedAt: endedAt, durationMs: Date.parse(endedAt) - Date.parse(startedAt) },
    events: projectionEvents,
    finalOutput,
    termination: { status: runStatus, reason: terminationReason },
    outcomes: {
      process: { status: topOutcomes.process },
      verifier: { status: topOutcomes.verifier },
      infrastructure: { status: topOutcomes.infrastructure },
    },
    runQualification: eligible ? "quality_eligible" : fixtureOnly ? "fixture_only" : "insufficient",
    evidenceCompleteness,
    ...(evidenceWarning ? { evidenceWarning } : {}),
    canJudgeTaskSuccess: eligible,
    changedFiles,
    ...(patch ? { patch: sanitizeString(patch) } : {}),
    patchTruncated,
    verifierEvidence: {
      commandSummary,
      exitCode: verifierExitCode,
      timedOut: verifierTimedOut,
      ...(stdout ? { stdout } : {}),
      ...(stderr ? { stderr } : {}),
      stdoutTruncated,
      stderrTruncated,
    },
    integrity: {
      status: evidenceComplete ? "verified_references" : "incomplete",
      checksums: [changedReference.reviewerSha256, patchReference.reviewerSha256, ...verifierReferences.map((item) => item.reviewerSha256)],
    },
  };
  const safeProjection = redactKnownProvenance(projection, hiddenProvenance);
  assertReviewerProjectionSafe(safeProjection, hiddenProvenance);
  const trace: AgentRunTrace = {
    trace_id: `full-span:${stableId}`,
    source: "agent_harness",
    harness: {
      name: typeof harness.name === "string" ? harness.name : "harbor/pi",
      version: typeof harness.schema === "string" ? harness.schema : undefined,
      sdk: "mogil.harbor-evidence",
    },
    product: "coding-task",
    module: "full-span",
    environment: "docker",
    run_id: stableId,
    source_ids: { attempt },
    messages: [],
    steps: redactKnownProvenance(traceSteps, hiddenProvenance),
    final_answer: redactKnownProvenance(finalOutput, hiddenProvenance),
    usage: { cost_usd: parsedUsage.costUsd, duration_ms: Date.parse(endedAt) - Date.parse(startedAt), total_tokens: parsedUsage.totalTokens },
    privacy: { class: privacy as PrivacyClass, redaction_notes: ["producer reviewer projection re-sanitized at ingest"] },
    metadata: {},
  };
  return {
    run: { stableId, attempt, status: runStatus as ParsedHarborEvidence["run"]["status"] },
    trace,
    projection: safeProjection,
    trainingTaskHash: await deriveTrainingTaskHash(safeProjection.taskPrompt, taskRevision),
    objective: {
      process: { status: topOutcomes.process },
      verifier: { status: topOutcomes.verifier },
      infrastructure: { status: topOutcomes.infrastructure },
      evidence: { status: evidenceCompleteness, missing },
      rewards: topRewards,
    },
  };
}
