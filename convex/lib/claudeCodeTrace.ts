/**
 * #265 (M31.2): parse a Claude Code session `.jsonl` transcript into the
 * `AgentRunTrace` interchange type, ready to persist through the M31.1 spine.
 *
 * Pure + defensive (no Convex ctx, no zod): every field access tolerates the
 * format drift real transcripts show across CC versions. Malformed lines are
 * skipped and counted, never thrown (matches the Gateway importer).
 *
 * Format facts (reverse-engineered from a 1456-file CC 2.1.x corpus):
 * - One JSON object per line; blank/huge lines occur. `sessionId` is constant
 *   per file and equals the filename stem — the dedup key.
 * - Turn events (`assistant`/`user`/`system`/`attachment`) carry the DAG
 *   (`uuid`/`parentUuid`/`timestamp`) + `message` (Anthropic shape).
 * - STREAMED SPLIT: one logical assistant message is split across multiple
 *   lines sharing `message.id`, each with its own `uuid` and ONE content block;
 *   `usage` is repeated identically on every split line. We merge by
 *   `message.id` and count usage once per id — summing per line over-counts.
 * - Subagents in 2.1.x are async via the `Agent` tool (`agentId`/`outputFile`),
 *   NOT inline `isSidechain` branches (false across the whole corpus). The
 *   `Agent` tool_use becomes an ordinary tool_call step; following `outputFile`
 *   is out of scope (#268 territory).
 * - No `type:"summary"`; compaction surfaces as `isMeta:true` user events.
 *   Family-B metadata records (`ai-title`/`last-prompt`/`pr-link`/
 *   `queue-operation`/`file-history-snapshot`) are dropped.
 */
import type { AgentRunTrace, AgentTraceStep, PrivacyClass } from "./agentTrace";
import { redactValue } from "./agentTrace";

export interface ClaudeCodeSummary {
  events: number;
  steps: number;
  invalid: number;
  invalidLines: number[];
  droppedMeta: number;
  compactions: number;
  mergedMessages: number;
  models: string[];
  earliest?: string;
  latest?: string;
}

export interface ClaudeCodeParseResult {
  sessionId?: string;
  trace: AgentRunTrace;
  summary: ClaudeCodeSummary;
}

const rec = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

const classOf = (redacted: unknown): PrivacyClass =>
  JSON.stringify(redacted ?? null).includes("[REDACTED]") ? "pii" : "internal";

// Family-B sidecar/metadata records that are not part of the trajectory.
const DROP_TYPES = new Set([
  "ai-title",
  "last-prompt",
  "pr-link",
  "queue-operation",
  "file-history-snapshot",
]);

interface CCEvent {
  raw: Record<string, unknown>;
  type: string;
  messageId?: string;
  timestamp?: string;
  isMeta: boolean;
}

export function parseClaudeCodeSession(
  jsonl: string,
  options: { maxLines?: number } = {},
): ClaudeCodeParseResult {
  const maxLines = options.maxLines ?? 50_000;
  const lines = jsonl.split("\n");
  const raw: CCEvent[] = [];
  const invalidLines: number[] = [];
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let version: string | undefined;
  let droppedMeta = 0;
  let compactions = 0;

  for (let i = 0; i < lines.length && raw.length < maxLines; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;
    let obj: Record<string, unknown> | undefined;
    try {
      obj = rec(JSON.parse(line));
    } catch {
      invalidLines.push(i + 1);
      continue;
    }
    if (!obj) {
      invalidLines.push(i + 1);
      continue;
    }
    const type = str(obj.type) ?? "unknown";
    sessionId ??= str(obj.sessionId);
    cwd ??= str(obj.cwd);
    version ??= str(obj.version);
    if (type === "summary") {
      compactions++;
      continue;
    }
    if (DROP_TYPES.has(type)) {
      droppedMeta++;
      continue;
    }
    raw.push({
      raw: obj,
      type,
      messageId: str(rec(obj.message)?.id),
      timestamp: str(obj.timestamp),
      isMeta: obj.isMeta === true,
    });
  }

  // Merge consecutive assistant lines that share message.id into one logical
  // event (concatenated content); usage is taken once from the group.
  const events: CCEvent[] = [];
  let mergedMessages = 0;
  for (const e of raw) {
    const prev = events[events.length - 1];
    if (
      e.type === "assistant" &&
      e.messageId &&
      prev?.type === "assistant" &&
      prev.messageId === e.messageId
    ) {
      const prevContent = rec(prev.raw.message)?.content;
      const curContent = rec(e.raw.message)?.content;
      if (Array.isArray(prevContent) && Array.isArray(curContent)) {
        (prev.raw.message as Record<string, unknown>) = {
          ...(rec(prev.raw.message) ?? {}),
          content: [...prevContent, ...curContent],
        };
        mergedMessages++;
        continue;
      }
    }
    events.push(e);
  }

  const models = new Set<string>();
  let earliest: string | undefined;
  let latest: string | undefined;
  let totalTokens = 0;
  for (const e of events) {
    const message = rec(e.raw.message);
    const model = str(message?.model);
    if (model) models.add(model);
    if (e.timestamp) {
      if (!earliest || e.timestamp < earliest) earliest = e.timestamp;
      if (!latest || e.timestamp > latest) latest = e.timestamp;
    }
    if (e.type === "assistant") {
      const u = rec(message?.usage);
      if (u) {
        totalTokens +=
          (num(u.input_tokens) ?? 0) +
          (num(u.output_tokens) ?? 0) +
          (num(u.cache_creation_input_tokens) ?? 0) +
          (num(u.cache_read_input_tokens) ?? 0);
      }
    }
  }

  const steps: AgentTraceStep[] = [];
  for (const e of events) {
    for (const partial of eventToSteps(e)) {
      steps.push({ ...(partial as AgentTraceStep), index: steps.length });
    }
  }

  const anyRedacted = steps.some((s) => JSON.stringify(s).includes("[REDACTED]"));

  const trace: AgentRunTrace = {
    trace_id: sessionId ? `cc-${sessionId}` : `cc-${fnv(jsonl)}`,
    source: "agent_harness",
    harness: { name: "claude_code", version, sdk: "claude_code_jsonl" },
    product: cwd ? (cwd.split("/").filter(Boolean).pop() ?? "claude_code") : "claude_code",
    module: "claude_code_session",
    model: [...models][0],
    run_id: sessionId,
    source_ids: { sessionId },
    messages: [],
    steps,
    final_answer: lastAssistantText(events),
    usage: { total_tokens: totalTokens || undefined },
    privacy: {
      class: anyRedacted ? "pii" : "internal",
      redaction_notes: anyRedacted
        ? ["sensitive tool/message fields redacted for blind/reviewer views"]
        : [],
    },
    metadata: { sessionId, cwd, version },
  };

  return {
    sessionId,
    trace,
    summary: {
      events: events.length,
      steps: steps.length,
      invalid: invalidLines.length,
      invalidLines: invalidLines.slice(0, 100),
      droppedMeta,
      compactions,
      mergedMessages,
      models: [...models],
      earliest,
      latest,
    },
  };
}

