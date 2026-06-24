import { describe, expect, it } from "vitest";
import {
  buildExampleCurl,
  buildGatewayUrls,
  buildMetadata,
  buildPlan,
  formatRunbookMarkdown,
  gatewayUrlForMode,
  loadConfig,
  modelField,
} from "./fireworksGatewayPrototype";

const ENV = {
  CF_ACCOUNT_ID: "acct_TEST",
  CF_AIG_GATEWAY: "gw_TEST",
  FIREWORKS_MODEL: "accounts/test/models/migo-ft-0001",
  TENANT_LABEL: "tenant-test",
  PRODUCT: "migo",
};

describe("loadConfig", () => {
  it("fails closed when required config is missing", () => {
    expect(() => loadConfig({})).toThrow(/missing required config/);
    expect(() => loadConfig({ CF_ACCOUNT_ID: "x" })).toThrow(/CF_AIG_GATEWAY/);
  });

  it("does not fail closed in synthetic fallback mode and flags it", () => {
    const c = loadConfig({}, { syntheticFallback: true });
    expect(c.synthetic).toBe(true);
    expect(c.cf_account_id).toMatch(/SYNTHETIC/);
  });

  it("env overrides file and clears synthetic flag", () => {
    const c = loadConfig(ENV, { file: { product: "ignored" }, syntheticFallback: true });
    expect(c.synthetic).toBe(false);
    expect(c.product).toBe("migo");
    expect(c.cf_account_id).toBe("acct_TEST");
  });
});

describe("URL + cURL generation", () => {
  it("is deterministic", () => {
    const c = loadConfig(ENV);
    expect(buildGatewayUrls(c)).toEqual(buildGatewayUrls(loadConfig(ENV)));
    expect(buildExampleCurl(c)).toBe(buildExampleCurl(loadConfig(ENV)));
  });

  it("builds the provider and compat endpoints", () => {
    const c = loadConfig(ENV);
    const urls = buildGatewayUrls(c);
    expect(urls.provider).toBe(
      "https://gateway.ai.cloudflare.com/v1/acct_TEST/gw_TEST/fireworks-ai/chat/completions",
    );
    expect(urls.compat).toBe("https://gateway.ai.cloudflare.com/v1/acct_TEST/gw_TEST/compat/chat/completions");
    expect(gatewayUrlForMode(c)).toBe(urls.compat);
  });

  it("compat mode prefixes the provider slug onto the model field", () => {
    const c = loadConfig({ ...ENV, CF_AIG_MODE: "compat" });
    expect(gatewayUrlForMode(c)).toBe(buildGatewayUrls(c).compat);
    expect(modelField(c)).toBe("fireworks-ai/accounts/test/models/migo-ft-0001");
  });

  it("redacts secrets to env-var placeholders and never embeds real keys", () => {
    const c = loadConfig(ENV);
    const curl = buildExampleCurl(c);
    expect(curl).toContain("Bearer $FIREWORKS_API_KEY");
    expect(curl).toContain("cf-aig-authorization: Bearer $CF_AIG_TOKEN");
    // no literal secret-looking tokens
    expect(curl).not.toMatch(/sk-|fw_|Bearer [A-Za-z0-9]{16,}/);
  });

  it("includes every required metadata field", () => {
    const m = buildMetadata(loadConfig(ENV));
    for (const k of [
      "product",
      "module",
      "prompt_version",
      "variant",
      "release",
      "environment",
      "trace_id",
      "session_id",
    ]) {
      expect(m[k], k).toBeTruthy();
    }
    expect(buildExampleCurl(loadConfig(ENV))).toContain("cf-aig-metadata");
  });
});

describe("plan + runbook hygiene", () => {
  it("plan verification fields align with the gateway adapter", () => {
    const fields = buildPlan(loadConfig(ENV)).verification.map((v) => v.field);
    for (const f of ["provider", "model", "cost_usd", "duration_ms", "usage", "metadata", "redaction"]) {
      expect(fields).toContain(f);
    }
  });

  it("embeds no production/customer data and no secrets", () => {
    const c = loadConfig({}, { syntheticFallback: true });
    const text = formatRunbookMarkdown(c, buildPlan(c)) + JSON.stringify(buildPlan(c));
    expect(text.toLowerCase()).not.toContain("pennie");
    expect(text).not.toMatch(/sk-[A-Za-z0-9]/);
    // synthetic prompt only — no real transcripts
    expect(text).toContain("Synthetic smoke prompt");
  });
});
