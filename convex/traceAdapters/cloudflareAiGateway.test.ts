import { describe, expect, it } from "vitest";
import {
  normalizeGatewayLog,
  parseGatewayJsonl,
  summarizeTraces,
} from "./cloudflareAiGateway";

// Pure parser tests — no `_generated` files, no convex runtime needed.

const chat = {
  log_id: "log_TEST_001",
  timestamp: "2026-06-23T12:00:00Z",
  provider: "anthropic",
  model: "claude-sonnet-4-0",
  request: {
    messages: [
      { role: "system", content: "You are a synthetic assistant." },
      { role: "user", content: "What is my synthetic payoff?" },
    ],
  },
  response: { choices: [{ message: { content: "Your payoff is $123.45." } }] },
  usage: { input_tokens: 42, output_tokens: 12, total_tokens: 54 },
  cost_usd: 0.0021,
  duration_ms: 1180,
};

const redacted = {
  log_id: "log_TEST_002",
  timestamp: "2026-06-23T12:01:00Z",
  provider: "openai",
  model: "gpt-4.1-mini",
  request: { redacted: true },
};

describe("convex cloudflare gateway parser", () => {
  it("normalizes a chat log and uses the gateway log id as dedup key", () => {
    const t = normalizeGatewayLog(chat);
    expect(t.sourceTraceId).toBe("log_TEST_001");
    expect(t.messages).toHaveLength(2);
    expect(t.outputText).toBe("Your payoff is $123.45.");
    expect(t.model).toBe("claude-sonnet-4-0");
    expect(t.usage.inputTokens).toBe(42);
    expect(t.costUsd).toBe(0.0021);
    expect(t.requestMissing).toBe(false);
    expect(t.responseMissing).toBe(false);
  });

  it("retains a deterministic raw payload string for storage", () => {
    const t = normalizeGatewayLog(chat);
    // The parser hands the importer the raw record verbatim (for access-
    // controlled storage), so this DOES contain content — unlike the summary.
    expect(typeof t.rawPayloadJson).toBe("string");
    expect(JSON.parse(t.rawPayloadJson)).toMatchObject({
      log_id: "log_TEST_001",
      response: { choices: [{ message: { content: "Your payoff is $123.45." } }] },
    });
    // Deterministic: same input -> identical string (safe as a dedup/store key).
    expect(t.rawPayloadJson).toBe(normalizeGatewayLog(chat).rawPayloadJson);
  });

  it("flags redacted/missing request and response", () => {
    const t = normalizeGatewayLog(redacted);
    expect(t.messages).toEqual([]);
    expect(t.outputText).toBeUndefined();
    expect(t.requestMissing).toBe(true);
    expect(t.responseMissing).toBe(true);
  });

  it("falls back to a stable content hash when no id is present", () => {
    const noId = { ...chat, log_id: undefined, id: undefined };
    const a = normalizeGatewayLog(noId).sourceTraceId;
    const b = normalizeGatewayLog(noId).sourceTraceId;
    expect(a).toMatch(/^cf-aigw-/);
    expect(a).toBe(b);
  });

  it("reports invalid lines by number, not content, and skips blanks", () => {
    const input = [
      JSON.stringify(chat),
      "{ this is not json",
      "",
      "[1,2,3]", // valid json but not an object -> invalid
      JSON.stringify(redacted),
    ].join("\n");
    const { traces, invalidLines } = parseGatewayJsonl(input);
    expect(traces).toHaveLength(2);
    expect(invalidLines).toEqual([2, 4]);
  });

  it("truncates at maxLines and flags it", () => {
    const lines = Array.from({ length: 5 }, (_, i) =>
      JSON.stringify({ ...chat, log_id: `log_${i}` }),
    ).join("\n");
    const { traces, truncated } = parseGatewayJsonl(lines, {
      maxLines: 3,
      maxBytes: 1e9,
    });
    expect(traces).toHaveLength(3);
    expect(truncated).toBe(true);
  });

  it("summarizes to counts, models, providers, and time bounds only", () => {
    const { traces } = parseGatewayJsonl(
      [JSON.stringify(chat), JSON.stringify(redacted)].join("\n"),
    );
    const s = summarizeTraces(traces);
    expect(s.models).toEqual(["claude-sonnet-4-0", "gpt-4.1-mini"]);
    expect(s.providers).toEqual(["anthropic", "openai"]);
    expect(s.redactedRequest).toBe(1);
    expect(s.redactedResponse).toBe(1);
    expect(s.earliest).toBe("2026-06-23T12:00:00Z");
    expect(s.latest).toBe("2026-06-23T12:01:00Z");
    // summary carries no message/output text
    expect(JSON.stringify(s)).not.toContain("payoff");
  });
});
