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
import { splitStep, reconstructStep } from "../lib/agentTraceStorage";

const passingRun: JeevesClogRunExport = {
  run_id: "JEEVES-RUN-TEST-001",
  product: "jeeves",
  module: "systems_agent",
  environment: "staging",
  harness: { name: "jeeves_clog", version: "TEST-v1", sdk: "clog" },
  model: "claude-sonnet-4-0",
  messages: [{ role: "user", content: "Does the synthetic account need escalation?" }],
  steps: [
    { type: "message", role: "assistant", content: "Let me look up the account." },
    { type: "tool_call", id: "tool-1", name: "lookup_account", args: { account_id: "ACCT-TEST-AGENT-001", phone: "+15550101010" } },
    { type: "tool_result", id: "tool-1", name: "lookup_account", result: { status: "active", account_number: "TEST-SECRET-0001" } },
    { type: "state", label: "checkpoint", snapshot: { reviewed: true, ssn: "123-45-6789" } },
    { type: "policy_event", policy: "no_destructive_action", action: "allow", reason: "read_only_lookup" },
  ],
  final_answer: "I routed the synthetic account to a specialist for review.",
  usage: { cost_usd: 0.01, duration_ms: 2100, total_tokens: 900 },
};

// A step body with sensitive keys the blind projection must redact.
const sensitiveRun: JeevesClogRunExport = {
  ...passingRun,
  run_id: "JEEVES-RUN-TEST-002",
  steps: [
    { type: "tool_call", id: "tool-1", name: "delete_account", args: { account_id: "ACCT-TEST-AGENT-002", ssn: "123-45-6789" } },
    { type: "tool_result", id: "tool-1", name: "delete_account", result: { ok: false, secret_token: "TEST-TOKEN-DO-NOT-SHOW" } },
  ],
};

// Convex actions receive JSON — mirror that (drops `undefined`) so the test
// exercises the real transport, not an in-process object with undefined holes.
const asJson = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

async function seed(t: ReturnType<typeof convexTest>) {
  const ids = await t.run(async (ctx) => {
    const ownerUserId = await ctx.db.insert("users", { name: "Owner", email: "owner@test.com" });
    const evaluatorUserId = await ctx.db.insert("users", { name: "Blind Rev", email: "rev@test.com" });
    const orgId = await ctx.db.insert("organizations", { name: "Org", slug: "org", createdById: ownerUserId });
    await ctx.db.insert("organizationMembers", { organizationId: orgId, userId: ownerUserId, role: "owner" });
    const projectId = await ctx.db.insert("projects", { organizationId: orgId, name: "P", createdById: ownerUserId });
    await ctx.db.insert("projectCollaborators", { projectId, userId: ownerUserId, role: "owner", invitedById: ownerUserId, invitedAt: Date.now() });
    await ctx.db.insert("projectCollaborators", { projectId, userId: evaluatorUserId, role: "evaluator", invitedById: ownerUserId, invitedAt: Date.now() });
    return { ownerUserId, evaluatorUserId, projectId };
  });
  const asOwner = t.withIdentity({ subject: `${ids.ownerUserId}|s-owner`, tokenIdentifier: `test|${ids.ownerUserId}` });
  const asBlind = t.withIdentity({ subject: `${ids.evaluatorUserId}|s-eval`, tokenIdentifier: `test|${ids.evaluatorUserId}` });
  return { ids, asOwner, asBlind };
}

describe("agentTraceStorage split/reconstruct (pure, no DB)", () => {
  test("every step kind round-trips losslessly", () => {
    const trace = normalizeJeevesClogRun(passingRun);
    for (const step of trace.steps) {
      const { row, fullBody, blindBody } = splitStep(step);
      expect(reconstructStep(row, fullBody, blindBody)).toEqual(step);
    }
  });
});

