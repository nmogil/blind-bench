import { describe, expect, it } from "vitest";
import {
  DEFAULT_SIDECAR_LIMITS,
  normalizeGatewayLog,
  parseGatewayJsonl,
  parseSidecar,
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

describe("convex gateway metadata sidecar", () => {
  // Record whose ground-truth metadata carries a trace_id (survives the 5-key
  // cap) plus an inline `product` the sidecar must not override.
  const withTrace = {
    ...chat,
    log_id: "log_TRACE_001",
    metadata: { trace_id: "tr_abc", product: "support-assistant" },
  };

  it("merges a sidecar entry by metadata.trace_id, into rawPayloadJson", () => {
    const { sidecar } = parseSidecar(
      JSON.stringify({ tr_abc: { release: "2026.7.0", environment: "prod" } }),
    );
    const { traces, sidecarMerged } = parseGatewayJsonl(
      JSON.stringify(withTrace),
      undefined,
      sidecar,
    );
    expect(sidecarMerged).toEqual([true]);
    // The merged metadata is in the stored blob (rawPayloadJson), so
    // materialization/readProduct picks it up for free.
    const stored = JSON.parse(traces[0]!.rawPayloadJson);
    expect(stored.metadata.release).toBe("2026.7.0");
    expect(stored.metadata.environment).toBe("prod");
  });

  it("falls back to the log id when there is no metadata.trace_id", () => {
    const { sidecar } = parseSidecar(
      JSON.stringify({ log_TEST_001: { release: "fallback-rel" } }),
    );
    // `chat` has log_id but no metadata.trace_id.
    const { traces, sidecarMerged } = parseGatewayJsonl(
      JSON.stringify(chat),
      undefined,
      sidecar,
    );
    expect(sidecarMerged).toEqual([true]);
    expect(JSON.parse(traces[0]!.rawPayloadJson).metadata.release).toBe(
      "fallback-rel",
    );
  });

  it("lets inline record metadata win on key conflicts", () => {
    const { sidecar } = parseSidecar(
      JSON.stringify({ tr_abc: { product: "WRONG", release: "r1" } }),
    );
    const { traces } = parseGatewayJsonl(
      JSON.stringify(withTrace),
      undefined,
      sidecar,
    );
    const meta = JSON.parse(traces[0]!.rawPayloadJson).metadata;
    // Gateway-logged value is ground truth.
    expect(meta.product).toBe("support-assistant");
    expect(meta.release).toBe("r1");
  });

  it("rejects entries whose values aren't primitives (counted, not thrown)", () => {
    const { sidecar, entries } = parseSidecar(
      JSON.stringify({
        tr_abc: { release: "ok" },
        tr_bad: { nested: { deep: 1 } },
      }),
    );
    expect(entries).toBe(1); // only the primitive-valued entry counts
    expect(sidecar).toBeDefined();
    expect(sidecar!.tr_bad).toBeUndefined();
    expect(sidecar!.tr_abc).toEqual({ release: "ok" });
  });

  it("treats an over-limit sidecar as invalid, without throwing", () => {
    const tooMany = Object.fromEntries(
      Array.from({ length: DEFAULT_SIDECAR_LIMITS.maxEntries + 1 }, (_, i) => [
        `tr_${i}`,
        { release: "r" },
      ]),
    );
    const byEntries = parseSidecar(JSON.stringify(tooMany));
    expect(byEntries.sidecar).toBeUndefined();
    expect(byEntries.entries).toBe(0);

    const oversized = "x".repeat(DEFAULT_SIDECAR_LIMITS.maxBytes + 1);
    const byBytes = parseSidecar(oversized);
    expect(byBytes.sidecar).toBeUndefined();
    expect(byBytes.entries).toBe(0);
  });

  it("treats malformed sidecar JSON as invalid, without throwing", () => {
    const bad = parseSidecar("{ not json");
    expect(bad.sidecar).toBeUndefined();
    expect(bad.entries).toBe(0);
    const notObject = parseSidecar("[1,2,3]");
    expect(notObject.sidecar).toBeUndefined();
    expect(notObject.entries).toBe(0);
  });

  it("measures the size limit in UTF-8 bytes, not UTF-16 chars", () => {
    // "€" is 1 UTF-16 char but 3 UTF-8 bytes — a multibyte payload must not
    // sneak past maxBytes on character count.
    const overByBytes = "€".repeat(
      Math.floor(DEFAULT_SIDECAR_LIMITS.maxBytes / 3) + 1,
    );
    expect(new TextEncoder().encode(overByBytes).length).toBeGreaterThan(
      DEFAULT_SIDECAR_LIMITS.maxBytes,
    );
    expect(overByBytes.length).toBeLessThan(DEFAULT_SIDECAR_LIMITS.maxBytes);
    const rejected = parseSidecar(overByBytes);
    expect(rejected.sidecar).toBeUndefined();
    expect(rejected.entries).toBe(0);

    // Exactly at the byte limit is allowed (guard is strict >).
    const atLimitJson = JSON.stringify({ tr_abc: { release: "ok" } });
    const padding = DEFAULT_SIDECAR_LIMITS.maxBytes - atLimitJson.length;
    const atLimit = parseSidecar(atLimitJson + " ".repeat(padding));
    expect(new TextEncoder().encode(atLimitJson + " ".repeat(padding)).length).toBe(
      DEFAULT_SIDECAR_LIMITS.maxBytes,
    );
    expect(atLimit.entries).toBe(1);
  });

  it("never matches inherited object members as correlation ids", () => {
    // A record whose trace_id collides with Object.prototype members must not
    // pick up a phantom sidecar entry.
    const hostileRecord = {
      log_id: "log_h1",
      metadata: { trace_id: "toString", product: "support-assistant" },
      request: { messages: [{ role: "user", content: "hi" }] },
      response: { choices: [{ message: { content: "ok" } }] },
    };
    const { sidecar } = parseSidecar(JSON.stringify({ tr_other: { a: "b" } }));
    const { sidecarMerged } = parseGatewayJsonl(
      JSON.stringify(hostileRecord),
      undefined,
      sidecar,
    );
    expect(sidecarMerged).toEqual([false]);

    // A "__proto__" sidecar key stays a plain own key: it merges only into the
    // record that carries that literal trace_id, and pollutes nothing.
    const proto = parseSidecar(
      JSON.stringify({ ["__proto__"]: { release: "r9" } }),
    );
    expect(proto.entries).toBe(1);
    expect(({} as Record<string, unknown>).release).toBeUndefined();
    const protoRecord = {
      ...hostileRecord,
      metadata: { trace_id: "__proto__", product: "support-assistant" },
    };
    const merged = parseGatewayJsonl(
      JSON.stringify(protoRecord),
      undefined,
      proto.sidecar,
    );
    expect(merged.sidecarMerged).toEqual([true]);
    expect(
      JSON.parse(merged.traces[0]!.rawPayloadJson).metadata.release,
    ).toBe("r9");
  });

  it("reports no merge for records with no matching sidecar key", () => {
    const { sidecar } = parseSidecar(JSON.stringify({ tr_other: { a: "b" } }));
    const { sidecarMerged, traces } = parseGatewayJsonl(
      JSON.stringify(withTrace),
      undefined,
      sidecar,
    );
    expect(sidecarMerged).toEqual([false]);
    // Untouched metadata still has only the inline keys.
    expect(JSON.parse(traces[0]!.rawPayloadJson).metadata).toEqual({
      trace_id: "tr_abc",
      product: "support-assistant",
    });
  });
});
