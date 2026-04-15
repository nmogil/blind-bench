import { convexTest } from "convex-test";
import { expect, test, describe } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

async function seedFeedbackEnv() {
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
    const otherUserId = await ctx.db.insert("users", {
      name: "Other User",
      email: "other@test.com",
    });
    const orgId = await ctx.db.insert("organizations", {
      name: "Test Org",
      slug: "test-org",
      createdById: ownerUserId,
    });
    const projectId = await ctx.db.insert("projects", {
      organizationId: orgId,
      name: "Test Project",
      createdById: ownerUserId,
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
    await ctx.db.insert("projectCollaborators", {
      projectId,
      userId: otherUserId,
      role: "editor",
      invitedById: ownerUserId,
      invitedAt: Date.now(),
    });

    const versionId = await ctx.db.insert("promptVersions", {
      projectId,
      versionNumber: 1,
      userMessageTemplate: "Hello {{name}}",
      status: "current",
      createdById: ownerUserId,
    });
    const runId = await ctx.db.insert("promptRuns", {
      projectId,
      promptVersionId: versionId,
      testCaseId: await ctx.db.insert("testCases", {
        projectId,
        name: "TC1",
        variableValues: {},
        attachmentIds: [],
        order: 0,
        createdById: ownerUserId,
      }),
      model: "openai/gpt-4",
      temperature: 0.7,
      status: "completed",
      completedAt: Date.now(),
      triggeredById: ownerUserId,
    });
    const outputId = await ctx.db.insert("runOutputs", {
      runId,
      blindLabel: "A",
      outputContent: "Hello World! This is a test output.",
    });

    return {
      ownerUserId,
      evaluatorUserId,
      otherUserId,
      orgId,
      projectId,
      versionId,
      runId,
      outputId,
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
  const asOther = t.withIdentity({
    subject: `${ids.otherUserId}|test-session-other`,
    tokenIdentifier: `test|${ids.otherUserId}`,
  });

  return { t, ids, asOwner, asEvaluator, asOther };
}

describe("Feedback Permissions", () => {
  test("evaluator cannot create prompt feedback", async () => {
    const { ids, asEvaluator } = await seedFeedbackEnv();
    await expect(
      asEvaluator.mutation(api.feedback.addPromptFeedback, {
        promptVersionId: ids.versionId,
        targetField: "system_message",
        annotationData: {
          from: 0,
          to: 5,
          highlightedText: "Hello",
          comment: "Test",
        },
      }),
    ).rejects.toThrow("Permission denied");
  });

  test("non-author cannot update another user's feedback", async () => {
    const { ids, asOwner, asOther } = await seedFeedbackEnv();

    // Owner creates feedback
    const feedbackId = await asOwner.mutation(api.feedback.addOutputFeedback, {
      outputId: ids.outputId,
      annotationData: {
        from: 0,
        to: 5,
        highlightedText: "Hello",
        comment: "Original",
      },
    });

    // Other user tries to update it
    await expect(
      asOther.mutation(api.feedback.updateOutputFeedback, {
        feedbackId,
        comment: "Hacked!",
      }),
    ).rejects.toThrow("Permission denied");
  });

  test("author can update own feedback", async () => {
    const { ids, asOwner } = await seedFeedbackEnv();

    const feedbackId = await asOwner.mutation(api.feedback.addOutputFeedback, {
      outputId: ids.outputId,
      annotationData: {
        from: 0,
        to: 5,
        highlightedText: "Hello",
        comment: "Original",
      },
    });

    // Author updates their own feedback
    await asOwner.mutation(api.feedback.updateOutputFeedback, {
      feedbackId,
      comment: "Updated comment",
    });

    // Verify update
    const feedback = await asOwner.query(api.feedback.listOutputFeedback, {
      outputId: ids.outputId,
    });
    const updated = feedback.find((f) => f._id === feedbackId);
    expect(updated?.annotationData.comment).toBe("Updated comment");
  });

  test("author can delete own feedback", async () => {
    const { ids, asOwner } = await seedFeedbackEnv();

    const feedbackId = await asOwner.mutation(api.feedback.addOutputFeedback, {
      outputId: ids.outputId,
      annotationData: {
        from: 6,
        to: 11,
        highlightedText: "World",
        comment: "To delete",
      },
    });

    await asOwner.mutation(api.feedback.deleteOutputFeedback, { feedbackId });

    const feedback = await asOwner.query(api.feedback.listOutputFeedback, {
      outputId: ids.outputId,
    });
    expect(feedback.find((f) => f._id === feedbackId)).toBeUndefined();
  });
});
