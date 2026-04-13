import { defineSchema, defineTable } from "convex/server";
import { authTables } from "@convex-dev/auth/server";
import { v } from "convex/values";

const schema = defineSchema({
  ...authTables,

  // M1: Organizations & Projects
  organizations: defineTable({
    name: v.string(),
    slug: v.string(),
    logoUrl: v.optional(v.string()),
    createdById: v.id("users"),
  }).index("by_slug", ["slug"]),

  organizationMembers: defineTable({
    organizationId: v.id("organizations"),
    userId: v.id("users"),
    role: v.union(
      v.literal("owner"),
      v.literal("admin"),
      v.literal("member"),
    ),
  })
    .index("by_org", ["organizationId"])
    .index("by_user", ["userId"])
    .index("by_org_and_user", ["organizationId", "userId"]),

  projects: defineTable({
    organizationId: v.id("organizations"),
    name: v.string(),
    description: v.optional(v.string()),
    createdById: v.id("users"),
    metaContext: v.optional(
      v.array(
        v.object({
          id: v.string(),
          question: v.string(),
          answer: v.string(),
        }),
      ),
    ),
  }).index("by_org", ["organizationId"]),

  projectCollaborators: defineTable({
    projectId: v.id("projects"),
    userId: v.id("users"),
    role: v.union(
      v.literal("owner"),
      v.literal("editor"),
      v.literal("evaluator"),
    ),
    invitedById: v.id("users"),
    invitedAt: v.number(),
    acceptedAt: v.optional(v.number()),
  })
    .index("by_project", ["projectId"])
    .index("by_user", ["userId"])
    .index("by_project_and_user", ["projectId", "userId"]),

  // M2: Variables
  projectVariables: defineTable({
    projectId: v.id("projects"),
    name: v.string(),
    description: v.optional(v.string()),
    defaultValue: v.optional(v.string()),
    required: v.boolean(),
    order: v.number(),
  }).index("by_project", ["projectId"]),

  // M2: Test Cases
  testCases: defineTable({
    projectId: v.id("projects"),
    name: v.string(),
    variableValues: v.record(v.string(), v.string()),
    attachmentIds: v.array(v.id("_storage")),
    order: v.number(),
    createdById: v.id("users"),
  }).index("by_project", ["projectId"]),

  // M2: Prompt Versions & Attachments
  promptVersions: defineTable({
    projectId: v.id("projects"),
    versionNumber: v.number(),
    systemMessage: v.optional(v.string()),
    userMessageTemplate: v.string(),
    parentVersionId: v.optional(v.id("promptVersions")),
    sourceVersionId: v.optional(v.id("promptVersions")),
    status: v.union(
      v.literal("draft"),
      v.literal("active"),
      v.literal("archived"),
    ),
    createdById: v.id("users"),
  }).index("by_project", ["projectId"]),

  promptAttachments: defineTable({
    promptVersionId: v.id("promptVersions"),
    storageId: v.id("_storage"),
    filename: v.string(),
    mimeType: v.string(),
    sizeBytes: v.number(),
    order: v.number(),
  }).index("by_version", ["promptVersionId"]),

  // M3: BYOK + Run Execution
  openRouterKeys: defineTable({
    organizationId: v.id("organizations"),
    encryptedKey: v.string(),
    lastRotatedAt: v.number(),
    createdById: v.id("users"),
  }).index("by_org", ["organizationId"]),

  promptRuns: defineTable({
    projectId: v.id("projects"),
    promptVersionId: v.id("promptVersions"),
    testCaseId: v.id("testCases"),
    model: v.string(),
    temperature: v.number(),
    maxTokens: v.optional(v.number()),
    // M8: per-slot configuration
    mode: v.optional(v.union(v.literal("uniform"), v.literal("mix"))),
    slotConfigs: v.optional(
      v.array(
        v.object({
          label: v.string(),
          model: v.string(),
          temperature: v.number(),
        }),
      ),
    ),
    status: v.union(
      v.literal("pending"),
      v.literal("running"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    startedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    errorMessage: v.optional(v.string()),
    triggeredById: v.id("users"),
  })
    .index("by_version", ["promptVersionId"])
    .index("by_version_testcase", ["promptVersionId", "testCaseId"])
    .index("by_project_and_status", ["projectId", "status"]),

  runOutputs: defineTable({
    runId: v.id("promptRuns"),
    blindLabel: v.string(),
    outputContent: v.string(),
    // M8: per-slot model/temperature (populated in mix mode)
    model: v.optional(v.string()),
    temperature: v.optional(v.number()),
    promptTokens: v.optional(v.number()),
    completionTokens: v.optional(v.number()),
    totalTokens: v.optional(v.number()),
    latencyMs: v.optional(v.number()),
    rawResponseStorageId: v.optional(v.id("_storage")),
  }).index("by_run", ["runId"]),

  // M4: Feedback + Blind Eval
  outputFeedback: defineTable({
    outputId: v.id("runOutputs"),
    userId: v.id("users"),
    annotationData: v.object({
      from: v.number(),
      to: v.number(),
      highlightedText: v.string(),
      comment: v.string(),
    }),
  })
    .index("by_output", ["outputId"])
    .index("by_user", ["userId"]),

  promptFeedback: defineTable({
    promptVersionId: v.id("promptVersions"),
    userId: v.id("users"),
    targetField: v.union(
      v.literal("system_message"),
      v.literal("user_message_template"),
    ),
    annotationData: v.object({
      from: v.number(),
      to: v.number(),
      highlightedText: v.string(),
      comment: v.string(),
    }),
  })
    .index("by_version", ["promptVersionId"])
    .index("by_user", ["userId"]),

  evalTokens: defineTable({
    token: v.string(),
    runId: v.id("promptRuns"),
    projectId: v.id("projects"),
    expiresAt: v.number(),
  })
    .index("by_token", ["token"])
    .index("by_run", ["runId"]),

  // M5: Optimization
  optimizationRequests: defineTable({
    projectId: v.id("projects"),
    promptVersionId: v.id("promptVersions"),
    status: v.union(
      v.literal("pending"),
      v.literal("processing"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    generatedSystemMessage: v.optional(v.string()),
    generatedUserTemplate: v.optional(v.string()),
    changesSummary: v.optional(v.string()),
    changesReasoning: v.optional(v.string()),
    optimizerModel: v.string(),
    optimizerPromptVersion: v.string(),
    reviewStatus: v.optional(
      v.union(
        v.literal("pending"),
        v.literal("accepted"),
        v.literal("rejected"),
        v.literal("edited"),
      ),
    ),
    reviewedById: v.optional(v.id("users")),
    reviewedAt: v.optional(v.number()),
    reviewNotes: v.optional(v.string()),
    resultingVersionId: v.optional(v.id("promptVersions")),
    requestedById: v.id("users"),
    errorMessage: v.optional(v.string()),
  })
    .index("by_version", ["promptVersionId"])
    .index("by_project_and_status", ["projectId", "status"]),
  // M6: User preferences (onboarding state)
  userPreferences: defineTable({
    userId: v.id("users"),
    dismissedCallouts: v.array(v.string()),
  }).index("by_user", ["userId"]),

  // M8: Model catalog (global, refreshed from OpenRouter API)
  modelCatalog: defineTable({
    modelId: v.string(),
    name: v.string(),
    provider: v.string(),
    contextWindow: v.number(),
    supportsVision: v.boolean(),
    promptPricing: v.number(),
    completionPricing: v.number(),
    lastRefreshedAt: v.number(),
  }).index("by_model_id", ["modelId"]),

  // M8: AI Run Assistant — pre-run suggestions
  runAssistantSuggestions: defineTable({
    projectId: v.id("projects"),
    promptVersionId: v.id("promptVersions"),
    status: v.union(
      v.literal("pending"),
      v.literal("processing"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    suggestions: v.optional(
      v.array(
        v.object({
          title: v.string(),
          description: v.string(),
          slotConfigs: v.array(
            v.object({
              label: v.string(),
              model: v.string(),
              temperature: v.number(),
            }),
          ),
        }),
      ),
    ),
    errorMessage: v.optional(v.string()),
    requestedById: v.id("users"),
  })
    .index("by_version", ["promptVersionId"])
    .index("by_project_and_status", ["projectId", "status"]),

  // M8: AI Run Assistant — post-run insights
  runInsights: defineTable({
    runId: v.id("promptRuns"),
    projectId: v.id("projects"),
    status: v.union(
      v.literal("pending"),
      v.literal("processing"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    insightContent: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
  }).index("by_run", ["runId"]),
});

export default schema;
