import { convexTest } from "convex-test";
import { expect, test, describe } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

// Helper to create a seeded test environment with editor + evaluator users
async function seedTestEnv() {
  const t = convexTest(schema);

  // Seed users, org, project, collaborators, version, test case, run, outputs
  const ids = await t.run(async (ctx) => {
    const editorUserId = await ctx.db.insert("users", {
      name: "Editor User",
      email: "editor@test.com",
    });
    const evaluatorUserId = await ctx.db.insert("users", {
      name: "Evaluator User",
      email: "evaluator@test.com",
    });
    const orgId = await ctx.db.insert("organizations", {
      name: "Test Org",
      slug: "test-org",
      createdById: editorUserId,
    });
    await ctx.db.insert("organizationMembers", {
      organizationId: orgId,
      userId: editorUserId,
      role: "owner",
    });
    const projectId = await ctx.db.insert("projects", {
      organizationId: orgId,
      name: "Test Project",
      createdById: editorUserId,
    });
    await ctx.db.insert("projectCollaborators", {
      projectId,
      userId: editorUserId,
      role: "editor",
      invitedById: editorUserId,
      invitedAt: Date.now(),
    });
    await ctx.db.insert("projectCollaborators", {
      projectId,
      userId: evaluatorUserId,
      role: "evaluator",
      invitedById: editorUserId,
      invitedAt: Date.now(),
    });
    const versionId = await ctx.db.insert("promptVersions", {
      projectId,
      versionNumber: 1,
      userMessageTemplate: "Hello {{name}}",
      status: "active",
      createdById: editorUserId,
    });
    const testCaseId = await ctx.db.insert("testCases", {
      projectId,
      name: "Test Case 1",
      variableValues: { name: "World" },
      attachmentIds: [],
      order: 0,
      createdById: editorUserId,
    });
    const runId = await ctx.db.insert("promptRuns", {
      projectId,
      promptVersionId: versionId,
      testCaseId,
      model: "openai/gpt-4",
      temperature: 0.7,
      status: "completed",
      completedAt: Date.now(),
      triggeredById: editorUserId,
    });
    const outputAId = await ctx.db.insert("runOutputs", {
      runId,
      blindLabel: "A",
      outputContent: "Output content A",
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      latencyMs: 1200,
    });
    const outputBId = await ctx.db.insert("runOutputs", {
      runId,
      blindLabel: "B",
      outputContent: "Output content B",
      promptTokens: 100,
      completionTokens: 60,
      totalTokens: 160,
      latencyMs: 1300,
    });
    const outputCId = await ctx.db.insert("runOutputs", {
      runId,
      blindLabel: "C",
      outputContent: "Output content C",
      promptTokens: 100,
      completionTokens: 55,
      totalTokens: 155,
      latencyMs: 1100,
    });

    // Mint eval token for this run
    const tokenBytes = new Uint8Array(16);
    crypto.getRandomValues(tokenBytes);
    const token = Array.from(tokenBytes, (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    await ctx.db.insert("evalTokens", {
      token,
      runId,
      projectId,
      expiresAt: Date.now() + 3600000,
    });

    return {
      editorUserId,
      evaluatorUserId,
      orgId,
      projectId,
      versionId,
      testCaseId,
      runId,
      outputAId,
      outputBId,
      outputCId,
      token,
    };
  });

  const asEditor = t.withIdentity({
    subject: `${ids.editorUserId}|test-session-editor`,
    tokenIdentifier: `test|${ids.editorUserId}`,
  });
  const asEvaluator = t.withIdentity({
    subject: `${ids.evaluatorUserId}|test-session-evaluator`,
    tokenIdentifier: `test|${ids.evaluatorUserId}`,
  });

  return { t, ids, asEditor, asEvaluator };
}

describe("Blind Eval Security", () => {
  test("evaluator cannot call runs.get", async () => {
    const { ids, asEvaluator } = await seedTestEnv();
    await expect(
      asEvaluator.query(api.runs.get, { runId: ids.runId }),
    ).rejects.toThrow("Permission denied");
  });

  test("evaluator cannot call runs.list", async () => {
    const { ids, asEvaluator } = await seedTestEnv();
    await expect(
      asEvaluator.query(api.runs.list, { versionId: ids.versionId }),
    ).rejects.toThrow("Permission denied");
  });

  test("evaluator cannot call versions.get", async () => {
    const { ids, asEvaluator } = await seedTestEnv();
    await expect(
      asEvaluator.query(api.versions.get, { versionId: ids.versionId }),
    ).rejects.toThrow("Permission denied");
  });

  test("evaluator cannot call versions.list", async () => {
    const { ids, asEvaluator } = await seedTestEnv();
    await expect(
      asEvaluator.query(api.versions.list, { projectId: ids.projectId }),
    ).rejects.toThrow("Permission denied");
  });

  test("getOutputsForEvaluator returns only blindLabel, outputContent, annotations", async () => {
    const { ids, asEvaluator } = await seedTestEnv();
    const result = await asEvaluator.query(api.runs.getOutputsForEvaluator, {
      opaqueToken: ids.token,
    });

    expect(result).toHaveProperty("projectName");
    expect(result).toHaveProperty("outputs");
    expect(result.outputs).toHaveLength(3);

    for (const output of result.outputs) {
      // Must have only these fields
      const keys = Object.keys(output);
      expect(keys).toEqual(
        expect.arrayContaining(["blindLabel", "outputContent", "annotations"]),
      );
      // Must NOT have these fields
      expect(output).not.toHaveProperty("_id");
      expect(output).not.toHaveProperty("runId");
      expect(output).not.toHaveProperty("promptTokens");
      expect(output).not.toHaveProperty("completionTokens");
      expect(output).not.toHaveProperty("totalTokens");
      expect(output).not.toHaveProperty("latencyMs");
      expect(output).not.toHaveProperty("rawResponseStorageId");
    }
  });

  test("getOutputsForEvaluator rejects non-evaluator (editor)", async () => {
    const { ids, asEditor } = await seedTestEnv();
    await expect(
      asEditor.query(api.runs.getOutputsForEvaluator, {
        opaqueToken: ids.token,
      }),
    ).rejects.toThrow("Permission denied");
  });

  test("listMyInbox returns no runId or versionId", async () => {
    const { asEvaluator } = await seedTestEnv();
    const inbox = await asEvaluator.query(api.evaluatorInbox.listMyInbox);

    expect(inbox.length).toBeGreaterThan(0);
    for (const item of inbox) {
      expect(item).not.toHaveProperty("runId");
      expect(item).not.toHaveProperty("versionId");
      expect(item).not.toHaveProperty("model");
      expect(item).not.toHaveProperty("testCaseName");
      expect(item).toHaveProperty("opaqueToken");
      expect(item).toHaveProperty("projectName");
    }
  });

  test("invalid eval token throws error", async () => {
    const { asEvaluator } = await seedTestEnv();
    await expect(
      asEvaluator.query(api.runs.getOutputsForEvaluator, {
        opaqueToken: "invalid-fake-token-12345",
      }),
    ).rejects.toThrow("Invalid eval token");
  });

  test("eval token does not contain runId or projectId", async () => {
    const { ids } = await seedTestEnv();
    // Convex IDs contain alphanumeric chars. The token is hex-only.
    // Verify token doesn't contain the run or project ID as substrings.
    expect(ids.token).not.toContain(ids.runId);
    expect(ids.token).not.toContain(ids.projectId);
    // Also check that the token is pure hex (no Convex ID patterns)
    expect(ids.token).toMatch(/^[0-9a-f]{32}$/);
  });
});
