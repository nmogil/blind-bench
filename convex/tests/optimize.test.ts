/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test, describe } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";

async function seedTestEnv() {
  const t = convexTest(schema);

  const ids = await t.run(async (ctx) => {
    const ownerUserId = await ctx.db.insert("users", {
      name: "Owner User",
      email: "owner@test.com",
    });
    const evaluatorUserId = await ctx.db.insert("users", {
      name: "Evaluator User",
      email: "evaluator@test.com",
    });
    const orgId = await ctx.db.insert("organizations", {
      name: "Test Org",
      slug: "test-org",
      createdById: ownerUserId,
    });
    await ctx.db.insert("organizationMembers", {
      organizationId: orgId,
      userId: ownerUserId,
      role: "owner",
    });
    const projectId = await ctx.db.insert("projects", {
      organizationId: orgId,
      name: "Test Project",
      createdById: ownerUserId,
      metaContext: [
        { id: "1", question: "What domain?", answer: "Testing" },
      ],
    });
    await ctx.db.insert("projectCollaborators", {
      projectId,
      userId: ownerUserId,
      role: "owner",
      invitedById: ownerUserId,
      invitedAt: Date.now(),
    });
    await ctx.db.insert("projectCollaborators", {
      projectId,
      userId: evaluatorUserId,
      role: "evaluator",
      invitedById: ownerUserId,
      invitedAt: Date.now(),
    });

    const versionId = await ctx.db.insert("promptVersions", {
      projectId,
      versionNumber: 1,
      systemMessage: "You are a helpful assistant.",
      userMessageTemplate: "Hello {{name}}, help with {{task}}.",
      status: "active",
      createdById: ownerUserId,
    });

    await ctx.db.insert("projectVariables", {
      projectId,
      name: "name",
      required: true,
      order: 0,
    });
    await ctx.db.insert("projectVariables", {
      projectId,
      name: "task",
      required: true,
      order: 1,
    });

    const testCaseId = await ctx.db.insert("testCases", {
      projectId,
      name: "Test Case 1",
      variableValues: { name: "World", task: "coding" },
      attachmentIds: [],
      order: 0,
      createdById: ownerUserId,
    });

    const runId = await ctx.db.insert("promptRuns", {
      projectId,
      promptVersionId: versionId,
      testCaseId,
      model: "openai/gpt-4",
      temperature: 0.7,
      status: "completed",
      completedAt: Date.now(),
      triggeredById: ownerUserId,
    });

    const outputAId = await ctx.db.insert("runOutputs", {
      runId,
      blindLabel: "A",
      outputContent: "Output content A - too formal",
    });

    return {
      ownerUserId,
      evaluatorUserId,
      orgId,
      projectId,
      versionId,
      testCaseId,
      runId,
      outputAId,
    };
  });

  const asOwner = t.withIdentity({
    subject: `${ids.ownerUserId}|test-session-owner`,
    tokenIdentifier: `test|${ids.ownerUserId}`,
  });
  const asEvaluator = t.withIdentity({
    subject: `${ids.evaluatorUserId}|test-session-evaluator`,
    tokenIdentifier: `test|${ids.evaluatorUserId}`,
  });

  return { t, ids, asOwner, asEvaluator };
}

async function seedWithFeedback() {
  const env = await seedTestEnv();

  await env.t.run(async (ctx) => {
    await ctx.db.insert("outputFeedback", {
      outputId: env.ids.outputAId,
      userId: env.ids.ownerUserId,
      annotationData: {
        from: 0,
        to: 10,
        highlightedText: "too formal",
        comment: "Make it casual",
      },
    });

    await ctx.db.insert("promptFeedback", {
      promptVersionId: env.ids.versionId,
      userId: env.ids.ownerUserId,
      targetField: "system_message",
      annotationData: {
        from: 0,
        to: 5,
        highlightedText: "You are",
        comment: "Be more specific",
      },
    });
  });

  return env;
}

