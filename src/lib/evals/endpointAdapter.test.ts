import { describe, expect, it } from "vitest";
import type { EvalCaseInput } from "./evalCase";
import {
  captureOutputs,
  EndpointConfig,
  fireworksCandidateEndpoint,
  parseCompletion,
  resolveHeaders,
} from "./endpointAdapter";

const ENDPOINT = EndpointConfig.parse({
  label: "test endpoint",
  url: "https://example.test/v1/chat/completions",
  model: "test-model",
  headers: { Authorization: "Bearer $TEST_KEY" },
});

const CASE: EvalCaseInput = {
  id: "case-1",
  product: "migo",
  title: "greeting",
  source: "synthetic",
  input: { messages: [{ role: "user", content: "hi" }] },
  expected: { privacy_class: "internal" },
};

function okResponse(json: unknown): Response {
  return { ok: true, status: 200, json: async () => json } as unknown as Response;
}

describe("resolveHeaders", () => {
  it("substitutes $ENV_VAR placeholders", () => {
    expect(resolveHeaders({ Authorization: "Bearer $K" }, { K: "abc" })).toEqual({
      Authorization: "Bearer abc",
    });
  });

  it("throws on a missing env var", () => {
    expect(() => resolveHeaders({ Authorization: "Bearer $MISSING_K" }, {})).toThrow(
      /MISSING_K/,
    );
  });

  it("passes values without placeholders through unchanged", () => {
    expect(resolveHeaders({ "x-static": "v1" }, {})).toEqual({ "x-static": "v1" });
  });
});

describe("parseCompletion", () => {
  it("normalizes text, tool calls, and metrics", () => {
    const out = parseCompletion(
      {
        id: "cmpl-1",
        model: "m",
        choices: [
          {
            message: {
              content: "hello",
              tool_calls: [{ function: { name: "lookup", arguments: '{"a":1}' } }],
            },
          },
        ],
        usage: { total_tokens: 42, cost: 0.001 },
      },
      120,
    );
    expect(out.text).toBe("hello");
    expect(out.tool_calls).toEqual([{ name: "lookup", args: { a: 1 } }]);
    expect(out.raw).toMatchObject({ latency_ms: 120, tokens: 42, cost_usd: 0.001 });
  });

  it("tolerates null content and malformed tool-call arguments", () => {
    const out = parseCompletion(
      {
        choices: [
          { message: { content: null, tool_calls: [{ function: { name: "x", arguments: "not-json" } }] } },
        ],
      },
      5,
    );
    expect(out.text).toBeUndefined();
    expect(out.tool_calls).toEqual([{ name: "x" }]);
  });
});

describe("captureOutputs", () => {
  it("captures outputs keyed by case id with latency from the injected clock", async () => {
    let t = 1000;
    const { outputs, errors } = await captureOutputs([CASE], ENDPOINT, {
      env: { TEST_KEY: "k" },
      now: () => (t += 50),
      fetchImpl: (async () =>
        okResponse({
          choices: [{ message: { content: "ok" } }],
          usage: { total_tokens: 7 },
        })) as typeof fetch,
    });
    expect(errors).toEqual([]);
    expect(outputs["case-1"]?.text).toBe("ok");
    expect((outputs["case-1"]?.raw as { latency_ms: number }).latency_ms).toBe(50);
  });

  it("sends model, messages, and resolved auth header", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    await captureOutputs([CASE], ENDPOINT, {
      env: { TEST_KEY: "secret" },
      fetchImpl: (async (url: unknown, init?: RequestInit) => {
        seen.url = String(url);
        seen.init = init;
        return okResponse({ choices: [{ message: { content: "ok" } }] });
      }) as typeof fetch,
    });
    expect(seen.url).toBe(ENDPOINT.url);
    const headers = seen.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer secret");
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(String(seen.init?.body)) as {
      model: string;
      messages: unknown;
      max_tokens: number;
      temperature: number;
    };
    expect(body.model).toBe("test-model");
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(body.max_tokens).toBe(512);
    expect(body.temperature).toBe(0);
  });

  it("prepends transcript turns before scenario messages", async () => {
    const replayCase: EvalCaseInput = {
      ...CASE,
      id: "case-replay",
      input: {
        transcript: [{ role: "assistant", content: "earlier turn" }],
        messages: [{ role: "user", content: "now" }],
      },
    };
    let sent: unknown;
    await captureOutputs([replayCase], ENDPOINT, {
      env: { TEST_KEY: "k" },
      fetchImpl: (async (_url: unknown, init?: RequestInit) => {
        sent = JSON.parse(String(init?.body));
        return okResponse({ choices: [{ message: { content: "ok" } }] });
      }) as typeof fetch,
    });
    expect((sent as { messages: unknown }).messages).toEqual([
      { role: "assistant", content: "earlier turn" },
      { role: "user", content: "now" },
    ]);
  });

  it("records HTTP errors and omits the case from outputs", async () => {
    const { outputs, errors } = await captureOutputs([CASE], ENDPOINT, {
      env: { TEST_KEY: "k" },
      fetchImpl: (async () =>
        ({ ok: false, status: 500, json: async () => ({}) }) as unknown as Response) as typeof fetch,
    });
    expect(outputs).toEqual({});
    expect(errors).toEqual([{ case_id: "case-1", error: "HTTP 500" }]);
  });

  it("records thrown fetch errors and continues with later cases", async () => {
    const case2: EvalCaseInput = {
      ...CASE,
      id: "case-2",
      input: { messages: [{ role: "user", content: "second" }] },
    };
    let calls = 0;
    const { outputs, errors } = await captureOutputs([CASE, case2], ENDPOINT, {
      env: { TEST_KEY: "k" },
      fetchImpl: (async () => {
        calls++;
        if (calls === 1) throw new Error("connection reset");
        return okResponse({ choices: [{ message: { content: "ok" } }] });
      }) as typeof fetch,
    });
    expect(errors).toEqual([{ case_id: "case-1", error: "connection reset" }]);
    expect(outputs["case-2"]?.text).toBe("ok");
  });

  it("records an error for a case with no messages or transcript", async () => {
    const empty: EvalCaseInput = { ...CASE, id: "case-empty", input: {} };
    const { outputs, errors } = await captureOutputs([empty], ENDPOINT, {
      env: { TEST_KEY: "k" },
      fetchImpl: (async () => okResponse({})) as typeof fetch,
    });
    expect(outputs).toEqual({});
    expect(errors).toHaveLength(1);
    expect(errors[0]?.case_id).toBe("case-empty");
  });
});

describe("fireworksCandidateEndpoint", () => {
  it("builds the gateway route from env and keeps secrets as placeholders", () => {
    const ep = fireworksCandidateEndpoint({
      CF_ACCOUNT_ID: "acct",
      CF_AIG_GATEWAY: "gw",
      FIREWORKS_MODEL: "accounts/x/models/y",
      TENANT_LABEL: "tenant-a",
      PRODUCT: "migo",
    });
    expect(ep.url).toBe(
      "https://gateway.ai.cloudflare.com/v1/acct/gw/compat/chat/completions",
    );
    expect(ep.model).toBe("fireworks-ai/accounts/x/models/y");
    expect(ep.headers.Authorization).toBe("Bearer $FIREWORKS_API_KEY");
    expect(ep.headers["cf-aig-authorization"]).toBe("Bearer $CF_AIG_TOKEN");
    expect(ep.headers["cf-aig-metadata"]).toContain('"product":"migo"');
  });

  it("fails closed when required env is missing", () => {
    expect(() => fireworksCandidateEndpoint({})).toThrow(/missing required config/);
  });
});
