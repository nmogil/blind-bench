import { describe, expect, it } from "vitest";
import { normalizeGatewayLog } from "./cloudflareAiGateway";
import {
  materializeEvalCase,
  readProduct,
} from "./materializeEvalCase";
import { DEFAULT_PRODUCTION_LOG_SCORER_IDS } from "../lib/scorecardConfig";
import { aggregateScores, scoreCase } from "../lib/scorecardScoring";

// Pure converter tests — no `_generated`, no convex runtime.

const chat = {
  log_id: "log_MAT_001",
  timestamp: "2026-06-23T12:00:00Z",
  provider: "anthropic",
  model: "claude-sonnet-4-0",
  metadata: { product: "support-assistant" },
  request: {
    messages: [
      { role: "system", content: "You are a synthetic assistant." },
      { role: "user", content: "What is my synthetic payoff?" },
    ],
  },
  response: { choices: [{ message: { content: "Happy to help — here it is." } }] },
  usage: { input_tokens: 42, output_tokens: 12, total_tokens: 54 },
  cost_usd: 0.0021,
  duration_ms: 1180,
};

const redacted = {
  log_id: "log_MAT_002",
  timestamp: "2026-06-23T12:01:00Z",
  provider: "openai",
  model: "gpt-4.1-mini",
  request: { redacted: true },
};

describe("materializeEvalCase", () => {
  it("maps a normalized trace + raw record into eval-case fields", () => {
    const trace = normalizeGatewayLog(chat);
    const fields = materializeEvalCase(trace, chat);
    expect(fields.source).toBe("production_log");
    expect(fields.product).toBe("support-assistant");
    expect(fields.title).toBe("support-assistant replay log_MAT_001");
    expect(fields.messages).toEqual([
      { role: "system", content: "You are a synthetic assistant." },
      { role: "user", content: "What is my synthetic payoff?" },
    ]);
    expect(fields.outputText).toBe("Happy to help — here it is.");
    expect(fields.requestMissing).toBe(false);
    expect(fields.responseMissing).toBe(false);
    expect(fields.model).toBe("claude-sonnet-4-0");
    expect(fields.provider).toBe("anthropic");
    expect(fields.timestamp).toBe("2026-06-23T12:00:00Z");
    expect(fields.inputTokens).toBe(42);
    expect(fields.outputTokens).toBe(12);
    expect(fields.costUsd).toBe(0.0021);
    expect(fields.durationMs).toBe(1180);
  });

  it("assigns the default production-log scorer set", () => {
    const fields = materializeEvalCase(normalizeGatewayLog(chat), chat);
    expect(fields.scorerIds).toEqual([
      "no_hallucinated_data",
      "no_cross_context_leakage",
      "read_only_no_destructive_tool",
      "tone_customer_fit",
    ]);
    // Returned array is a copy — mutating it must not affect the constant.
    fields.scorerIds.push("mutated");
    expect(DEFAULT_PRODUCTION_LOG_SCORER_IDS).not.toContain("mutated");
  });

  it("snapshots configured scorer assignment during materialization", () => {
    const fields = materializeEvalCase(normalizeGatewayLog(chat), chat, {
      scorerIds: ["no_hallucinated_data", "cost_latency_threshold"],
      scorerConfig: {
        no_hallucinated_data: { phrases: ["ssn 123"] },
        cost_latency_threshold: { maxLatencyMs: 2500 },
      },
    });
    expect(fields.scorerIds).toEqual([
      "no_hallucinated_data",
      "cost_latency_threshold",
    ]);
    expect(fields.scorerConfig).toEqual({
      no_hallucinated_data: { phrases: ["ssn 123"] },
      cost_latency_threshold: { maxLatencyMs: 2500 },
    });
  });

  it("falls back to product 'unknown' and carries redaction flags", () => {
    const trace = normalizeGatewayLog(redacted);
    const fields = materializeEvalCase(trace, redacted);
    expect(fields.product).toBe("unknown");
    expect(fields.title).toBe("unknown replay log_MAT_002");
    expect(fields.messages).toEqual([]);
    expect(fields.outputText).toBeUndefined();
    expect(fields.requestMissing).toBe(true);
    expect(fields.responseMissing).toBe(true);
  });

  it("readProduct reads metadata.product with an unknown fallback", () => {
    expect(readProduct({ metadata: { product: "voice-agent" } })).toBe(
      "voice-agent",
    );
    expect(readProduct({ request: { metadata: { product: "chat" } } })).toBe(
      "chat",
    );
    expect(readProduct({})).toBe("unknown");
    expect(readProduct(undefined)).toBe("unknown");
  });

  it("default scorers do NOT hard-fail vacuously on a normal captured output", () => {
    const fields = materializeEvalCase(normalizeGatewayLog(chat), chat);
    const verdict = scoreCase(
      { scorerIds: fields.scorerIds },
      { text: fields.outputText },
    );
    expect(verdict.hardFailed).toBe(false);
    expect(verdict.passed).toBe(true);
    expect(verdict.score).toBe(1);
    expect(verdict.failingScorers).toEqual([]);
  });

  it("hard-fails only on a real safety violation via scorer config", () => {
    // With a forbidden phrase configured and present in the output, the
    // hard-fail scorer fires — proving the pass above is a real signal.
    const verdict = scoreCase(
      {
        scorerIds: ["no_hallucinated_data"],
        scorerConfig: { no_hallucinated_data: { phrases: ["ssn 123"] } },
      },
      { text: "your ssn 123 is on file" },
    );
    expect(verdict.hardFailed).toBe(true);
    expect(verdict.passed).toBe(false);
    expect(verdict.failingScorers).toEqual(["no_hallucinated_data"]);
  });

  it("aggregateScores matches src semantics (hard-fail dominates)", () => {
    expect(
      aggregateScores([
        { scorer: "a", score: 1, passed: true, reason: "", hard_fail: false },
        { scorer: "b", score: 0, passed: false, reason: "", hard_fail: true },
      ]),
    ).toEqual({ score: 0.5, passed: false, hardFailed: true });
    expect(aggregateScores([])).toEqual({
      score: 0,
      passed: false,
      hardFailed: false,
    });
  });
});