describe("countFeedbackForVersion", () => {
  test("returns zero counts when no feedback exists", async () => {
    const { ids, asOwner } = await seedTestEnv();

    const result = await asOwner.query(
      api.optimize.countFeedbackForVersion,
      { versionId: ids.versionId },
    );

    expect(result.total).toBe(0);
    expect(result.outputFeedbackCount).toBe(0);
    expect(result.promptFeedbackCount).toBe(0);
  });

  test("counts feedback correctly", async () => {
    const { ids, asOwner } = await seedWithFeedback();

    const result = await asOwner.query(
      api.optimize.countFeedbackForVersion,
      { versionId: ids.versionId },
    );

    expect(result.outputFeedbackCount).toBe(1);
    expect(result.promptFeedbackCount).toBe(1);
    expect(result.total).toBe(2);
  });
});

describe("acceptOptimization", () => {
  test("creates a new version with correct fields", async () => {
    const { t, ids, asOwner } = await seedWithFeedback();

    const requestId = await t.run(async (ctx) => {
      return await ctx.db.insert("optimizationRequests", {
        projectId: ids.projectId,
        promptVersionId: ids.versionId,
        status: "completed",
        generatedSystemMessage: "Updated system message",
        generatedUserTemplate: "Updated {{name}}, {{task}}.",
        changesSummary: "- Updated greeting",
        changesReasoning: "Output A was too formal",
        optimizerModel: "anthropic/claude-sonnet-4",
        optimizerPromptVersion: "v0.1-placeholder",
        reviewStatus: "pending",
        requestedById: ids.ownerUserId,
      });
    });

    const newVersionId = await asOwner.mutation(
      api.optimize.acceptOptimization,
      { requestId },
    );

    const newVersion = await t.run(async (ctx) => {
      return await ctx.db.get(newVersionId);
    });

    expect(newVersion).not.toBeNull();
    expect(newVersion!.versionNumber).toBe(2);
    expect(newVersion!.parentVersionId).toBe(ids.versionId);
    expect(newVersion!.systemMessage).toBe("Updated system message");
    expect(newVersion!.userMessageTemplate).toBe("Updated {{name}}, {{task}}.");
    expect(newVersion!.status).toBe("draft");

    const request = await t.run(async (ctx) => {
      return await ctx.db.get(requestId);
    });
    expect(request!.reviewStatus).toBe("accepted");
    expect(request!.resultingVersionId).toBe(newVersionId);
  });
});

describe("rejectOptimization", () => {
  test("sets reviewStatus without creating a version", async () => {
    const { t, ids, asOwner } = await seedWithFeedback();

    const requestId = await t.run(async (ctx) => {
      return await ctx.db.insert("optimizationRequests", {
        projectId: ids.projectId,
        promptVersionId: ids.versionId,
        status: "completed",
        generatedSystemMessage: "Updated",
        generatedUserTemplate: "Updated {{name}}, {{task}}.",
        changesSummary: "- Updated",
        changesReasoning: "Output A feedback",
        optimizerModel: "anthropic/claude-sonnet-4",
        optimizerPromptVersion: "v0.1-placeholder",
        reviewStatus: "pending",
        requestedById: ids.ownerUserId,
      });
    });

    await asOwner.mutation(
      api.optimize.rejectOptimization,
      { requestId, reviewNotes: "Not good enough" },
    );

    const request = await t.run(async (ctx) => {
      return await ctx.db.get(requestId);
    });
    expect(request!.reviewStatus).toBe("rejected");
    expect(request!.reviewNotes).toBe("Not good enough");
    expect(request!.resultingVersionId).toBeUndefined();
  });
});

describe("editAndAcceptOptimization", () => {
  test("creates a version with user-edited content", async () => {
    const { t, ids, asOwner } = await seedWithFeedback();

    const requestId = await t.run(async (ctx) => {
      return await ctx.db.insert("optimizationRequests", {
        projectId: ids.projectId,
        promptVersionId: ids.versionId,
        status: "completed",
        generatedSystemMessage: "Generated system",
        generatedUserTemplate: "Generated {{name}}, {{task}}.",
        changesSummary: "- Changes",
        changesReasoning: "Output A feedback",
        optimizerModel: "anthropic/claude-sonnet-4",
        optimizerPromptVersion: "v0.1-placeholder",
        reviewStatus: "pending",
        requestedById: ids.ownerUserId,
      });
    });

    const newVersionId = await asOwner.mutation(
      api.optimize.editAndAcceptOptimization,
      {
        requestId,
        systemMessage: "My edited system message",
        userTemplate: "My edited {{name}}, {{task}}.",
      },
    );

    const newVersion = await t.run(async (ctx) => {
      return await ctx.db.get(newVersionId);
    });

    expect(newVersion!.systemMessage).toBe("My edited system message");
    expect(newVersion!.userMessageTemplate).toBe("My edited {{name}}, {{task}}.");

    const request = await t.run(async (ctx) => {
      return await ctx.db.get(requestId);
    });
    expect(request!.reviewStatus).toBe("edited");
  });
});

