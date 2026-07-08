/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";
import { normalizeEvalRecordV1 } from "../lib/agentTrace";

// One eval-record v1: a two-message request + assistant output with a tool call.
const validRecord = {
  version: "1",
  id: "rec-abc",
  timestamp: "2026-07-08T00:00:00Z",
  model: "gpt-4",
  provider: "openai",
  input: {
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "What is 2+2?" },
    ],
  },
  output: {
    content: "4",
    tool_calls: [{ id: "call-1", name: "calc", arguments: { expr: "2+2" } }],
    tool_results: [{ tool_call_id: "call-1", name: "calc", result: 4 }],
  },
  usage: { input_tokens: 10, output_tokens: 5, cost_usd: 0.001, duration_ms: 42 },
};

async function seed(t: ReturnType<typeof convexTest>) {
  const ids = await t.run(async (ctx) => {
    const ownerUserId = await ctx.db.insert("users", { name: "Owner", email: "o@test.com" });
    const orgId = await ctx.db.insert("organizations", { name: "Org", slug: "org", createdById: ownerUserId });
    await ctx.db.insert("organizationMembers", { organizationId: orgId, userId: ownerUserId, role: "owner" });
    const projectId = await ctx.db.insert("projects", { organizationId: orgId, name: "P", createdById: ownerUserId });
    await ctx.db.insert("projectCollaborators", { projectId, userId: ownerUserId, role: "owner", invitedById: ownerUserId, invitedAt: Date.now() });
    return { ownerUserId, projectId };
  });
  return { ids, asOwner: t.withIdentity({ subject: `${ids.ownerUserId}|s`, tokenIdentifier: `test|${ids.ownerUserId}` }) };
}

describe("native eval-record v1 normalizer (pure)", () => {
  test("maps request messages, output content, tool call/result into steps", () => {
    const trace = normalizeEvalRecordV1(validRecord);
    // trace_id is namespaced (native-) so a client id can't collide with another
    // source's parent trace; run_id stays the raw id for source-scoped dedup.
    expect(trace.trace_id).toBe("native-rec-abc");
    expect(trace.run_id).toBe("rec-abc");
    expect(trace.model).toBe("gpt-4");
    expect(trace.harness.name).toBe("openai");
    expect(trace.product).toBe("openai");
    // 2 request messages + 1 assistant message + 1 tool_call + 1 tool_result
    expect(trace.steps.map((s) => s.type)).toEqual([
      "message",
      "message",
      "message",
      "tool_call",
      "tool_result",
    ]);
    const contents = trace.steps.flatMap((s) => (s.type === "message" ? [s.message.content] : []));
    expect(contents).toEqual(["You are helpful.", "What is 2+2?", "4"]);
    expect(trace.final_answer).toBe("4");
    expect(trace.usage.total_tokens).toBe(15);
    expect(trace.usage.cost_usd).toBe(0.001);
    expect(trace.usage.duration_ms).toBe(42);
    expect(trace.source_ids).toEqual({ record_id: "rec-abc", provider: "openai" });
  });

  test("throws on missing version", () => {
    expect(() => normalizeEvalRecordV1({ input: { messages: [{ role: "user", content: "hi" }] } })).toThrow(/version/);
  });

  test("throws on missing/empty input.messages", () => {
    expect(() => normalizeEvalRecordV1({ version: "1", input: { messages: [] } })).toThrow(/messages/);
    expect(() => normalizeEvalRecordV1({ version: "1" })).toThrow(/messages/);
  });

  test("derives a deterministic trace_id when id is absent", () => {
    const { id: _omit, ...noId } = validRecord;
    const a = normalizeEvalRecordV1(noId);
    const b = normalizeEvalRecordV1(noId);
    expect(a.trace_id).toBe(b.trace_id);
    expect(a.trace_id).toMatch(/^native-[0-9a-f]{16}$/);
  });

  test("id-less records differing only in usage derive distinct trace_ids", () => {
    const { id: _omit, ...base } = validRecord;
    const a = normalizeEvalRecordV1(base);
    const b = normalizeEvalRecordV1({ ...base, usage: { ...base.usage, cost_usd: 9.99 } });
    expect(a.trace_id).not.toBe(b.trace_id);
  });

  test("explicit privacy_class raises but never lowers computed sensitivity", () => {
    // sensitive tool arg → computed pii; explicit "public" must not downgrade it.
    const sensitive = {
      version: "1",
      input: { messages: [{ role: "user", content: "hi" }] },
      output: { tool_calls: [{ name: "lookup", arguments: { ssn: "123-45-6789" } }] },
      privacy_class: "public",
    };
    expect(normalizeEvalRecordV1(sensitive).privacy.class).toBe("pii");
  });

  test("rejects malformed output fields (counted invalid by caller)", () => {
    const bad = {
      version: "1",
      input: { messages: [{ role: "user", content: "hi" }] },
      output: { tool_calls: [{ name: 123, arguments: "not-object" }] },
    };
    expect(() => normalizeEvalRecordV1(bad)).toThrow(/tool_calls/);
  });
});

