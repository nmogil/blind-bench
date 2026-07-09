import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parseClaudeCodeSession } from "../../../convex/lib/claudeCodeTrace";
import { mapOtlpToTraces } from "../../../convex/lib/otelGenAI";
import { parseCloudflareAiGatewayJsonl } from "./cloudflareAiGateway";
import {
  AGENT_TRACE_FIXTURE_FILES,
  buildAgentTraceFixtures,
  stableFixtureSnapshot,
  writeAgentTraceFixtures,
} from "./agentTraceFixtures";

const FORBIDDEN = [
  new RegExp(["Pe", "nnie"].join(""), "i"),
  new RegExp(["Mi", "go"].join(""), "i"),
  /sk-[a-z0-9]/i,
  new RegExp(["pass", "word"].join(""), "i"),
  new RegExp(["api", "[_-]?", "key"].join(""), "i"),
  new RegExp(["Bear", "er"].join(""), "i"),
  new RegExp(["Author", "ization"].join(""), "i"),
];

describe("agent trace fixtures", () => {
  test("builds deterministic synthetic fixtures that existing parsers accept", () => {
    const first = buildAgentTraceFixtures();
    const second = buildAgentTraceFixtures();
    expect(second.manifestJson).toBe(first.manifestJson);
    expect(stableFixtureSnapshot()).toBe(stableFixtureSnapshot());

    const claude = parseClaudeCodeSession(first.claudeCodeJsonl);
    expect(claude.summary.steps).toBeGreaterThanOrEqual(4);
    expect(claude.summary.models).toEqual(["gpt-4o-mini"]);

    const gateway = parseCloudflareAiGatewayJsonl(first.cloudflareGatewayJsonl);
    expect(gateway).toHaveLength(1);
    expect(gateway[0]?.source).toBe("cloudflare_ai_gateway");
    expect(gateway[0]?.messages.length).toBe(1);

    const otlp = mapOtlpToTraces(JSON.parse(first.otlpJson));
    expect(otlp.summary.invalid).toBe(false);
    expect(otlp.summary.traces).toBe(1);
    expect(otlp.summary.spans).toBe(1);
    expect(otlp.summary.steps).toBeGreaterThanOrEqual(2);
  });

  test("writes all expected files", () => {
    const outDir = mkdtempSync(join(tmpdir(), "agent-trace-fixtures-"));
    const manifest = writeAgentTraceFixtures(outDir);
    for (const file of Object.values(AGENT_TRACE_FIXTURE_FILES)) {
      expect(readFileSync(join(outDir, file), "utf8").length).toBeGreaterThan(0);
    }
    expect(manifest.files.map((file) => file.file).sort()).toEqual([
      AGENT_TRACE_FIXTURE_FILES.claudeCode,
      AGENT_TRACE_FIXTURE_FILES.cloudflareGateway,
      AGENT_TRACE_FIXTURE_FILES.otlp,
    ].sort());
  });

  test("fixtures and summaries avoid customer names and credential-like sentinels", () => {
    const artifacts = buildAgentTraceFixtures();
    const combined = [
      artifacts.claudeCodeJsonl,
      artifacts.cloudflareGatewayJsonl,
      artifacts.otlpJson,
      artifacts.manifestJson,
      artifacts.summaryMarkdown,
    ].join("\n");
    for (const pattern of FORBIDDEN) expect(combined).not.toMatch(pattern);
  });
});