describe("cancelOptimization", () => {
  test("cancels a pending request", async () => {
    const { t, ids, asOwner } = await seedWithFeedback();

    const requestId = await t.run(async (ctx) => {
      return await ctx.db.insert("optimizationRequests", {
        projectId: ids.projectId,
        promptVersionId: ids.versionId,
        status: "pending",
        optimizerModel: "anthropic/claude-sonnet-4",
        optimizerPromptVersion: "v0.1-placeholder",
        requestedById: ids.ownerUserId,
      });
    });

    await asOwner.mutation(
      api.optimize.cancelOptimization,
      { requestId },
    );

    const request = await t.run(async (ctx) => {
      return await ctx.db.get(requestId);
    });
    expect(request!.status).toBe("failed");
    expect(request!.errorMessage).toBe("Cancelled by user.");
  });
});

describe("evaluator access control", () => {
  test("evaluator cannot call countFeedbackForVersion", async () => {
    const { ids, asEvaluator } = await seedWithFeedback();
    await expect(
      asEvaluator.query(api.optimize.countFeedbackForVersion, {
        versionId: ids.versionId,
      }),
    ).rejects.toThrow("Permission denied");
  });

  test("evaluator cannot call getOptimization", async () => {
    const { t, ids, asEvaluator } = await seedWithFeedback();

    const requestId = await t.run(async (ctx) => {
      return await ctx.db.insert("optimizationRequests", {
        projectId: ids.projectId,
        promptVersionId: ids.versionId,
        status: "completed",
        generatedUserTemplate: "Test {{name}}, {{task}}.",
        changesSummary: "- Test",
        changesReasoning: "Output A",
        optimizerModel: "anthropic/claude-sonnet-4",
        optimizerPromptVersion: "v0.1-placeholder",
        reviewStatus: "pending",
        requestedById: ids.ownerUserId,
      });
    });

    await expect(
      asEvaluator.query(api.optimize.getOptimization, { requestId }),
    ).rejects.toThrow("Permission denied");
  });
});

describe("internal mutations", () => {
  test("completeOptimization sets status and reviewStatus", async () => {
    const { t, ids } = await seedTestEnv();

    const requestId = await t.run(async (ctx) => {
      return await ctx.db.insert("optimizationRequests", {
        projectId: ids.projectId,
        promptVersionId: ids.versionId,
        status: "processing",
        optimizerModel: "anthropic/claude-sonnet-4",
        optimizerPromptVersion: "v0.1-placeholder",
        requestedById: ids.ownerUserId,
      });
    });

    await t.mutation(internal.optimize.completeOptimization, {
      requestId,
      generatedSystemMessage: "New system",
      generatedUserTemplate: "New {{name}}, {{task}}.",
      changesSummary: "- Changes",
      changesReasoning: "Because A said so",
    });

    const request = await t.run(async (ctx) => {
      return await ctx.db.get(requestId);
    });
    expect(request!.status).toBe("completed");
    expect(request!.reviewStatus).toBe("pending");
    expect(request!.generatedUserTemplate).toBe("New {{name}}, {{task}}.");
  });

  test("failOptimization sets error message", async () => {
    const { t, ids } = await seedTestEnv();

    const requestId = await t.run(async (ctx) => {
      return await ctx.db.insert("optimizationRequests", {
        projectId: ids.projectId,
        promptVersionId: ids.versionId,
        status: "processing",
        optimizerModel: "anthropic/claude-sonnet-4",
        optimizerPromptVersion: "v0.1-placeholder",
        requestedById: ids.ownerUserId,
      });
    });

    await t.mutation(internal.optimize.failOptimization, {
      requestId,
      errorMessage: "The optimizer returned malformed output.",
    });

    const request = await t.run(async (ctx) => {
      return await ctx.db.get(requestId);
    });
    expect(request!.status).toBe("failed");
    expect(request!.errorMessage).toBe("The optimizer returned malformed output.");
  });
});
