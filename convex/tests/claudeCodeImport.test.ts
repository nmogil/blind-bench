/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";
import { parseClaudeCodeSession } from "../lib/claudeCodeTrace";

const SID = "0f0e02b8-1111-2222-3333-444455556666";
const U = (usage: Record<string, number>) => usage;

// Faithful CC 2.1.x fixture: one streamed assistant message split across two
// lines (same message.id, repeated usage), a tool result with structured
// toolUseResult, an isMeta caveat, a system hook, a mode sidecar, a dropped
// family-B record, and one malformed line.
const lines: unknown[] = [
  { type: "user", uuid: "u1", parentUuid: null, sessionId: SID, timestamp: "2026-07-07T10:00:00Z", isMeta: false, message: { role: "user", content: "Review the open PR." } },
  { type: "assistant", uuid: "a1", parentUuid: "u1", sessionId: SID, timestamp: "2026-07-07T10:00:01Z", message: { id: "m1", role: "assistant", model: "claude-opus-4-8", content: [{ type: "text", text: "Let me look." }], usage: U({ input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10 }) } },
  { type: "assistant", uuid: "a2", parentUuid: "a1", sessionId: SID, timestamp: "2026-07-07T10:00:02Z", message: { id: "m1", role: "assistant", model: "claude-opus-4-8", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "gh pr view 66", ssn: "123-45-6789" } }], usage: U({ input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10 }) } },
  { type: "user", uuid: "u2", parentUuid: "a2", sessionId: SID, timestamp: "2026-07-07T10:00:03Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "PR #66 open", is_error: false }] }, toolUseResult: { stdout: "PR #66 open", secret_token: "TOKEN-DO-NOT-SHOW" } },
  { type: "user", uuid: "u3", parentUuid: "u2", sessionId: SID, timestamp: "2026-07-07T10:00:04Z", isMeta: true, message: { role: "user", content: "<caveat>injected system text</caveat>" } },
  { type: "system", uuid: "s1", parentUuid: "u3", sessionId: SID, timestamp: "2026-07-07T10:00:05Z", subtype: "local_command", level: "info", content: "" },
  { type: "mode", mode: "normal", sessionId: SID },
  { type: "ai-title", aiTitle: "Review the open PR", sessionId: SID },
  { type: "assistant", uuid: "a3", parentUuid: "u2", sessionId: SID, timestamp: "2026-07-07T10:00:06Z", message: { id: "m2", role: "assistant", model: "claude-opus-4-8", content: [{ type: "text", text: "The PR looks good." }], usage: U({ input_tokens: 200, output_tokens: 80 }) } },
];
const jsonl = lines.map((l) => JSON.stringify(l)).join("\n") + "\n{ this is not valid json\n";

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

describe("#265 Claude Code JSONL parser (pure)", () => {
  const { trace, summary, sessionId } = parseClaudeCodeSession(jsonl);

  test("session identity + malformed/meta accounting", () => {
    expect(sessionId).toBe(SID);
    expect(trace.trace_id).toBe(`cc-${SID}`);
    expect(summary.invalid).toBe(1); // the malformed trailing line
    expect(summary.droppedMeta).toBe(1); // ai-title family-B record
    expect(summary.mergedMessages).toBe(1); // a2 merged into a1
    expect(trace.harness.name).toBe("claude_code");
    expect(trace.model).toBe("claude-opus-4-8");
  });

  test("streamed multi-line message merges; usage counted once per message.id", () => {
    // m1 (160) counted ONCE despite 2 lines, + m2 (280) = 440. Summing per line
    // would give 600.
    expect(trace.usage.total_tokens).toBe(440);
  });

  test("maps blocks to ordered steps with the right kinds", () => {
    const kinds = trace.steps.map((s) => s.type);
    expect(kinds).toEqual([
      "message", // u1 user prompt
      "message", // m1 merged text
      "tool_call", // m1 Bash
      "tool_result", // u2 result
      "policy_event", // u3 isMeta caveat
      "policy_event", // s1 system hook
      "state", // mode
      "message", // a3 final answer
    ]);
    const bash = trace.steps.find((s) => s.type === "tool_call");
    expect(bash && bash.type === "tool_call" && bash.name).toBe("Bash");
    // redaction precomputed for the blind body
    const redacted = bash && bash.type === "tool_call" ? JSON.stringify(bash.redacted_args) : "";
    expect(redacted).toContain("[REDACTED]");
    expect(redacted).not.toContain("123-45-6789");
    expect(trace.final_answer).toContain("looks good");
  });
});

describe("#265 import end-to-end through the spine", () => {
  test("imports and renders as ordered steps via the paginated query; re-upload dedups", async () => {
    const t = convexTest(schema);
    const { ids, asOwner } = await seed(t);

    const res = await asOwner.action(api.claudeCodeImport.importClaudeCodeSession, {
      projectId: ids.projectId,
      jsonl,
    });
    expect(res.deduped).toBe(false);
    expect(res.summary.steps).toBe(8);

    // Paginated read — ordered steps, no full-trace subscription.
    const page = await asOwner.query(api.agentTraces.listSteps, {
      agentTraceId: (await firstTraceId(t))!,
      paginationOpts: { numItems: 50, cursor: null },
    });
    expect(page.page.map((s) => s.kind)).toEqual([
      "message", "message", "tool_call", "tool_result", "policy_event", "policy_event", "state", "message",
    ]);
    expect(page.page.find((s) => s.kind === "tool_call")?.toolName).toBe("Bash");

    // Provenance recorded: a claude_code traceImport linked to the trace.
    const linked = await t.run(async (ctx) => {
      const trace = await ctx.db.query("agentTraces").first();
      const imp = trace?.traceImportId ? await ctx.db.get(trace.traceImportId) : null;
      return { source: imp?.source, hasRaw: !!imp?.rawPayloadStorageId };
    });
    expect(linked.source).toBe("claude_code");
    expect(linked.hasRaw).toBe(true);

    // Idempotent re-upload.
    const again = await asOwner.action(api.claudeCodeImport.importClaudeCodeSession, {
      projectId: ids.projectId,
      jsonl,
    });
    expect(again.deduped).toBe(true);
    const traceCount = await t.run(async (ctx) => (await ctx.db.query("agentTraces").collect()).length);
    expect(traceCount).toBe(1);
  });
});

async function firstTraceId(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => (await ctx.db.query("agentTraces").first())?._id);
}
