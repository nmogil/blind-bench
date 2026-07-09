import { describe, expect, test } from "vitest";
import {
  formatGatewayPreflightJson,
  formatGatewayPreflightText,
  summarizeGatewayPreflight,
} from "./cloudflareGatewayPreflight";

const SENSITIVE_SENTINEL = "TOKEN_DO_NOT_PRINT_123456";
const RAW_PROMPT = "Do not leak this raw user prompt";
const RAW_OUTPUT = "Do not leak this raw model output";
const ACCOUNT_ID = "acct_DO_NOT_PRINT_123";

function gatewayJsonl(): string {
  const good = {
    log_id: "log_TEST_001",
    account_id: ACCOUNT_ID,
    timestamp: "2026-07-09T10:00:00Z",
    provider: "anthropic",
    model: "claude-sonnet-4-0",
    metadata: { trace_id: "tr_safe_001", product: "support-assistant" },
    request: {
      messages: [
        { role: "user", content: RAW_PROMPT },
      ],
      credential_marker: SENSITIVE_SENTINEL,
    },
    response: { choices: [{ message: { content: RAW_OUTPUT } }] },
    usage: { input_tokens: 42, output_tokens: 12, total_tokens: 54 },
  };
  const redacted = {
    log_id: "log_TEST_002",
    timestamp: "2026-07-09T10:01:00Z",
    provider: "openai",
    model: "gpt-4.1-mini",
    request: { redacted: true },
  };
  return [JSON.stringify(good), "{ malformed json with " + SENSITIVE_SENTINEL, JSON.stringify(redacted)].join("\n");
}

function sidecarJson(): string {
  return JSON.stringify({
    tr_safe_001: { release: "r1", note: SENSITIVE_SENTINEL },
    no_match: { release: "r2" },
  });
}

function expectNoLeak(text: string) {
  expect(text).not.toContain(SENSITIVE_SENTINEL);
  expect(text).not.toContain(RAW_PROMPT);
  expect(text).not.toContain(RAW_OUTPUT);
  expect(text).not.toContain(ACCOUNT_ID);
  expect(text).not.toContain("malformed json");
  expect(text).not.toContain("no_match");
}

describe("Cloudflare Gateway preflight", () => {
  test("summarizes Gateway JSONL without leaking raw content", () => {
    const summary = summarizeGatewayPreflight(gatewayJsonl());
    expect(summary.status).toBe("ready");
    expect(summary.parsed).toBe(2);
    expect(summary.invalid).toBe(1);
    expect(summary.invalid_lines).toEqual([2]);
    expect(summary.models).toEqual(["claude-sonnet-4-0", "gpt-4.1-mini"]);
    expect(summary.providers).toEqual(["anthropic", "openai"]);
    expect(summary.redacted_request).toBe(1);
    expect(summary.redacted_response).toBe(1);
    expect(summary.earliest).toBe("2026-07-09T10:00:00Z");
    expect(summary.latest).toBe("2026-07-09T10:01:00Z");
    expectNoLeak(JSON.stringify(summary));
  });

  test("reports sidecar counts without leaking sidecar content", () => {
    const summary = summarizeGatewayPreflight(gatewayJsonl(), { sidecarJson: sidecarJson() });
    expect(summary.sidecar).toEqual({ supplied: true, entries: 2, matched: 1 });
    const text = formatGatewayPreflightText(summary);
    const json = formatGatewayPreflightJson(summary);
    expect(text).toContain("sidecar_entries: 2");
    expect(text).toContain("sidecar_matched_records: 1");
    expect(JSON.parse(json).sidecar.matched).toBe(1);
    expectNoLeak(text);
    expectNoLeak(json);
  });

  test("blocks empty parses with a clear caveat", () => {
    const summary = summarizeGatewayPreflight("{ not json }\n");
    expect(summary.status).toBe("blocked");
    expect(summary.parsed).toBe(0);
    expect(summary.invalid).toBe(1);
    expect(summary.caveats.join(" ")).toContain("No valid Gateway log records");
  });
});
