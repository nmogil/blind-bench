import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseClaudeCodeSession } from "../../../convex/lib/claudeCodeTrace";
import { mapOtlpToTraces } from "../../../convex/lib/otelGenAI";
import { parseCloudflareAiGatewayJsonl, stableStringify } from "./cloudflareAiGateway";

export const AGENT_TRACE_FIXTURE_DIR = "agent-trace-fixtures";
export const AGENT_TRACE_FIXTURE_FILES = {
  claudeCode: "claude-code-session.jsonl",
  cloudflareGateway: "cloudflare-gateway.jsonl",
  otlp: "otlp-genai.json",
  manifest: "manifest.json",
  summary: "README.md",
} as const;

export interface AgentTraceFixtureManifest {
  generated_at: string;
  fixture_set: "synthetic-agent-trace-fixtures";
  safety: {
    synthetic_only: true;
    no_customer_data: true;
    no_credentials: true;
    no_network_calls: true;
  };
  files: Array<{
    file: string;
    format: "claude_code_jsonl" | "cloudflare_ai_gateway_jsonl" | "otlp_genai_json";
    traces: number;
    spans?: number;
    steps: number;
    models: string[];
  }>;
}

export interface AgentTraceFixtureArtifacts {
  claudeCodeJsonl: string;
  cloudflareGatewayJsonl: string;
  otlpJson: string;
  manifest: AgentTraceFixtureManifest;
  manifestJson: string;
  summaryMarkdown: string;
}

const GENERATED_AT = "2026-01-01T00:00:00Z";
const MODEL = "gpt-4o-mini";
const SYNTHETIC_PROMPT = "Synthetic support agent dry run: summarize the account status for a test workspace.";
const SYNTHETIC_RESPONSE = "Synthetic answer: the test workspace is active, no action is required, and no customer data was used.";

function jsonl(rows: unknown[]): string {
  return rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
}

export function buildSyntheticClaudeCodeJsonl(): string {
  const base = {
    sessionId: "synthetic-session-0001",
    cwd: "/tmp/blindbench-synthetic-workspace",
    version: "synthetic-fixture-v1",
  };
  return jsonl([
    {
      ...base,
      type: "system",
      uuid: "system-1",
      timestamp: GENERATED_AT,
      subtype: "init",
      level: "info",
    },
    {
      ...base,
      type: "user",
      uuid: "user-1",
      timestamp: "2026-01-01T00:00:01Z",
      message: { role: "user", content: SYNTHETIC_PROMPT },
    },
    {
      ...base,
      type: "assistant",
      uuid: "assistant-1",
      timestamp: "2026-01-01T00:00:02Z",
      message: {
        id: "msg-synthetic-1",
        role: "assistant",
        model: MODEL,
        usage: { input_tokens: 42, output_tokens: 24 },
        content: [
          { type: "text", text: "I will inspect the synthetic workspace status." },
          { type: "tool_use", id: "toolu-synthetic-1", name: "read_status", input: { workspace: "TEST_WORKSPACE" } },
        ],
      },
    },
    {
      ...base,
      type: "user",
      uuid: "tool-result-1",
      timestamp: "2026-01-01T00:00:03Z",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu-synthetic-1", content: "status=active; balance=0" }],
      },
      toolUseResult: { status: "active", balance: 0 },
    },
    {
      ...base,
      type: "assistant",
      uuid: "assistant-2",
      timestamp: "2026-01-01T00:00:04Z",
      message: {
        id: "msg-synthetic-2",
        role: "assistant",
        model: MODEL,
        usage: { input_tokens: 20, output_tokens: 18 },
        content: [{ type: "text", text: SYNTHETIC_RESPONSE }],
      },
    },
  ]);
}

export function buildSyntheticCloudflareGatewayJsonl(): string {
  return jsonl([
    {
      log_id: "log_synthetic_0001",
      account_id: "acct_TEST_ONLY",
      gateway_id: "gateway_synthetic",
      timestamp: GENERATED_AT,
      provider: "openai",
      model: MODEL,
      success: true,
      status_code: 200,
      request: {
        messages: [{ role: "user", content: SYNTHETIC_PROMPT }],
        model: MODEL,
      },
      response: {
        choices: [{ message: { role: "assistant", content: SYNTHETIC_RESPONSE } }],
        model: MODEL,
      },
      usage: { input_tokens: 42, output_tokens: 24, total_tokens: 66 },
      metadata: {
        product: "synthetic-support-agent",
        module: "dry-run",
        environment: "synthetic",
        trace_id: "synthetic-trace-0001",
      },
    },
  ]);
}

function otlpAttr(key: string, value: string | number) {
  return {
    key,
    value: typeof value === "number" ? { intValue: String(value) } : { stringValue: value },
  };
}