describe("native HTTP ingest end-to-end", () => {
  test("token-authed POST persists a trajectory through the spine; re-POST dedups", async () => {
    const t = convexTest(schema);
    const { ids, asOwner } = await seed(t);
    const { token } = await asOwner.mutation(api.ingestTokens.issueIngestToken, { projectId: ids.projectId, label: "t" });

    const post = (b: unknown) =>
      t.fetch("/ingest/v1/traces", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(b),
      });

    const res = await post(validRecord);
    expect(res.status).toBe(200);
    const summary = await res.json();
    expect(summary.traces).toBe(1);
    expect(summary.imported).toBe(1);
    expect(summary.steps).toBe(5);
    expect(summary.invalid).toBe(0);

    // Persisted as an agentTrace with steps, source native import linked.
    const persisted = await t.run(async (ctx) => {
      const trace = await ctx.db.query("agentTraces").first();
      const steps = trace
        ? await ctx.db.query("agentTraceSteps").withIndex("by_trace_and_index", (q) => q.eq("agentTraceId", trace._id)).collect()
        : [];
      const imp = trace?.traceImportId ? await ctx.db.get(trace.traceImportId) : null;
      return { status: trace?.status, stepCount: steps.length, source: imp?.source };
    });
    expect(persisted.status).toBe("ready");
    expect(persisted.stepCount).toBe(5);
    expect(persisted.source).toBe("native");

    // Idempotent re-POST of the same id.
    const again = await (await post(validRecord)).json();
    expect(again.imported).toBe(0);
    expect(again.deduped).toBe(1);
    const traceCount = await t.run(async (ctx) => (await ctx.db.query("agentTraces").collect()).length);
    expect(traceCount).toBe(1);
  });

  test("accepts a {records:[]} batch; one bad record is counted invalid, good ones imported", async () => {
    const t = convexTest(schema);
    const { ids, asOwner } = await seed(t);
    const { token } = await asOwner.mutation(api.ingestTokens.issueIngestToken, { projectId: ids.projectId, label: "t" });

    const good = { ...validRecord, id: "rec-good" };
    const bad = { version: "1", input: { messages: [] } }; // empty messages → invalid
    const res = await t.fetch("/ingest/v1/traces", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ records: [good, bad] }),
    });
    expect(res.status).toBe(200);
    const summary = await res.json();
    expect(summary.imported).toBe(1);
    expect(summary.invalid).toBe(1);
    const traceCount = await t.run(async (ctx) => (await ctx.db.query("agentTraces").collect()).length);
    expect(traceCount).toBe(1);
  });

  test("missing or invalid token is rejected 401", async () => {
    const t = convexTest(schema);
    await seed(t);
    const noToken = await t.fetch("/ingest/v1/traces", { method: "POST", body: "{}" });
    expect(noToken.status).toBe(401);
    const badToken = await t.fetch("/ingest/v1/traces", {
      method: "POST",
      headers: { Authorization: "Bearer deadbeef" },
      body: "{}",
    });
    expect(badToken.status).toBe(401);
  });
});
