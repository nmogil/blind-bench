import { describe, expect, test } from "vitest";
import {
  formatClaudeCodePreflightJson,
  formatClaudeCodePreflightText,
  summarizeClaudeCodePreflight,
} from "./claudeCodePreflight";

const SID = "0f0e02b8-1111-2222-3333-444455556666";
const SENSITIVE_SENTINEL = "TOKEN_DO_NOT_PRINT_123456";
const SSN = "123-45-6789";

function fixture(): string {
  return [
    JSON.stringify({
      type: "user",
      uuid: "u1",
      parentUuid: null,
      sessionId: SID,
      timestamp: "2026-07-09T10:00:00Z",
      message: { role: "user", content: "Run a safe preflight." },
    }),
    JSON.stringify({
      type: "assistant",
      uuid: "a1",
      parentUuid: "u1",
      sessionId: SID,
      timestamp: "2026-07-09T10:00:01Z",
      message: {
        id: "m1",
        role: "assistant",
        model: "claude-opus-4-8",
        content: [
          { type: "text", text: "Checking." },
          { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "printenv", api_key: SENSITIVE_SENTINEL, ssn: SSN } },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    }),
    JSON.stringify({
      type: "user",
      uuid: "u2",
      parentUuid: "a1",
      sessionId: SID,
      timestamp: "2026-07-09T10:00:02Z",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: `token=${SENSITIVE_SENTINEL}`, is_error: false }] },
      toolUseResult: { stdout: `token=${SENSITIVE_SENTINEL}`, account: SSN },
    }),
    JSON.stringify({ type: "ai-title", aiTitle: "Safe preflight", sessionId: SID }),
    "{ malformed json",
  ].join("\n");
}

function expectNoLeak(text: string) {
  expect(text).not.toContain(SENSITIVE_SENTINEL);
  expect(text).not.toContain(SSN);
  expect(text).not.toContain("Run a safe preflight.");
  expect(text).not.toContain("token=");
  expect(text).not.toContain("printenv");
}

describe("Claude Code preflight summary", () => {
  test("summarizes parser output without leaking raw transcript content", () => {
    const summary = summarizeClaudeCodePreflight(fixture());
    expect(summary.status).toBe("ready");
    expect(summary.trace_ref).toBe("trace-…55556666");
    expect(summary.session_ref).toBe("session-…55556666");
    expect(summary.invalid).toBe(1);
    expect(summary.invalid_lines).toEqual([5]);
    expect(summary.dropped_meta).toBe(1);
    expect(summary.models).toEqual(["claude-opus-4-8"]);
    expect(summary.step_kind_counts).toMatchObject({ message: 2, tool_call: 1, tool_result: 1 });
    expect(summary.redaction_detected).toBe(true);

    expectNoLeak(JSON.stringify(summary));
  });

  test("formats text and json as safe management summaries", () => {
    const summary = summarizeClaudeCodePreflight(fixture());
    const text = formatClaudeCodePreflightText(summary);
    const json = formatClaudeCodePreflightJson(summary);
    expect(text).toContain("Claude Code session preflight");
    expect(text).toContain("status: ready");
    expect(text).toContain("safe_to_upload");
    expect(JSON.parse(json).status).toBe("ready");
    expectNoLeak(text);
    expectNoLeak(json);
  });

  test("blocks empty-but-valid transcripts with no reviewable steps", () => {
    const summary = summarizeClaudeCodePreflight("{}\n");
    expect(summary.status).toBe("blocked");
    expect(summary.steps).toBe(0);
    expect(summary.caveats.join(" ")).toContain("No reviewable steps");
    expect(formatClaudeCodePreflightText(summary)).not.toContain("safe_to_upload");
  });

  test("blocks files over the real 8 MiB importer limit", () => {
    const summary = summarizeClaudeCodePreflight("x".repeat(8 * 1024 * 1024 + 1));
    expect(summary.status).toBe("blocked");
    expect(summary.caveats.join(" ")).toMatch(/8 MiB.*limit/i);
    expect(formatClaudeCodePreflightText(summary)).toContain("no_data_sent");
  });

  test("reports when parser line limits truncate the file", () => {
    const line = JSON.stringify({ type: "mode", mode: "normal", sessionId: SID });
    const summary = summarizeClaudeCodePreflight(Array.from({ length: 50_001 }, () => line).join("\n"));
    expect(summary.truncated).toBe(true);
    expect(summary.status).toBe("blocked");
    expect(summary.caveats.join(" ")).toMatch(/line limit.*split/i);
  });
});
