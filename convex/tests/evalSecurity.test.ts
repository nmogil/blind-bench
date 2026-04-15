/**
 * Blind Eval Security Test Suite
 *
 * Tests backend-enforceable security rules from UX Spec Section 10.
 *
 * FRONTEND-ONLY RULES (not testable via convex-test):
 * - Rule 1: Evaluator can only visit /eval/cycle/:token (React Router gate)
 * - Rule 3: Page title = "Evaluation — {project name}" (CycleEvalView.tsx)
 * - Rule 4: Breadcrumbs show only "Evaluation" (EvalLayout.tsx)
 * - Rule 5: Favicon is generic (index.html)
 * - Rule 6: Tooltips show only blind label (BlindLabelBadge.tsx)
 * - Rule 9: Copy produces plain text only (AnnotatedEditor.tsx)
 * - Rule 11: Share URL = /s/cycle/:token only (App.tsx routing)
 * - Rule 13: No metadata in DOM (component props — no data-* attributes)
 *
 * These should be verified via E2E tests or manual QA checklist.
 */

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
      status: "current",
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

// ---------------------------------------------------------------------------
// Original tests
// ---------------------------------------------------------------------------

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

});

// ---------------------------------------------------------------------------
// Evaluator denied from optimization functions
// ---------------------------------------------------------------------------

describe("Evaluator denied from optimization functions", () => {
  test("evaluator cannot call optimize.requestOptimization", async () => {
    const { ids, asEvaluator } = await seedTestEnv();
    await expect(
      asEvaluator.mutation(api.optimize.requestOptimization, {
        versionId: ids.versionId,
      }),
    ).rejects.toThrow("Permission denied");
  });

  test("evaluator cannot call optimize.listOptimizations", async () => {
    const { ids, asEvaluator } = await seedTestEnv();
    await expect(
      asEvaluator.query(api.optimize.listOptimizations, {
        versionId: ids.versionId,
      }),
    ).rejects.toThrow("Permission denied");
  });

  test("evaluator cannot call optimize.getActiveOptimization", async () => {
    const { ids, asEvaluator } = await seedTestEnv();
    await expect(
      asEvaluator.query(api.optimize.getActiveOptimization, {
        projectId: ids.projectId,
      }),
    ).rejects.toThrow("Permission denied");
  });

  test("evaluator cannot call optimize.countFeedbackForVersion", async () => {
    const { ids, asEvaluator } = await seedTestEnv();
    await expect(
      asEvaluator.query(api.optimize.countFeedbackForVersion, {
        versionId: ids.versionId,
      }),
    ).rejects.toThrow("Permission denied");
  });
});

// ---------------------------------------------------------------------------
// Evaluator denied from version management functions
// ---------------------------------------------------------------------------

describe("Evaluator denied from version management", () => {
  test("evaluator cannot call versions.create", async () => {
    const { ids, asEvaluator } = await seedTestEnv();
    await expect(
      asEvaluator.mutation(api.versions.create, {
        projectId: ids.projectId,
        userMessageTemplate: "test",
      }),
    ).rejects.toThrow("Permission denied");
  });

  test("evaluator cannot call versions.update", async () => {
    const { t, ids, asEvaluator } = await seedTestEnv();

    // Create a draft version that could theoretically be updated
    const draftVersionId = await t.run(async (ctx) => {
      return await ctx.db.insert("promptVersions", {
        projectId: ids.projectId,
        versionNumber: 2,
        userMessageTemplate: "Draft {{name}}",
        status: "draft",
        createdById: ids.editorUserId,
      });
    });

    await expect(
      asEvaluator.mutation(api.versions.update, {
        versionId: draftVersionId,
        userMessageTemplate: "Hacked",
      }),
    ).rejects.toThrow("Permission denied");
  });

  test("evaluator cannot call versions.deleteVersion", async () => {
    const { t, ids, asEvaluator } = await seedTestEnv();

    const draftVersionId = await t.run(async (ctx) => {
      return await ctx.db.insert("promptVersions", {
        projectId: ids.projectId,
        versionNumber: 3,
        userMessageTemplate: "Draft to delete {{name}}",
        status: "draft",
        createdById: ids.editorUserId,
      });
    });

    await expect(
      asEvaluator.mutation(api.versions.deleteVersion, {
        versionId: draftVersionId,
      }),
    ).rejects.toThrow("Permission denied");
  });

  test("evaluator cannot call versions.fork", async () => {
    const { ids, asEvaluator } = await seedTestEnv();

    await expect(
      asEvaluator.mutation(api.versions.fork, {
        sourceVersionId: ids.versionId,
      }),
    ).rejects.toThrow("Permission denied");
  });

  test("evaluator cannot call versions.archive", async () => {
    const { ids, asEvaluator } = await seedTestEnv();
    await expect(
      asEvaluator.mutation(api.versions.archive, {
        versionId: ids.versionId,
      }),
    ).rejects.toThrow("Permission denied");
  });

  test("evaluator cannot call versions.rollback", async () => {
    const { ids, asEvaluator } = await seedTestEnv();
    await expect(
      asEvaluator.mutation(api.versions.rollback, {
        versionId: ids.versionId,
      }),
    ).rejects.toThrow("Permission denied");
  });
});