export function buildSyntheticOtlpPayload(): Record<string, unknown> {
  return {
    resourceSpans: [
      {
        resource: { attributes: [otlpAttr("service.name", "synthetic-agent-harness")] },
        scopeSpans: [
          {
            scope: { name: "blindbench.synthetic" },
            spans: [
              {
                traceId: "abcdef0123456789abcdef0123456789",
                spanId: "0000000000000001",
                name: "synthetic.chat",
                startTimeUnixNano: "1704067200000000000",
                attributes: [
                  otlpAttr("gen_ai.system", "openai"),
                  otlpAttr("gen_ai.request.model", MODEL),
                  otlpAttr("gen_ai.prompt", SYNTHETIC_PROMPT),
                  otlpAttr("gen_ai.completion", SYNTHETIC_RESPONSE),
                  otlpAttr("gen_ai.usage.input_tokens", 42),
                  otlpAttr("gen_ai.usage.output_tokens", 24),
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

export function buildAgentTraceFixtures(): AgentTraceFixtureArtifacts {
  const claudeCodeJsonl = buildSyntheticClaudeCodeJsonl();
  const cloudflareGatewayJsonl = buildSyntheticCloudflareGatewayJsonl();
  const otlpPayload = buildSyntheticOtlpPayload();
  const otlpJson = JSON.stringify(otlpPayload, null, 2) + "\n";

  const claude = parseClaudeCodeSession(claudeCodeJsonl);
  const gateway = parseCloudflareAiGatewayJsonl(cloudflareGatewayJsonl);
  const otlp = mapOtlpToTraces(otlpPayload);

  const manifest: AgentTraceFixtureManifest = {
    generated_at: GENERATED_AT,
    fixture_set: "synthetic-agent-trace-fixtures",
    safety: {
      synthetic_only: true,
      no_customer_data: true,
      no_credentials: true,
      no_network_calls: true,
    },
    files: [
      {
        file: AGENT_TRACE_FIXTURE_FILES.claudeCode,
        format: "claude_code_jsonl",
        traces: 1,
        steps: claude.summary.steps,
        models: claude.summary.models,
      },
      {
        file: AGENT_TRACE_FIXTURE_FILES.cloudflareGateway,
        format: "cloudflare_ai_gateway_jsonl",
        traces: gateway.length,
        steps: gateway.reduce((sum, trace) => sum + trace.messages.length + (trace.output_text ? 1 : 0), 0),
        models: [...new Set(gateway.map((trace) => trace.model).filter((m): m is string => !!m))],
      },
      {
        file: AGENT_TRACE_FIXTURE_FILES.otlp,
        format: "otlp_genai_json",
        traces: otlp.summary.traces,
        spans: otlp.summary.spans,
        steps: otlp.summary.steps,
        models: otlp.summary.models,
      },
    ],
  };
  const manifestJson = JSON.stringify(manifest, null, 2) + "\n";
  const summaryMarkdown = [
    "# Synthetic agent trace fixtures",
    "",
    "Deterministic, synthetic-only fixtures for local BlindBench dry runs.",
    "",
    `Generated at: ${manifest.generated_at}`,
    "",
    "| File | Format | Traces | Steps | Models |",
    "| --- | --- | ---: | ---: | --- |",
    ...manifest.files.map((file) =>
      `| \`${file.file}\` | ${file.format} | ${file.traces} | ${file.steps} | ${file.models.join(", ") || "n/a"} |`,
    ),
    "",
    "Safety: synthetic only, no customer data, no credentials, no network calls.",
    "",
  ].join("\n");

  return { claudeCodeJsonl, cloudflareGatewayJsonl, otlpJson, manifest, manifestJson, summaryMarkdown };
}

export function writeAgentTraceFixtures(outDir: string): AgentTraceFixtureManifest {
  const artifacts = buildAgentTraceFixtures();
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, AGENT_TRACE_FIXTURE_FILES.claudeCode), artifacts.claudeCodeJsonl);
  writeFileSync(join(outDir, AGENT_TRACE_FIXTURE_FILES.cloudflareGateway), artifacts.cloudflareGatewayJsonl);
  writeFileSync(join(outDir, AGENT_TRACE_FIXTURE_FILES.otlp), artifacts.otlpJson);
  writeFileSync(join(outDir, AGENT_TRACE_FIXTURE_FILES.manifest), artifacts.manifestJson);
  writeFileSync(join(outDir, AGENT_TRACE_FIXTURE_FILES.summary), artifacts.summaryMarkdown);
  return artifacts.manifest;
}

export function stableFixtureSnapshot(): string {
  const artifacts = buildAgentTraceFixtures();
  return stableStringify({
    claudeCodeJsonl: artifacts.claudeCodeJsonl,
    cloudflareGatewayJsonl: artifacts.cloudflareGatewayJsonl,
    otlpJson: artifacts.otlpJson,
    manifest: artifacts.manifest,
  });
}