// Distributive Omit — a plain Omit<Union, K> collapses to only the union's
// common keys, dropping policy/label/message/etc.
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type PartialStep = DistributiveOmit<AgentTraceStep, "index">;

/** One (possibly-merged) CC event → ordered normalized steps. */
function eventToSteps(e: CCEvent): PartialStep[] {
  const ts = e.timestamp;
  const message = rec(e.raw.message);
  const content = message?.content;

  if (e.type === "system") {
    return [{ type: "policy_event", timestamp: ts, policy: "system", action: str(e.raw.subtype) ?? "system", reason: str(e.raw.level) }];
  }
  if (e.type === "attachment") {
    const att = rec(e.raw.attachment);
    return [{ type: "policy_event", timestamp: ts, policy: "hook", action: str(att?.hookName) ?? str(att?.type) ?? "attachment", reason: str(att?.hookEvent) }];
  }
  if (e.type === "mode") {
    const snap = { mode: str(e.raw.mode) };
    return [{ type: "state", timestamp: ts, label: "mode", snapshot: snap, redacted_snapshot: snap, privacy_class: "internal" }];
  }
  if (e.type === "permission-mode") {
    const snap = { permissionMode: str(e.raw.permissionMode) };
    return [{ type: "state", timestamp: ts, label: "permission_mode", snapshot: snap, redacted_snapshot: snap, privacy_class: "internal" }];
  }

  // user with a plain string prompt
  if (typeof content === "string") {
    if (e.isMeta) {
      // Injected caveat / compaction summary — annotate, keep out of the stream.
      return [{ type: "policy_event", timestamp: ts, policy: "context", action: "inject", reason: "meta_prompt" }];
    }
    return [{ type: "message", timestamp: ts, message: { role: str(message?.role) ?? "user", content } }];
  }
  if (!Array.isArray(content)) return [];

  // assistant/user content blocks. Coalesce text + thinking; tool_use/tool_result each own a step.
  const out: PartialStep[] = [];
  const thinking: string[] = [];
  const text: string[] = [];
  const role = str(message?.role) ?? "assistant";
  for (const blockRaw of content) {
    const block = rec(blockRaw);
    if (!block) continue;
    const bt = str(block.type);
    if (bt === "text") {
      const t = str(block.text);
      if (t) text.push(t);
    } else if (bt === "thinking") {
      const t = str(block.thinking);
      if (t) thinking.push(t);
    } else if (bt === "tool_use") {
      const args = rec(block.input) ?? {};
      const redacted = redactValue(args, "blind_view") as Record<string, unknown>;
      out.push({
        type: "tool_call",
        timestamp: ts,
        tool_call_id: str(block.id) ?? "tool",
        name: str(block.name) ?? "unknown_tool",
        args,
        redacted_args: redacted,
        privacy_class: classOf(redacted),
      });
    } else if (bt === "tool_result") {
      // Structured toolUseResult (top-level) is richer than the string the
      // model saw; prefer it when present.
      const result = e.raw.toolUseResult ?? block.content;
      const redacted = redactValue(result, "blind_view");
      out.push({
        type: "tool_result",
        timestamp: ts,
        tool_call_id: str(block.tool_use_id) ?? "tool",
        result,
        redacted_result: redacted,
        privacy_class: classOf(redacted),
      });
    }
  }
  const ordered: PartialStep[] = [];
  if (thinking.length) ordered.push({ type: "message", timestamp: ts, message: { role: "thinking", content: thinking.join("\n") } });
  if (text.length) ordered.push({ type: "message", timestamp: ts, message: { role, content: text.join("\n") } });
  return [...ordered, ...out];
}

function lastAssistantText(events: CCEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!e || e.type !== "assistant") continue;
    const content = rec(e.raw.message)?.content;
    if (Array.isArray(content)) {
      const texts = content
        .map(rec)
        .filter((b) => str(b?.type) === "text")
        .map((b) => str(b?.text))
        .filter(Boolean);
      if (texts.length) return texts.join("\n");
    }
  }
  return undefined;
}

// Non-crypto id fallback when a session has no sessionId.
function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