// ---------------------------------------------------------------------------
// Evaluator denied from run execution functions
// ---------------------------------------------------------------------------

describe("Evaluator denied from run execution", () => {
  test("evaluator cannot call runs.execute", async () => {
    const { ids, asEvaluator } = await seedTestEnv();
    await expect(
      asEvaluator.mutation(api.runs.execute, {
        versionId: ids.versionId,
        testCaseId: ids.testCaseId,
        model: "openai/gpt-4",
        temperature: 0.7,
      }),
    ).rejects.toThrow("Permission denied");
  });

  test("evaluator cannot call runs.compareAcrossVersions", async () => {
    const { ids, asEvaluator } = await seedTestEnv();
    await expect(
      asEvaluator.query(api.runs.compareAcrossVersions, {
        projectId: ids.projectId,
        testCaseId: ids.testCaseId,
        versionIds: [ids.versionId, ids.versionId],
      }),
    ).rejects.toThrow("Permission denied");
  });

  test("evaluator cannot call runs.countInFlightRuns", async () => {
    const { ids, asEvaluator } = await seedTestEnv();
    await expect(
      asEvaluator.query(api.runs.countInFlightRuns, {
        projectId: ids.projectId,
      }),
    ).rejects.toThrow("Permission denied");
  });
});

// ---------------------------------------------------------------------------
// Evaluator denied from project settings
// ---------------------------------------------------------------------------

describe("Evaluator denied from project settings", () => {
  test("evaluator cannot call projects.update", async () => {
    const { ids, asEvaluator } = await seedTestEnv();
    await expect(
      asEvaluator.mutation(api.projects.update, {
        projectId: ids.projectId,
        name: "Hacked",
      }),
    ).rejects.toThrow("Permission denied");
  });

  test("evaluator cannot call projects.deleteProject", async () => {
    const { ids, asEvaluator } = await seedTestEnv();
    await expect(
      asEvaluator.mutation(api.projects.deleteProject, {
        projectId: ids.projectId,
      }),
    ).rejects.toThrow("Permission denied");
  });

  test("evaluator cannot call projects.inviteCollaborator", async () => {
    const { ids, asEvaluator } = await seedTestEnv();
    await expect(
      asEvaluator.mutation(api.projects.inviteCollaborator, {
        projectId: ids.projectId,
        userId: ids.evaluatorUserId,
        role: "evaluator",
      }),
    ).rejects.toThrow("Permission denied");
  });

  test("evaluator cannot call projects.updateCollaboratorRole", async () => {
    const { ids, asEvaluator } = await seedTestEnv();
    await expect(
      asEvaluator.mutation(api.projects.updateCollaboratorRole, {
        projectId: ids.projectId,
        userId: ids.evaluatorUserId,
        role: "editor",
      }),
    ).rejects.toThrow("Permission denied");
  });

  test("evaluator cannot call projects.removeCollaborator", async () => {
    const { ids, asEvaluator } = await seedTestEnv();
    await expect(
      asEvaluator.mutation(api.projects.removeCollaborator, {
        projectId: ids.projectId,
        userId: ids.editorUserId,
      }),
    ).rejects.toThrow("Permission denied");
  });

  test("evaluator cannot call projects.getMetaContext", async () => {
    const { ids, asEvaluator } = await seedTestEnv();
    await expect(
      asEvaluator.query(api.projects.getMetaContext, {
        projectId: ids.projectId,
      }),
    ).rejects.toThrow("Permission denied");
  });

  test("evaluator cannot call projects.setMetaContext", async () => {
    const { ids, asEvaluator } = await seedTestEnv();
    await expect(
      asEvaluator.mutation(api.projects.setMetaContext, {
        projectId: ids.projectId,
        metaContext: [],
      }),
    ).rejects.toThrow("Permission denied");
  });
});

