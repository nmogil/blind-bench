/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";
import { mapOtlpToTraces } from "../lib/otelGenAI";

const attr = (key: string, value: Record<string, unknown>) => ({ key, value });
const span = (traceId: string, spanId: string, t: string, attrs: Array<{ key: string; value: Record<string, unknown> }>) => ({
  traceId, spanId, startTimeUnixNano: t, attributes: attrs,
});

// Two gen_ai spans under one trace_id → one trajectory of 4 message steps.
const otlpPayload = {
  resourceSpans: [
    {
      scopeSpans: [
        {
          spans: [
            span("trace-abc", "s1", "1000", [
              attr("gen_ai.request.model", { stringValue: "gpt-4" }),
              attr("gen_ai.system", { stringValue: "openai" }),
              attr("gen_ai.usage.input_tokens", { intValue: "10" }),
              attr("gen_ai.usage.output_tokens", { intValue: "5" }),
              attr("gen_ai.prompt_json", { stringValue: JSON.stringify([{ role: "user", content: "What is 2+2?" }]) }),
              attr("gen_ai.completion_json", { stringValue: JSON.stringify({ role: "assistant", content: "4" }) }),
            ]),
            span("trace-abc", "s2", "2000", [
              attr("gen_ai.request.model", { stringValue: "gpt-4" }),
              attr("gen_ai.prompt", { stringValue: "and 3+3?" }),
              attr("gen_ai.completion", { stringValue: "6" }),
            ]),
          ],
        },
      ],
    },
  ],
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

describe("#263 OTLP → AgentRunTrace mapper (pure)", () => {
  test("groups spans by trace_id into one trajectory; reads gen_ai attributes", () => {
    const { traces, summary } = mapOtlpToTraces(otlpPayload);
    expect(summary.traces).toBe(1);
    expect(summary.spans).toBe(2);
    const trace = traces[0]!;
    expect(trace.trace_id).toBe("otlp-trace-abc");
    expect(trace.model).toBe("gpt-4");
    expect(trace.harness.name).toBe("openai");
    expect(trace.usage.total_tokens).toBe(15);
    // span1: user + assistant; span2: user + assistant → 4 message steps
    expect(trace.steps.map((s) => s.type)).toEqual(["message", "message", "message", "message"]);
    const contents = trace.steps.flatMap((s) => (s.type === "message" ? [s.message.content] : []));
    expect(contents).toEqual(["What is 2+2?", "4", "and 3+3?", "6"]);
  });

  test("body-optional: a span with no prompt/completion still yields a trace, counted", () => {
    const bare = { resourceSpans: [{ scopeSpans: [{ spans: [span("t2", "s1", "1", [attr("gen_ai.request.model", { stringValue: "m" })])] }] }] };
    const { traces, summary } = mapOtlpToTraces(bare);
    expect(traces).toHaveLength(1);
    expect(summary.requestMissing).toBe(1);
    expect(summary.responseMissing).toBe(1);
  });
});

describe("#263 ingest tokens", () => {
  test("issue returns the full token once; list masks it; revoke disables it", async () => {
    const t = convexTest(schema);
    const { ids, asOwner } = await seed(t);
    const { token } = await asOwner.mutation(api.ingestTokens.issueIngestToken, { projectId: ids.projectId, label: "CF gateway" });
    expect(token).toMatch(/^[0-9a-f]{32}$/);

    const list = await asOwner.query(api.ingestTokens.listIngestTokens, { projectId: ids.projectId });
    expect(list).toHaveLength(1);
    expect(list[0]?.label).toBe("CF gateway");
    expect(list[0]?.preview).not.toBe(token); // masked
    expect(JSON.stringify(list)).not.toContain(token);

    await asOwner.mutation(api.ingestTokens.revokeIngestToken, { tokenId: list[0]!._id });
    expect((await asOwner.query(api.ingestTokens.listIngestTokens, { projectId: ids.projectId }))[0]?.revoked).toBe(true);
  });
});

describe("#263 OTLP HTTP ingest end-to-end", () => {
  test("token-authed POST persists a trajectory through the spine; re-POST dedups", async () => {
    const t = convexTest(schema);
    const { ids, asOwner } = await seed(t);
    const { token } = await asOwner.mutation(api.ingestTokens.issueIngestToken, { projectId: ids.projectId, label: "t" });

    const post = () =>
      t.fetch("/otlp/v1/traces", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(otlpPayload),
      });

    const res = await post();
    expect(res.status).toBe(200);
    const summary = await res.json();
    expect(summary.imported).toBe(1);
    expect(summary.steps).toBe(4);

    // Persisted as an agentTrace with steps, source otlp import linked.
    const persisted = await t.run(async (ctx) => {
      const trace = await ctx.db.query("agentTraces").first();
      const steps = trace
        ? await ctx.db.query("agentTraceSteps").withIndex("by_trace_and_index", (q) => q.eq("agentTraceId", trace._id)).collect()
        : [];
      const imp = trace?.traceImportId ? await ctx.db.get(trace.traceImportId) : null;
      return { status: trace?.status, stepCount: steps.length, source: imp?.source };
    });
    expect(persisted.status).toBe("ready");
    expect(persisted.stepCount).toBe(4);
    expect(persisted.source).toBe("otlp");

    // Idempotent re-POST.
    const again = await (await post()).json();
    expect(again.imported).toBe(0);
    expect(again.deduped).toBe(1);
    const traceCount = await t.run(async (ctx) => (await ctx.db.query("agentTraces").collect()).length);
    expect(traceCount).toBe(1);
  });

  test("missing or invalid token is rejected 401", async () => {
    const t = convexTest(schema);
    await seed(t);
    const noToken = await t.fetch("/otlp/v1/traces", { method: "POST", body: "{}" });
    expect(noToken.status).toBe(401);
    const badToken = await t.fetch("/otlp/v1/traces", {
      method: "POST",
      headers: { Authorization: "Bearer deadbeef" },
      body: "{}",
    });
    expect(badToken.status).toBe(401);
  });
});
