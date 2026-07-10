/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";
import {
  normalizeJeevesClogRun,
  type JeevesClogRunExport,
  type AgentRunTrace,
} from "../lib/agentTrace";
import { aliasToolName } from "../lib/blindProjection";

// A trace loaded with direct identifiers a blind reviewer must never see.
const identifiedRun: JeevesClogRunExport = {
  run_id: "JEEVES-RUN-TEST-BLIND",
  trace_id: "agent-REALTRACEID-0001",
  product: "jeeves",
  module: "systems_agent",
  environment: "staging",
  harness: { name: "jeeves_clog", version: "TEST-v9", sdk: "clog" },
  model: "claude-sonnet-4-0",
  messages: [{ role: "user", content: "Investigate the account." }],
  steps: [
    { type: "message", role: "assistant", content: "Running a command." },
    { type: "tool_call", id: "toolu_PROVIDERID_ABC", name: "Bash", timestamp: "2026-07-07T10:00:00Z", args: { command: "cat /etc/passwd", ssn: "123-45-6789" } },
    { type: "tool_result", id: "toolu_PROVIDERID_ABC", name: "Bash", result: { stdout: "ok", secret_token: "TEST-TOKEN-DO-NOT-SHOW" } },
    { type: "tool_call", id: "toolu_PROVIDERID_DEF", name: "delete_account", args: { account_id: "ACCT-TEST-BLIND-001" } },
  ],
  final_answer: "Done investigating the account.",
  usage: { cost_usd: 0.02, duration_ms: 1500, total_tokens: 700 },
};

const asJson = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

async function seed(t: ReturnType<typeof convexTest>) {
  const ids = await t.run(async (ctx) => {
    const ownerUserId = await ctx.db.insert("users", { name: "Owner", email: "o@test.com" });
    const evaluatorUserId = await ctx.db.insert("users", { name: "Rev", email: "r@test.com" });
    const orgId = await ctx.db.insert("organizations", { name: "Org", slug: "org", createdById: ownerUserId });
    await ctx.db.insert("organizationMembers", { organizationId: orgId, userId: ownerUserId, role: "owner" });
    const projectId = await ctx.db.insert("projects", { organizationId: orgId, name: "P", createdById: ownerUserId });
    await ctx.db.insert("projectCollaborators", { projectId, userId: ownerUserId, role: "owner", invitedById: ownerUserId, invitedAt: Date.now() });
    await ctx.db.insert("projectCollaborators", { projectId, userId: evaluatorUserId, role: "evaluator", invitedById: ownerUserId, invitedAt: Date.now() });
    return { ownerUserId, evaluatorUserId, projectId };
  });
  return {
    ids,
    asOwner: t.withIdentity({ subject: `${ids.ownerUserId}|s`, tokenIdentifier: `test|${ids.ownerUserId}` }),
    asBlind: t.withIdentity({ subject: `${ids.evaluatorUserId}|s`, tokenIdentifier: `test|${ids.evaluatorUserId}` }),
  };
}

// Direct identifiers that must NEVER appear in any blind response body.
const FORBIDDEN = [
  "jeeves_clog", // harness
  "claude-sonnet-4-0", // model
  "agent-REALTRACEID-0001", // real trace id
  "toolu_PROVIDERID", // provider tool-call ids
  "Bash", // real tool name
  "delete_account", // real tool name
  "123-45-6789", // ssn in body
  "TEST-TOKEN-DO-NOT-SHOW", // secret in body
  "2026-07-07T10:00:00Z", // wall-clock timestamp
];

describe("#266 blind projection — no provenance leaks to evaluators", () => {
  test("aliasToolName maps known tools and pseudonymizes unknown ones", () => {
    expect(aliasToolName("Bash")).toBe("run_command");
    expect(aliasToolName("Read")).toBe("read_file");
    const unknown = aliasToolName("delete_account");
    expect(unknown).not.toBe("delete_account");
    expect(unknown).toMatch(/^tool_[0-9a-f]{6}$/);
    // Deterministic + collision-distinct across different names.
    expect(aliasToolName("delete_account")).toBe(unknown);
    expect(aliasToolName("create_escalation")).not.toBe(unknown);
  });

  test("blind listSteps + getTrace contain zero direct identifiers; owner sees all", async () => {
    const t = convexTest(schema);
    const { ids, asOwner, asBlind } = await seed(t);
    const trace = normalizeJeevesClogRun(identifiedRun);
    const { agentTraceId } = await asOwner.action(api.agentTraces.persistTrace, {
      projectId: ids.projectId,
      trace: asJson(trace) as unknown as AgentRunTrace,
    });

    const opts = { paginationOpts: { numItems: 50, cursor: null } };
    const sessions = await asBlind.query(api.agentTraceReviewSessions.listMine, {});
    const token = sessions[0]?.token;
    if (!token) throw new Error("Missing opaque review session");
    const blindSteps = await asBlind.query(api.agentTraceReviewSessions.listSteps, { token, ...opts });
    const blindTrace = await asBlind.query(api.agentTraceReviewSessions.getTrace, { token });

    // Metadata + inline scalars carry no identifiers. (Bodies are opaque URLs;
    // their redacted content is asserted separately below.)
    const blindMeta = JSON.stringify({ ...blindTrace, page: blindSteps.page });
    for (const needle of FORBIDDEN) {
      expect(blindMeta).not.toContain(needle);
    }
    // Positive projection checks.
    expect(blindTrace).not.toHaveProperty("harnessName");
    expect(blindTrace).not.toHaveProperty("model");
    expect(blindTrace).not.toHaveProperty("traceId");
    expect(blindTrace).not.toHaveProperty("_id");
    const bashStep = blindSteps.page.find((s) => s.kind === "tool_call");
    expect(bashStep?.toolName).toBe("run_command"); // aliased
    expect(bashStep?.toolCallId).toBe("call-1"); // opaque positional
    expect(bashStep?.timestamp).toBeUndefined(); // wall-clock dropped

    // Blind step body is the redacted blob — no secrets.
    const blindBody = await t.run(async (ctx) => {
      const row = await ctx.db
        .query("agentTraceSteps")
        .withIndex("by_trace_and_index", (q) => q.eq("agentTraceId", agentTraceId).eq("stepIndex", 1))
        .first();
      return await (await ctx.storage.get(row!.blindBodyStorageId!))!.text();
    });
    expect(blindBody).toContain("[REDACTED]");
    expect(blindBody).not.toContain("123-45-6789");

    // Control: the OWNER (non-blind) still sees real provenance.
    const ownerTrace = await asOwner.query(api.agentTraces.getTrace, { agentTraceId });
    const ownerSteps = await asOwner.query(api.agentTraces.listSteps, { agentTraceId, ...opts });
    expect(ownerTrace?.harnessName).toBe("jeeves_clog");
    expect(ownerTrace?.model).toBe("claude-sonnet-4-0");
    expect(ownerSteps.page.find((s) => s.kind === "tool_call")?.toolName).toBe("Bash");
  });
});
