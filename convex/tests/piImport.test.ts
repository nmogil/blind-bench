/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";
import { parsePiSession } from "../lib/piTrace";

const SESSION_ID = "11111111-2222-3333-4444-555555555555";

const entries: ReadonlyArray<unknown> = [
  { type: "session", version: 3, id: SESSION_ID, timestamp: "2026-07-10T10:00:00.000Z", cwd: "/work/blind-bench" },
  { type: "message", id: "u1", parentId: null, timestamp: "2026-07-10T10:00:01.000Z", message: { role: "user", content: "Review the importer." } },
  {
    type: "message",
    id: "a1",
    parentId: "u1",
    timestamp: "2026-07-10T10:00:02.000Z",
    message: {
      role: "assistant",
      provider: "anthropic",
      model: "claude-sonnet-4-7",
      content: [
        { type: "thinking", thinking: "I should inspect the parser." },
        { type: "text", text: "I will read the file." },
        { type: "toolCall", id: "call-1", name: "read", arguments: { path: "convex/import.ts", secret_token: "DO-NOT-SHOW" } },
      ],
      usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 0, totalTokens: 125, cost: { total: 0.01 } },
      stopReason: "toolUse",
      timestamp: 1783677602000,
    },
  },
  {
    type: "message",
    id: "r1",
    parentId: "a1",
    timestamp: "2026-07-10T10:00:03.000Z",
    message: {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [{ type: "text", text: "export const importer = true;" }],
      isError: false,
      timestamp: 1783677603000,
    },
  },
  // An abandoned branch must not interleave with the active path.
  { type: "message", id: "alt-u", parentId: "u1", timestamp: "2026-07-10T10:00:03.500Z", message: { role: "user", content: "Ignore the importer." } },
  { type: "message", id: "alt-a", parentId: "alt-u", timestamp: "2026-07-10T10:00:04.000Z", message: { role: "assistant", provider: "openai", model: "gpt-alt", content: [{ type: "text", text: "Abandoned answer" }], usage: { totalTokens: 999, cost: { total: 9 } }, stopReason: "stop", timestamp: 1783677604000 } },
  { type: "model_change", id: "m1", parentId: "r1", timestamp: "2026-07-10T10:00:05.000Z", provider: "anthropic", modelId: "claude-opus-4-7" },
  { type: "compaction", id: "c1", parentId: "m1", timestamp: "2026-07-10T10:00:06.000Z", summary: "Earlier work summarized", firstKeptEntryId: "r1", tokensBefore: 50000 },
  { type: "message", id: "a2", parentId: "c1", timestamp: "2026-07-10T10:00:07.000Z", message: { role: "assistant", provider: "anthropic", model: "claude-opus-4-7", content: [{ type: "text", text: "The importer is ready for review." }], usage: { totalTokens: 40, cost: { total: 0.02 } }, stopReason: "stop", timestamp: 1783677607000 } },
];

const jsonl = entries.map((entry) => JSON.stringify(entry)).join("\n");

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

describe("Pi session JSONL parser", () => {
  test("normalizes only the active tree path with messages, tools, usage, and compaction", () => {
    const result = parsePiSession(jsonl);

    expect(result.sessionId).toBe(SESSION_ID);
    expect(result.trace.trace_id).toBe(`pi-${SESSION_ID}`);
    expect(result.trace.harness).toEqual({ name: "pi", version: "3", sdk: "pi_session_jsonl" });
    expect(result.trace.model).toBe("claude-opus-4-7");
    expect(result.trace.final_answer).toBe("The importer is ready for review.");
    expect(result.trace.usage.total_tokens).toBe(165);
    expect(result.trace.usage.cost_usd).toBeCloseTo(0.03);
    expect(result.summary.branchesExcluded).toBe(2);
    expect(result.summary.compactions).toBe(1);
    expect(result.summary.activeEntries).toBe(6);
    expect(JSON.stringify(result.trace)).not.toContain("Abandoned answer");
    expect(JSON.stringify(result.trace)).not.toContain("gpt-alt");
    expect(result.trace.steps.map((step) => step.type)).toEqual([
      "message",
      "message",
      "message",
      "tool_call",
      "tool_result",
      "state",
      "policy_event",
      "message",
    ]);
    const toolCall = result.trace.steps.find((step) => step.type === "tool_call");
    expect(toolCall?.type === "tool_call" ? toolCall.redacted_args : {}).toEqual({
      path: "convex/import.ts",
      secret_token: "[REDACTED]",
    });
  });

  test("rejects a session whose active path has a missing parent", () => {
    const broken = `${jsonl}\n${JSON.stringify({ type: "message", id: "bad", parentId: "missing", timestamp: "2026-07-10T10:00:08.000Z", message: { role: "user", content: "broken" } })}`;
    expect(() => parsePiSession(broken)).toThrow(/missing parent/i);
  });
});

describe("Pi session import through the trajectory spine", () => {
  test("persists one trace, stores provenance, and deduplicates re-upload", async () => {
    const t = convexTest(schema);
    const { ids, asOwner } = await seed(t);

    const first = await asOwner.action(api.piImport.importPiSession, {
      projectId: ids.projectId,
      jsonl,
    });
    expect(first.deduped).toBe(false);
    expect(first.summary.steps).toBe(8);

    const persisted = await t.run(async (ctx) => {
      const trace = await ctx.db.query("agentTraces").first();
      const imported = trace?.traceImportId ? await ctx.db.get(trace.traceImportId) : null;
      return { trace, imported };
    });
    expect(persisted.trace?.status).toBe("ready");
    expect(persisted.imported?.source).toBe("pi");
    expect(persisted.imported?.rawPayloadStorageId).toBeDefined();

    const second = await asOwner.action(api.piImport.importPiSession, {
      projectId: ids.projectId,
      jsonl,
    });
    expect(second.deduped).toBe(true);
    expect(await t.run(async (ctx) => (await ctx.db.query("agentTraces").collect()).length)).toBe(1);
  });
});
