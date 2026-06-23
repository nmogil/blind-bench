import { describe, expect, it } from "vitest";
import { EvalCase } from "./evalCase";
import {
  convertTraceToEvalCase,
  normalizeCloudflareAiGatewayLog,
  parseCloudflareAiGatewayJsonl,
  stableStringify,
  toJsonl,
  type CloudflareAiGatewayLog,
} from "./cloudflareAiGateway";

const chatRecord: CloudflareAiGatewayLog = {
  account_id: "acct_TEST_cloudflare",
  gateway_id: "gw_TEST_customer",
  log_id: "log_TEST_001",
  event_id: "evt_TEST_001",
  timestamp: "2026-06-23T12:00:00Z",
  provider: "anthropic",
  model: "claude-sonnet-4-0",
  status: "success",
  cached: false,
  request: {
    messages: [
      { role: "system", content: "You are a synthetic support assistant." },
      { role: "user", content: "What is my synthetic payoff?" },
    ],
  },
  response: { choices: [{ message: { content: "Your synthetic payoff is $123.45." } }] },
  usage: { input_tokens: 42, output_tokens: 12, total_tokens: 54, cost_usd: 0.0021 },
  duration_ms: 1180,
  metadata: {
    product: "eavesly",
    module: "payoff_summary",
    prompt_version: "pv_TEST_001",
    variant: "control",
    release: "rel_TEST_2026_06",
    environment: "staging",
  },
};

const redactedRecord: CloudflareAiGatewayLog = {
  account_id: "acct_TEST_cloudflare",
  gateway_id: "gw_TEST_customer",
  log_id: "log_TEST_002",
  timestamp: "2026-06-23T12:01:00Z",
  provider: "openai",
  model: "gpt-4.1-mini",
  status: "success",
  request: { redacted: true },
  response: undefined,
  metadata: { product: "migo", module: "summary", environment: "staging" },
};

const feedbackDlpRecord: CloudflareAiGatewayLog = {
  account_id: "acct_TEST_cloudflare",
  gateway_id: "gw_TEST_customer",
  log_id: "log_TEST_003",
  event_id: "evt_TEST_003",
  timestamp: "2026-06-23T12:02:00Z",
  provider: "anthropic",
  model: "claude-haiku-4-0",
  status: "success",
  request: { prompt: "Summarize synthetic call TEST-CALL-003" },
  response: { text: "Synthetic summary created." },
  tokens_in: 30,
  tokens_out: 8,
  cost: 0.0007,
  duration: 640,
  dlp: { action: "allow", flagged: false },
  human_feedback: { value: "thumbs_down", rating: 0 },
  metadata: { product: "eavesly", module: "qa_review" },
};

describe("Cloudflare AI Gateway adapter", () => {
  it("normalizes a synthetic chat-completion log", () => {
    const row = normalizeCloudflareAiGatewayLog(chatRecord);
    expect(row.trace_id).toMatch(/^cf-aigw-/);
    expect(row.product).toBe("eavesly");
    expect(row.module).toBe("payoff_summary");
    expect(row.prompt_version).toBe("pv_TEST_001");
    expect(row.messages).toHaveLength(2);
    expect(row.output_text).toBe("Your synthetic payoff is $123.45.");
    expect(row.cost_usd).toBe(0.0021);
    expect(row.duration_ms).toBe(1180);
    expect(row.redaction.request_missing).toBe(false);
    expect(row.redaction.response_missing).toBe(false);
  });

  it("handles redacted/missing request and response safely", () => {
    const row = normalizeCloudflareAiGatewayLog(redactedRecord);
    expect(row.product).toBe("migo");
    expect(row.messages).toEqual([]);
    expect(row.output_text).toBeUndefined();
    expect(row.redaction.request_missing).toBe(true);
    expect(row.redaction.response_missing).toBe(true);
    expect(row.redaction.notes).toContain("request_has_no_messages");
    expect(row.redaction.notes).toContain("response_missing_or_redacted");
  });

  it("maps DLP and human feedback fields", () => {
    const row = normalizeCloudflareAiGatewayLog(feedbackDlpRecord);
    expect(row.dlp).toEqual({ action: "allow", flagged: false });
    expect(row.human_feedback).toEqual({ value: "thumbs_down", rating: 0 });
    expect(row.usage.input_tokens).toBe(30);
    expect(row.usage.output_tokens).toBe(8);
  });

  it("parses exported JSONL and writes deterministic normalized JSONL", () => {
    const input = [chatRecord, feedbackDlpRecord].map((r) => JSON.stringify(r)).join("\n");
    const rows = parseCloudflareAiGatewayJsonl(input);
    expect(rows).toHaveLength(2);
    expect(toJsonl(rows)).toBe(toJsonl(rows));
    expect(toJsonl(rows)).toContain("cf-aigw-");
  });

  it("generates stable ids independent of object key order", () => {
    const a = normalizeCloudflareAiGatewayLog(chatRecord).trace_id;
    const b = normalizeCloudflareAiGatewayLog(JSON.parse(stableStringify(chatRecord))).trace_id;
    expect(a).toBe(b);
  });

  it("merges sidecar metadata when Cloudflare metadata is too small", () => {
    const row = normalizeCloudflareAiGatewayLog(
      { ...chatRecord, metadata: { product: "eavesly" } },
      { metadataSidecar: { log_TEST_001: { module: "sidecar_module", prompt_version: "sidecar_prompt" } } },
    );
    expect(row.module).toBe("sidecar_module");
    expect(row.prompt_version).toBe("sidecar_prompt");
  });

  it("converts a normalized trace into a production-log eval case seed", () => {
    const row = normalizeCloudflareAiGatewayLog(chatRecord);
    const evalCase = EvalCase.parse(convertTraceToEvalCase(row, { tags: ["smoke"] }));
    expect(evalCase.source).toBe("production_log");
    expect(evalCase.product).toBe("eavesly");
    expect(evalCase.input.messages).toHaveLength(2);
    expect(evalCase.tags).toContain("cloudflare-ai-gateway");
  });
});