describe("agentTraces persistence spine", () => {
  test("normalize -> persist -> read back deep-equals on step structure", async () => {
    const t = convexTest(schema);
    const { ids, asOwner } = await seed(t);
    const trace = normalizeJeevesClogRun(passingRun);

    const res = await asOwner.action(api.agentTraces.persistTrace, {
      projectId: ids.projectId,
      trace: asJson(trace) as unknown as AgentRunTrace,
    });
    expect(res.deduped).toBe(false);
    expect(res.stepCount).toBe(trace.steps.length);

    // Read rows + blobs directly and reconstruct (the "read back" path).
    const rebuilt = await t.run(async (ctx) => {
      const parent = await ctx.db.get(res.agentTraceId);
      const rows = await ctx.db
        .query("agentTraceSteps")
        .withIndex("by_trace_and_index", (q) => q.eq("agentTraceId", res.agentTraceId))
        .collect();
      const steps = [];
      for (const row of rows) {
        const readBlob = async (id: typeof row.fullBodyStorageId) =>
          id ? JSON.parse(await (await ctx.storage.get(id))!.text()) : undefined;
        steps.push(reconstructStep(row, await readBlob(row.fullBodyStorageId), await readBlob(row.blindBodyStorageId)));
      }
      return { parent, steps };
    });

    expect(rebuilt.parent?.status).toBe("ready");
    expect(rebuilt.parent?.stepCount).toBe(trace.steps.length);
    expect(rebuilt.steps).toEqual(trace.steps);
  });

  test("500-step trace imports; parent row stays well under 10KB", async () => {
    const t = convexTest(schema);
    const { ids, asOwner } = await seed(t);
    const bigArgs = { blob: "x".repeat(10_000) }; // ~10KB mean body per step
    const bigRun: JeevesClogRunExport = {
      ...passingRun,
      run_id: "JEEVES-RUN-TEST-500",
      steps: Array.from({ length: 500 }, (_, i) => ({
        type: "tool_call" as const,
        id: `tool-${i}`,
        name: "work",
        args: { ...bigArgs, i },
      })),
      final_answer: undefined,
    };
    const trace = normalizeJeevesClogRun(bigRun);

    const res = await asOwner.action(api.agentTraces.persistTrace, {
      projectId: ids.projectId,
      trace: asJson(trace) as unknown as AgentRunTrace,
    });
    expect(res.stepCount).toBe(500);

    const parentBytes = await t.run(async (ctx) => {
      const parent = await ctx.db.get(res.agentTraceId);
      expect(parent?.status).toBe("ready");
      return JSON.stringify(parent).length;
    });
    // Parent carries no step content — comfortably under the 10KB budget.
    expect(parentBytes).toBeLessThan(10_240);
  }, 15_000);

  test("re-persisting the same trace dedups instead of duplicating", async () => {
    const t = convexTest(schema);
    const { ids, asOwner } = await seed(t);
    const trace = asJson(normalizeJeevesClogRun(passingRun)) as unknown as AgentRunTrace;
    const first = await asOwner.action(api.agentTraces.persistTrace, { projectId: ids.projectId, trace });
    const second = await asOwner.action(api.agentTraces.persistTrace, { projectId: ids.projectId, trace });
    expect(second.deduped).toBe(true);
    expect(second.agentTraceId).toBe(first.agentTraceId);
    const count = await t.run(async (ctx) =>
      (await ctx.db
        .query("agentTraceSteps")
        .withIndex("by_trace_and_index", (q) => q.eq("agentTraceId", first.agentTraceId))
        .collect()).length,
    );
    expect(count).toBe(trace.steps.length);
  });

  test("getStepBody: owner gets full body, blind gets the redacted body; no storage ids leak", async () => {
    const t = convexTest(schema);
    const { ids, asOwner, asBlind } = await seed(t);
    const trace = normalizeJeevesClogRun(sensitiveRun);
    const { agentTraceId } = await asOwner.action(api.agentTraces.persistTrace, {
      projectId: ids.projectId,
      trace: asJson(trace) as unknown as AgentRunTrace,
    });

    const opts = { paginationOpts: { numItems: 50, cursor: null } };
    const sessions = await asBlind.query(api.agentTraceReviewSessions.listMine, {});
    const token = sessions[0]?.token;
    if (!token) throw new Error("Missing opaque trace review session");
    const blindPage = await asBlind.query(api.agentTraceReviewSessions.listSteps, { token, ...opts });
    // listSteps never hands out storage ids or URLs — only a hasBody flag.
    for (const item of blindPage.page) {
      expect(item).not.toHaveProperty("fullBodyStorageId");
      expect(item).not.toHaveProperty("blindBodyStorageId");
      expect(item).not.toHaveProperty("bodyUrl");
    }
    const toolStep = blindPage.page.find((s) => s.kind === "tool_call");
    expect(toolStep?.hasBody).toBe(true);

    // The lazy body-fetch path (getStepBody) — the exact thing the viewer calls
    // on expand. Owner sees the real args; blind reviewer sees the redacted body.
    const ownerBody = JSON.stringify(
      await asOwner.action(api.agentTraces.getStepBody, { agentTraceId, stepIndex: toolStep!.stepIndex }),
    );
    const blindBody = JSON.stringify(
      await asBlind.action(api.agentTraceReviewSessions.getStepBody, { token, stepIndex: toolStep!.stepIndex }),
    );
    expect(ownerBody).toContain("123-45-6789");
    expect(blindBody).toContain("[REDACTED]");
    expect(blindBody).not.toContain("123-45-6789");

    // Final answer travels the same path (stepIndex omitted).
    const finalAnswer = await asOwner.action(api.agentTraces.getStepBody, { agentTraceId });
    expect(JSON.stringify(finalAnswer)).toContain("specialist");
  });
});
