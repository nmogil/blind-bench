/**
 * Pi session JSONL → normalized trajectory parser.
 *
 * Pi v3 sessions are trees, not flat transcripts. The active session is the
 * path from the last tree entry back to `parentId: null`; abandoned branches
 * are deliberately excluded so one uploaded file becomes one coherent run.
 */
import type {
  AgentRunTrace,
  AgentTraceStep,
  PrivacyClass,
} from "./agentTrace";
import { redactValue } from "./agentTrace";

/** Management-safe import summary; never contains message or tool content. */
export interface PiSessionSummary {
  readonly entries: number;
  readonly activeEntries: number;
  readonly branchesExcluded: number;
  readonly steps: number;
  readonly invalid: number;
  readonly truncated: boolean;
  readonly invalidLines: ReadonlyArray<number>;
  readonly compactions: number;
  readonly models: ReadonlyArray<string>;
  readonly earliest?: string;
  readonly latest?: string;
}

/** Parsed Pi session plus the normalized trajectory ready for persistence. */
export interface PiSessionParseResult {
  readonly sessionId: string;
  readonly trace: AgentRunTrace;
  readonly summary: PiSessionSummary;
}

type JsonRecord = Record<string, unknown>;

type PartialStep = AgentTraceStep extends infer Step
  ? Step extends AgentTraceStep
    ? Omit<Step, "index">
    : never
  : never;

type ParsedEntry = {
  readonly id: string;
  readonly parentId: string | null;
  readonly type: string;
  readonly timestamp?: string;
  readonly raw: JsonRecord;
};

const asRecord = (value: unknown): JsonRecord | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const asFiniteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const privacyClassOf = (value: unknown): PrivacyClass =>
  JSON.stringify(value ?? null).includes("[REDACTED]") ? "pii" : "internal";

