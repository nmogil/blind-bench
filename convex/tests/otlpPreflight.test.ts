import { describe, expect, test } from "vitest";
import { mapOtlpToTraces } from "../lib/otelGenAI";
import { buildPreflightSummary, renderPreflightText } from "../lib/otlpPreflight";

const attr = (key: string, value: Record<string, unknown>) => ({ key, value });
const span = (traceId: string, spanId: string, t: string, attrs: Array<{ key: string; value: Record<string, unknown> }>) => ({
  traceId, spanId, startTimeUnixNano: t, attributes: attrs,
});

// Sentinels that must NEVER appear in a management-safe summary — raw prompt,
// raw completion, a credential-like token, an account-like id.
const RAW_PROMPT = "SENTINEL_RAW_PROMPT_do_not_leak";
const RAW_COMPLETION = "SENTINEL_RAW_COMPLETION_do_not_leak";
const TOKEN = "TOKEN_DO_NOT_PRINT_123456";
const ACCOUNT = "acct_SENTINEL_ACCOUNT_1234567890";

// Two spans, one trace: bodies + a tool call carrying token/account-like args.
const payload = {
  resourceSpans: [
    {
      scopeSpans: [
        {
          spans: [
            span("otel-trace-preflight-xyz", "s1", "1000", [
              attr("gen_ai.request.model", { stringValue: "gpt-4o" }),
              attr("gen_ai.system", { stringValue: "openai" }),
              attr("gen_ai.usage.input_tokens", { intValue: "12" }),
              attr("gen_ai.usage.output_tokens", { intValue: "7" }),
              attr("gen_ai.prompt", { stringValue: RAW_PROMPT }),
              attr("gen_ai.completion_json", {
                stringValue: JSON.stringify({
                  role: "assistant",
                  content: RAW_COMPLETION,
                  tool_calls: [
                    { id: "call_1", function: { name: "lookup", arguments: JSON.stringify({ token: TOKEN, account: ACCOUNT }) } },
                  ],
                }),
              }),
            ]),
            // Body-optional span → contributes requestMissing/responseMissing counts.
            span("otel-trace-preflight-xyz", "s2", "2000", [
              attr("gen_ai.request.model", { stringValue: "gpt-4o" }),
            ]),
          ],
        },
      ],
    },
  ],
};

const SENTINELS = [RAW_PROMPT, RAW_COMPLETION, TOKEN, ACCOUNT];

describe("#298 OTLP preflight summary builder", () => {
  test("counts + label-only fields; readiness ready", () => {
    const summary = buildPreflightSummary(mapOtlpToTraces(payload));
    expect(summary.traces).toBe(1);
    expect(summary.spans).toBe(2);
    expect(summary.steps).toBeGreaterThan(0);
    expect(summary.requestMissing).toBe(1);
    expect(summary.responseMissing).toBe(1);
    expect(summary.models).toEqual(["gpt-4o"]);
    expect(summary.harnesses).toEqual(["openai"]);
    expect(summary.readiness).toBe("ready");
    // Trace refs are suffix-only — never the full raw id.
    expect(summary.traceRefs[0]!.startsWith("…")).toBe(true);
    expect(summary.traceRefs[0]).not.toContain("otel-trace-preflight");
    expect(summary.caveats.some((c) => c.includes("no request/prompt"))).toBe(true);
  });

  test("leakage guard: neither text nor JSON summary contains raw bodies/token/account", () => {
    const summary = buildPreflightSummary(mapOtlpToTraces(payload));
    const text = renderPreflightText(summary);
    const json = JSON.stringify(summary);
    for (const sentinel of SENTINELS) {
      expect(text).not.toContain(sentinel);
      expect(json).not.toContain(sentinel);
    }
    // Sanity: the safe labels DO survive, so we know we tested a populated summary.
    expect(text).toContain("gpt-4o");
    expect(text).toContain("openai");
  });

  test("zero mapped traces → not_ready with a clear caveat", () => {
    const summary = buildPreflightSummary(mapOtlpToTraces({ resourceSpans: [] }));
    expect(summary.traces).toBe(0);
    expect(summary.readiness).toBe("not_ready");
    expect(summary.caveats.join(" ")).toContain("No traces mapped");
  });
});