// ---------------------------------------------------------------------------
// Evaluator denied from analytics
// ---------------------------------------------------------------------------

describe("Evaluator denied from analytics", () => {
  test("evaluator cannot call outputPreferences.aggregateForRun", async () => {
    const { ids, asEvaluator } = await seedTestEnv();
    await expect(
      asEvaluator.query(api.outputPreferences.aggregateForRun, {
        runId: ids.runId,
      }),
    ).rejects.toThrow("Permission denied");
  });

  test("evaluator cannot call analytics.getQualityTrend", async () => {
    const { ids, asEvaluator } = await seedTestEnv();
    await expect(
      asEvaluator.query(api.analytics.getQualityTrend, {
        projectId: ids.projectId,
      }),
    ).rejects.toThrow("Permission denied");
  });
});

// ---------------------------------------------------------------------------
// Evaluator denied from variables and test cases
// ---------------------------------------------------------------------------

describe("Evaluator denied from variables", () => {
  test("evaluator cannot call variables.list", async () => {
    const { ids, asEvaluator } = await seedTestEnv();
    await expect(
      asEvaluator.query(api.variables.list, {
        projectId: ids.projectId,
      }),
    ).rejects.toThrow("Permission denied");
  });

  test("evaluator cannot call variables.add", async () => {
    const { ids, asEvaluator } = await seedTestEnv();
    await expect(
      asEvaluator.mutation(api.variables.add, {
        projectId: ids.projectId,
        name: "x",
        required: false,
      }),
    ).rejects.toThrow("Permission denied");
  });
});

describe("Evaluator denied from test cases", () => {
  test("evaluator cannot call testCases.list", async () => {
    const { ids, asEvaluator } = await seedTestEnv();
    await expect(
      asEvaluator.query(api.testCases.list, {
        projectId: ids.projectId,
      }),
    ).rejects.toThrow("Permission denied");
  });

  test("evaluator cannot call testCases.create", async () => {
    const { ids, asEvaluator } = await seedTestEnv();
    await expect(
      asEvaluator.mutation(api.testCases.create, {
        projectId: ids.projectId,
        name: "x",
        variableValues: {},
      }),
    ).rejects.toThrow("Permission denied");
  });

  test("evaluator cannot call testCases.get", async () => {
    const { ids, asEvaluator } = await seedTestEnv();
    await expect(
      asEvaluator.query(api.testCases.get, {
        testCaseId: ids.testCaseId,
      }),
    ).rejects.toThrow("Permission denied");
  });
});

// ---------------------------------------------------------------------------
// Evaluator CAN access allowed functions
// ---------------------------------------------------------------------------

describe("Evaluator allowed functions", () => {
  test("evaluator CAN call projects.get (evaluator is allowed)", async () => {
    const { ids, asEvaluator } = await seedTestEnv();
    const result = await asEvaluator.query(api.projects.get, {
      projectId: ids.projectId,
    });
    expect(result).not.toBeNull();
    expect(result!.role).toBe("evaluator");
  });

  test("evaluator CAN call projects.listCollaborators", async () => {
    const { ids, asEvaluator } = await seedTestEnv();
    const result = await asEvaluator.query(api.projects.listCollaborators, {
      projectId: ids.projectId,
    });
    expect(result.length).toBeGreaterThan(0);
  });

});

// ---------------------------------------------------------------------------
// Unauthenticated user denied from authenticated endpoints
// ---------------------------------------------------------------------------

describe("Unauthenticated access denied", () => {
  test("unauthenticated user cannot call runs.get", async () => {
    const { t, ids } = await seedTestEnv();
    await expect(
      t.query(api.runs.get, { runId: ids.runId }),
    ).rejects.toThrow();
  });
});