const contentText = (content: unknown): string | undefined => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const item of content) {
    const block = asRecord(item);
    if (block?.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
};

const toTimestamp = (entry: ParsedEntry, message: JsonRecord | undefined): string | undefined => {
  if (entry.timestamp !== undefined) return entry.timestamp;
  const timestampMs = asFiniteNumber(message?.timestamp);
  return timestampMs === undefined ? undefined : new Date(timestampMs).toISOString();
};

/**
 * Parse one saved Pi v3 session JSONL file into a single active-path trace.
 * Malformed unrelated lines are counted, while a malformed active tree is
 * rejected because silently splicing branches would corrupt review evidence.
 */
export function parsePiSession(
  jsonl: string,
  options: { readonly maxLines?: number } = {},
): PiSessionParseResult {
  const maxLines = options.maxLines ?? 50_000;
  const lines = jsonl.split("\n");
  const invalidLines: number[] = [];
  const entries: ParsedEntry[] = [];
  const entriesById = new Map<string, ParsedEntry>();
  let header: JsonRecord | undefined;

  for (let index = 0; index < lines.length && index < maxLines; index++) {
    const line = lines[index]?.trim();
    if (!line) continue;
    let rawValue: unknown;
    try {
      rawValue = JSON.parse(line);
    } catch {
      invalidLines.push(index + 1);
      continue;
    }
    const raw = asRecord(rawValue);
    if (!raw) {
      invalidLines.push(index + 1);
      continue;
    }
    if (raw.type === "session") {
      header ??= raw;
      continue;
    }
    const id = asString(raw.id);
    const type = asString(raw.type);
    const parentValue = raw.parentId;
    let parentId: string | null;
    if (parentValue === null) {
      parentId = null;
    } else {
      const parsedParentId = asString(parentValue);
      if (parsedParentId === undefined) {
        invalidLines.push(index + 1);
        continue;
      }
      parentId = parsedParentId;
    }
    if (!id || !type) {
      invalidLines.push(index + 1);
      continue;
    }
    if (entriesById.has(id)) {
      invalidLines.push(index + 1);
      continue;
    }
    const entry: ParsedEntry = {
      id,
      parentId,
      type,
      timestamp: asString(raw.timestamp),
      raw,
    };
    entries.push(entry);
    entriesById.set(id, entry);
  }

  const sessionId = asString(header?.id);
  if (!header || !sessionId) {
    throw new Error("Pi session is missing a valid session header and id.");
  }
  const leaf = entries[entries.length - 1];
  if (!leaf) {
    throw new Error("Pi session contains no tree entries.");
  }

  const reversePath: ParsedEntry[] = [];
  const visited = new Set<string>();
  let cursor: ParsedEntry | undefined = leaf;
  while (cursor) {
    if (visited.has(cursor.id)) {
      throw new Error("Pi session active path contains a parent cycle.");
    }
    visited.add(cursor.id);
    reversePath.push(cursor);
    if (cursor.parentId === null) break;
    const parent = entriesById.get(cursor.parentId);
    if (!parent) {
      throw new Error(`Pi session active path has missing parent for entry ${cursor.id}.`);
    }
    cursor = parent;
  }
  const activeEntries = reversePath.reverse();

  const steps: AgentTraceStep[] = [];
  const models = new Set<string>();
  let currentModel: string | undefined;
  let totalTokens = 0;
  let costUsd = 0;
  let compactions = 0;
  let earliest: string | undefined;
  let latest: string | undefined;
  let finalAnswer: string | undefined;

  const append = (step: PartialStep): void => {
    steps.push({ ...step, index: steps.length } as AgentTraceStep);
  };

  for (const entry of activeEntries) {
    if (entry.timestamp !== undefined) {
      if (earliest === undefined || entry.timestamp < earliest) earliest = entry.timestamp;
      if (latest === undefined || entry.timestamp > latest) latest = entry.timestamp;
    }

    if (entry.type === "model_change") {
      const provider = asString(entry.raw.provider);
      const model = asString(entry.raw.modelId);
      if (model !== undefined) {
        models.add(model);
        currentModel = model;
      }
      append({
        type: "state",
        timestamp: entry.timestamp,
        label: "model_change",
        snapshot: { provider, model },
        redacted_snapshot: { changed: true },
        privacy_class: "internal",
      });
      continue;
    }

    if (entry.type === "compaction") {
      compactions++;
      append({
        type: "policy_event",
        timestamp: entry.timestamp,
        policy: "context",
        action: "compact",
        reason: "session_compaction",
      });
      continue;
    }

    if (entry.type === "branch_summary") {
      append({
        type: "policy_event",
        timestamp: entry.timestamp,
        policy: "context",
        action: "branch_summary",
        reason: "tree_navigation",
      });
      continue;
    }

    if (entry.type === "thinking_level_change") {
      append({
        type: "state",
        timestamp: entry.timestamp,
        label: "thinking_level_change",
        snapshot: { thinkingLevel: asString(entry.raw.thinkingLevel) },
        redacted_snapshot: { changed: true },
        privacy_class: "internal",
      });
      continue;
    }

    if (entry.type === "custom_message") {
      const content = contentText(entry.raw.content);
      if (content !== undefined) {
        append({
          type: "message",
          timestamp: entry.timestamp,
          message: { role: "custom", content },
        });
      }
      continue;
    }

    if (entry.type !== "message") continue;
    const message = asRecord(entry.raw.message);
    const role = asString(message?.role);
    const timestamp = toTimestamp(entry, message);
    if (!message || !role) continue;

    if (role === "assistant") {
      const model = asString(message.model);
      if (model !== undefined) {
        models.add(model);
        currentModel = model;
      }
      const usage = asRecord(message.usage);
      totalTokens +=
        asFiniteNumber(usage?.totalTokens) ??
        ((asFiniteNumber(usage?.input) ?? 0) + (asFiniteNumber(usage?.output) ?? 0));
      costUsd += asFiniteNumber(asRecord(usage?.cost)?.total) ?? 0;

      const content = message.content;
      if (Array.isArray(content)) {
        const thinkingParts: string[] = [];
        const textParts: string[] = [];
        const toolCalls: Array<{
          readonly timestamp?: string;
          readonly toolCallId: string;
          readonly name: string;
          readonly args: JsonRecord;
          readonly redactedArgs: JsonRecord;
          readonly privacyClass: PrivacyClass;
        }> = [];
        for (const rawBlock of content) {
          const block = asRecord(rawBlock);
          const blockType = asString(block?.type);
          if (blockType === "thinking" && typeof block?.thinking === "string") {
            thinkingParts.push(block.thinking);
          } else if (blockType === "text" && typeof block?.text === "string") {
            textParts.push(block.text);
          } else if (blockType === "toolCall") {
            const args = asRecord(block?.arguments) ?? {};
            const redacted = (redactValue(args, "blind_view") as JsonRecord | undefined) ?? {};
            toolCalls.push({
              timestamp,
              toolCallId: asString(block?.id) ?? `tool-${steps.length}`,
              name: asString(block?.name) ?? "unknown_tool",
              args,
              redactedArgs: redacted,
              privacyClass: privacyClassOf(redacted),
            });
          }
        }
        if (thinkingParts.length > 0) {
          append({
            type: "message",
            timestamp,
            message: { role: "thinking", content: thinkingParts.join("\n") },
          });
        }
        if (textParts.length > 0) {
          const text = textParts.join("\n");
          append({ type: "message", timestamp, message: { role, content: text } });
          finalAnswer = text;
        }
        for (const toolCall of toolCalls) {
          append({
            type: "tool_call",
            timestamp: toolCall.timestamp,
            tool_call_id: toolCall.toolCallId,
            name: toolCall.name,
            args: toolCall.args,
            redacted_args: toolCall.redactedArgs,
            privacy_class: toolCall.privacyClass,
          });
        }
      }
      if (message.stopReason === "error" && typeof message.errorMessage === "string") {
        const snapshot = { errorMessage: message.errorMessage };
        append({
          type: "state",
          timestamp,
          label: "assistant_error",
          snapshot,
          redacted_snapshot: redactValue(snapshot, "blind_view") as JsonRecord,
          privacy_class: privacyClassOf(redactValue(snapshot, "blind_view")),
        });
      }
      continue;
    }

    if (role === "toolResult") {
      const result = message.content;
      const redacted = redactValue(result, "blind_view");
      append({
        type: "tool_result",
        timestamp,
        tool_call_id: asString(message.toolCallId) ?? `tool-${steps.length}`,
        name: asString(message.toolName),
        result,
        redacted_result: redacted,
        privacy_class: privacyClassOf(redacted),
      });
      continue;
    }

    if (role === "bashExecution") {
      const callId = `bash-${entry.id}`;
      const command = asString(message.command) ?? "";
      const output = asString(message.output) ?? "";
      append({
        type: "tool_call",
        timestamp,
        tool_call_id: callId,
        name: "bash",
        args: { command },
        redacted_args: redactValue({ command }, "blind_view") as JsonRecord,
        privacy_class: privacyClassOf(redactValue({ command }, "blind_view")),
      });
      append({
        type: "tool_result",
        timestamp,
        tool_call_id: callId,
        name: "bash",
        result: { output, exitCode: message.exitCode, cancelled: message.cancelled },
        redacted_result: redactValue(
          { output, exitCode: message.exitCode, cancelled: message.cancelled },
          "blind_view",
        ),
        privacy_class: privacyClassOf(output),
      });
      continue;
    }

    const text = contentText(message.content);
    if (text !== undefined) {
      append({ type: "message", timestamp, message: { role, content: text } });
    }
  }

  const anyPii = steps.some(
    (step) => "privacy_class" in step && step.privacy_class === "pii",
  );
  const cwd = asString(header.cwd);
  const version = header.version === undefined ? undefined : String(header.version);

  return {
    sessionId,
    trace: {
      trace_id: `pi-${sessionId}`,
      source: "agent_harness",
      harness: { name: "pi", version, sdk: "pi_session_jsonl" },
      product: cwd?.split("/").filter((part) => part.length > 0).pop() ?? "pi",
      module: "pi_session",
      model: currentModel,
      run_id: sessionId,
      source_ids: { sessionId },
      messages: [],
      steps,
      final_answer: finalAnswer,
      usage: {
        total_tokens: totalTokens || undefined,
        cost_usd: costUsd || undefined,
      },
      privacy: {
        class: anyPii ? "pii" : "internal",
        redaction_notes: anyPii
          ? ["sensitive Pi tool and result fields redacted for blind/reviewer views"]
          : [],
      },
      metadata: { sessionId, cwd, version, format: "pi_session_v3" },
    },
    summary: {
      entries: entries.length,
      activeEntries: activeEntries.length,
      branchesExcluded: entries.length - activeEntries.length,
      steps: steps.length,
      invalid: invalidLines.length,
      truncated: lines.length > maxLines,
      invalidLines: invalidLines.slice(0, 100),
      compactions,
      models: [...models],
      earliest,
      latest,
    },
  };
}
