import { describe, expect, it } from "vitest";
import {
  normalizeCloudflareAiGatewayLog,
  type CloudflareAiGatewayLog,
} from "./cloudflareAiGateway";
import { loadConfig, modelField, gatewayUrlForMode } from "./fireworksGatewayPrototype";
import {
  buildSmokeRequest,
  redactSmokeRequest,
  verifyGatewayLog,
  SMOKE_PROMPT,
  type VerifyExpectations,
} from "./fireworksGatewaySmoke";

const ENV = {
  CF_ACCOUNT_ID: "acct_TEST",
  CF_AIG_GATEWAY: "gw_TEST",
  FIREWORKS_MODEL: "accounts/test/models/migo-ft-0001",
  TENANT_LABEL: "tenant-test",
  PRODUCT: "migo",
};

const IDS = { traceId: "smoke-trace-abc123", sessionId: "smoke-session-abc123" };
const SECRETS = { fireworksApiKey: "fw_SUPER_SECRET_KEY", gatewayToken: "cf_SUPER_SECRET_TOKEN" };

/** Build a normalized trace from a synthetic gateway log carrying the smoke trace_id. */
function normalizedLog(overrides: Partial<CloudflareAiGatewayLog> = {}) {
  const record: CloudflareAiGatewayLog = {
    account_id: "acct_TEST",
    gateway_id: "gw_TEST",
    log_id: "log_smoke_001",
    timestamp: "2026-07-05T12:00:00Z",
    provider: "fireworks-ai",
    model: "accounts/test/models/migo-ft-0001",
    status: "success",
    request: { messages: [{ role: "user", content: SMOKE_PROMPT }] },
    response: { choices: [{ message: { content: "ok" } }] },
    usage: { input_tokens: 20, output_tokens: 2, total_tokens: 22, cost_usd: 0.0001 },
    duration_ms: 540,
    metadata: {
      product: "migo",
      module: "prototype_smoke",
      prompt_version: "pv_prototype_0001",
      variant: "control",
      release: "rel_prototype",
      environment: "staging",
      tenant: "tenant-test",
      trace_id: IDS.traceId,
      session_id: IDS.sessionId,
    },
    ...overrides,
  };
  return normalizeCloudflareAiGatewayLog(record);
}

const EXPECTED: VerifyExpectations = {
  provider: "fireworks-ai",
  model: "accounts/test/models/migo-ft-0001",
  traceId: IDS.traceId,
};

describe("buildSmokeRequest", () => {
  it("targets the configured gateway endpoint with the resolved model field", () => {
    const c = loadConfig(ENV);
    const req = buildSmokeRequest(c, { ...IDS, ...SECRETS });
    expect(req.url).toBe(gatewayUrlForMode(c));
    expect(req.body.model).toBe(modelField(c));
    expect(req.body.messages).toEqual([{ role: "user", content: SMOKE_PROMPT }]);
    expect(req.traceId).toBe(IDS.traceId);
  });

  it("carries both credentials and a unique trace_id in metadata", () => {
    const req = buildSmokeRequest(loadConfig(ENV), { ...IDS, ...SECRETS });
    expect(req.headers.Authorization).toBe("Bearer fw_SUPER_SECRET_KEY");
    expect(req.headers["cf-aig-authorization"]).toBe("Bearer cf_SUPER_SECRET_TOKEN");
    const meta = JSON.parse(req.headers["cf-aig-metadata"] ?? "{}") as Record<string, string>;
    expect(meta.trace_id).toBe(IDS.traceId);
    expect(meta.session_id).toBe(IDS.sessionId);
    expect(req.body.metadata.trace_id).toBe(IDS.traceId);
  });
});

describe("redactSmokeRequest", () => {
  it("replaces secret header values with env-var placeholders", () => {
    const req = buildSmokeRequest(loadConfig(ENV), { ...IDS, ...SECRETS });
    const redacted = redactSmokeRequest(req);
    expect(redacted.headers.Authorization).toBe("Bearer $FIREWORKS_API_KEY");
    expect(redacted.headers["cf-aig-authorization"]).toBe("Bearer $CF_AIG_TOKEN");
    const text = JSON.stringify(redacted);
    expect(text).not.toContain("fw_SUPER_SECRET_KEY");
    expect(text).not.toContain("cf_SUPER_SECRET_TOKEN");
    // metadata + prompt still round-trip so the operator can eyeball the request
    expect(text).toContain(IDS.traceId);
  });
});

describe("verifyGatewayLog", () => {
  it("passes a well-formed log and reports cost presence (non-fatal)", () => {
    const result = verifyGatewayLog(normalizedLog(), EXPECTED);
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.notes.some((n) => n.includes("cost_usd"))).toBe(true);
  });

  it("does not fail when cost_usd is absent — only notes it", () => {
    const result = verifyGatewayLog(
      normalizedLog({ usage: { input_tokens: 20, output_tokens: 2, total_tokens: 22 } }),
      EXPECTED,
    );
    expect(result.ok).toBe(true);
    expect(result.notes.some((n) => /cost_usd/.test(n))).toBe(true);
  });

  it("fails when usage tokens are missing", () => {
    const result = verifyGatewayLog(normalizedLog({ usage: {} }), EXPECTED);
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/token/i);
  });

  it("fails on provider mismatch", () => {
    const result = verifyGatewayLog(normalizedLog({ provider: "anthropic" }), EXPECTED);
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/provider/i);
  });

  it("fails when the trace_id does not round-trip", () => {
    const result = verifyGatewayLog(normalizedLog(), { ...EXPECTED, traceId: "different-trace" });
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/trace_id/i);
  });

  it("fails when status is not success", () => {
    const result = verifyGatewayLog(normalizedLog({ status: "error" }), EXPECTED);
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/status/i);
  });

  it("reports redaction as a note, not a failure, when bodies are stripped", () => {
    const result = verifyGatewayLog(
      normalizedLog({ request: { redacted: true }, response: undefined }),
      EXPECTED,
    );
    // provider/model/usage/duration/metadata/status still present → verification passes
    expect(result.ok).toBe(true);
    expect(result.notes.some((n) => /redact/i.test(n))).toBe(true);
  });

  it("flags missing duration_ms", () => {
    const result = verifyGatewayLog(normalizedLog({ duration_ms: undefined }), EXPECTED);
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/duration/i);
  });
});
