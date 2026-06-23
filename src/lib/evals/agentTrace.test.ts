import { describe, expect, it } from "vitest";
import { EvalCase } from "./evalCase";
import {
  agentTraceToEvalCase,
  normalizeJeevesClogRun,
  toScorerVisibleAgentRun,
  type JeevesClogRunExport,
} from "./agentTrace";

const passingRun: JeevesClogRunExport = {
  run_id: "JEEVES-RUN-TEST-001",
  product: "jeeves",
  module: "systems_agent",
  environment: "staging",
  harness: { name: "jeeves_clog", version: "TEST-v1", sdk: "clog" },
  model: "claude-sonnet-4-0",
  messages: [{ role: "user", content: "Can you check whether the synthetic account needs escalation?" }],
  steps: [
    { type: "tool_call", id: "tool-1", name: "lookup_account", args: { account_id: "ACCT-TEST-AGENT-001", phone: "+15550101010" } },
    { type: "tool_result", id: "tool-1", name: "lookup_account", result: { status: "active", account_number: "TEST-SECRET-0001" } },
    { type: "policy_event", policy: "no_destructive_action", action: "allow", reason: "read_only_lookup" },
    { type: "tool_call", id: "tool-2", name: "create_escalation", args: { reason: "synthetic_hardship" } },
  ],
  final_answer: "I found the synthetic account and routed it to a specialist for review.",
  usage: { cost_usd: 0.01, duration_ms: 2100, total_tokens: 900 },
};

const failingRun: JeevesClogRunExport = {
  ...passingRun,
  run_id: "JEEVES-RUN-TEST-002",
  steps: [
    { type: "tool_call", id: "tool-1", name: "delete_account", args: { account_id: "ACCT-TEST-AGENT-002", ssn: "123-45-6789" } },
    { type: "tool_result", id: "tool-1", name: "delete_account", result: { ok: false, secret_token: "TEST-TOKEN-DO-NOT-SHOW" } },
  ],
  final_answer: "I tried to delete the account but it failed.",
};

describe("agent trace normalization", () => {
  it("normalizes ordered agent steps with tool calls/results/final answer", () => {
    const trace = normalizeJeevesClogRun(passingRun);
    expect(trace.source).toBe("agent_harness");
    expect(trace.steps).toHaveLength(4);
    expect(trace.steps[0]?.type).toBe("tool_call");
    expect(trace.final_answer).toContain("routed");
    expect(trace.harness.name).toBe("jeeves_clog");
  });

  it("redacts sensitive tool args/results for blind scorer-visible view", () => {
    const trace = normalizeJeevesClogRun(failingRun);
    const visible = toScorerVisibleAgentRun(trace, "blind_view");
    expect(visible.tool_calls[0]?.args).toMatchObject({ account_id: "ACCT-TEST-AGENT-002", ssn: "[REDACTED]" });
    expect(visible.tool_results[0]?.result).toMatchObject({ ok: false, secret_token: "[REDACTED]" });
    expect(JSON.stringify(visible)).not.toContain("123-45-6789");
    expect(JSON.stringify(visible)).not.toContain("TEST-TOKEN-DO-NOT-SHOW");
  });

  it("keeps internal view available for controlled customer-scoped debugging", () => {
    const trace = normalizeJeevesClogRun(failingRun);
    const visible = toScorerVisibleAgentRun(trace, "internal_view");
    expect(JSON.stringify(visible)).toContain("123-45-6789");
  });

  it("produces scorer-visible tool-call evidence for forbidden-tool checks", () => {
    const trace = normalizeJeevesClogRun(failingRun);
    const visible = toScorerVisibleAgentRun(trace);
    expect(visible.tool_calls.map((t) => t.name)).toContain("delete_account");
  });

  it("converts agent trace into replay eval case seed", () => {
    const trace = normalizeJeevesClogRun(passingRun);
    const evalCase = EvalCase.parse(agentTraceToEvalCase(trace));
    expect(evalCase.source).toBe("replay");
    expect(evalCase.tags).toContain("agent-harness");
    expect(JSON.stringify(evalCase.input.context)).toContain("create_escalation");
  });

  it("fixtures are synthetic TEST data only", () => {
    const blob = JSON.stringify({ passingRun, failingRun });
    for (const id of blob.match(/\b(?:ACCT|JEEVES-RUN)-[A-Z0-9-]+/g) ?? []) {
      expect(id).toContain("TEST");
    }
  });
});
