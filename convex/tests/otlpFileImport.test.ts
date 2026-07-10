/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";
import { mapOtlpToTraces } from "../lib/otelGenAI";

const attr = (key: string, value: string) => ({ key, value: { stringValue: value } });
const payload = {
  resourceSpans: [{
    scopeSpans: [{
      spans: [
        {
          traceId: "trace-import-1",
          spanId: "span-genai",
          startTimeUnixNano: "1000",
          attributes: [
            attr("gen_ai.request.model", "gpt-4.1"),
            attr("gen_ai.system", "openai"),
            attr("gen_ai.prompt", "Summarize this ticket"),
            attr("gen_ai.completion", "The customer needs a refund"),
          ],
        },
        {
          traceId: "trace-http-only",
          spanId: "span-http",
          startTimeUnixNano: "2000",
          attributes: [attr("http.request.method", "POST")],
        },
      ],
    }],
  }],
};

async function seed(t: ReturnType<typeof convexTest>) {
  const ids = await t.run(async (ctx) => {
    const ownerUserId = await ctx.db.insert("users", { name: "Owner", email: "owner@test.com" });
    const orgId = await ctx.db.insert("organizations", { name: "Org", slug: "org", createdById: ownerUserId });
    await ctx.db.insert("organizationMembers", { organizationId: orgId, userId: ownerUserId, role: "owner" });
    const projectId = await ctx.db.insert("projects", { organizationId: orgId, name: "P", createdById: ownerUserId });
    await ctx.db.insert("projectCollaborators", { projectId, userId: ownerUserId, role: "owner", invitedById: ownerUserId, invitedAt: Date.now() });
    return { ownerUserId, projectId };
  });
  return {
    ids,
    asOwner: t.withIdentity({ subject: `${ids.ownerUserId}|s`, tokenIdentifier: `test|${ids.ownerUserId}` }),
  };
}

describe("OTLP GenAI file mapping", () => {
  test("ignores ordinary non-GenAI spans instead of reporting a false-ready trace", () => {
    const result = mapOtlpToTraces(payload);
    expect(result.summary).toMatchObject({ traces: 1, spans: 1, ignoredSpans: 1, invalid: false });
    expect(result.traces[0]?.trace_id).toBe("otlp-trace-import-1");
  });

  test("plain HTTP telemetry maps zero traces and is not ready", () => {
    const plain = {
      resourceSpans: [{ scopeSpans: [{ spans: [{
        traceId: "plain",
        spanId: "http",
        attributes: [attr("http.request.method", "GET")],
      }] }] }],
    };
    const result = mapOtlpToTraces(plain);
    expect(result.traces).toHaveLength(0);
    expect(result.summary).toMatchObject({ traces: 0, spans: 0, ignoredSpans: 1, invalid: true });
  });
});

describe("authenticated OTLP JSON file import", () => {
  test("imports GenAI traces, retains raw provenance, and deduplicates retry", async () => {
    const t = convexTest(schema);
    const { ids, asOwner } = await seed(t);
    const json = JSON.stringify(payload);

    const first = await asOwner.action(api.otlpFileImport.importOtlpJson, {
      projectId: ids.projectId,
      json,
    });
    expect(first).toMatchObject({ imported: 1, deduped: 0, summary: { traces: 1, ignoredSpans: 1 } });

    const persisted = await t.run(async (ctx) => {
      const trace = await ctx.db.query("agentTraces").first();
      const imported = trace?.traceImportId ? await ctx.db.get(trace.traceImportId) : null;
      return { trace, imported };
    });
    expect(persisted.trace?.status).toBe("ready");
    expect(persisted.imported?.source).toBe("otlp");
    expect(persisted.imported?.rawPayloadStorageId).toBeDefined();

    const second = await asOwner.action(api.otlpFileImport.importOtlpJson, {
      projectId: ids.projectId,
      json,
    });
    expect(second).toMatchObject({ imported: 0, deduped: 1 });
  });

  test("rejects a file with no GenAI spans", async () => {
    const t = convexTest(schema);
    const { ids, asOwner } = await seed(t);
    await expect(asOwner.action(api.otlpFileImport.importOtlpJson, {
      projectId: ids.projectId,
      json: JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [{ traceId: "x", attributes: [] }] }] }] }),
    })).rejects.toThrow(/no genai spans/i);
  });
});
