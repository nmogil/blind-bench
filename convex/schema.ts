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
  // M18: `messages` is the canonical representation. Legacy single-string
  // fields are still written in M18-M22 for backward compatibility and dropped
  // in M23.
  promptVersions: defineTable({
    projectId: v.id("projects"),
    versionNumber: v.number(),
    systemMessage: v.optional(v.string()),
    userMessageTemplate: v.string(),
    // Optional format hint for editor rendering. Absent = "plain".
    systemMessageFormat: v.optional(
      v.union(v.literal("plain"), v.literal("markdown")),
    ),
    userMessageTemplateFormat: v.optional(
      v.union(v.literal("plain"), v.literal("markdown")),
    ),
    // M18: Multi-turn messages. Absent on pre-M18 versions until the backfill
    // migration runs. Ids are immutable once set — feedback anchors on them.
    messages: v.optional(
      v.array(
        v.union(
          v.object({
            id: v.string(),
            role: v.union(v.literal("system"), v.literal("developer")),
            content: v.string(),
            format: v.optional(
              v.union(v.literal("plain"), v.literal("markdown")),
            ),
          }),
          v.object({
            id: v.string(),
            role: v.literal("user"),
            content: v.string(),
            format: v.optional(
              v.union(v.literal("plain"), v.literal("markdown")),
            ),
          }),
          v.object({
            id: v.string(),
            role: v.literal("assistant"),
            content: v.optional(v.string()),
          }),
        ),
      ),
    ),
    parentVersionId: v.optional(v.id("promptVersions")),
    sourceVersionId: v.optional(v.id("promptVersions")),
    status: v.union(
      v.literal("draft"),
      v.literal("current"),
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
    testCaseId: v.optional(v.id("testCases")),
    // M12: Quick run — inline variables when no test case
    inlineVariables: v.optional(v.record(v.string(), v.string())),
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
    // M11: optional feedback tags
    tags: v.optional(
      v.array(
        v.union(
          v.literal("accuracy"),
          v.literal("tone"),
          v.literal("length"),
          v.literal("relevance"),
          v.literal("safety"),
          v.literal("format"),
          v.literal("clarity"),
          v.literal("other"),
        ),
      ),
    ),
    // M19: links feedback back to the review session that produced it.
    // Absent on legacy rows from before M19.
    reviewSessionId: v.optional(v.id("reviewSessions")),
    // M19: "inline" (existing) anchors to a text range; "overall" is a
    // per-output note with empty annotationData. Absent = "inline".
    targetKind: v.optional(
      v.union(v.literal("inline"), v.literal("overall")),
    ),
    // M25: when set, the author is a verified guest (no user account).
    // Mutually exclusive with userId in practice; enforced in code.
    guestIdentityId: v.optional(v.id("guestIdentities")),
  })
    .index("by_output", ["outputId"])
    .index("by_user", ["userId"])
    .index("by_review_session", ["reviewSessionId"]),

  promptFeedback: defineTable({
    promptVersionId: v.id("promptVersions"),
    userId: v.id("users"),
    // M18: optional during M18-M22 for backward compatibility. New feedback
    // always sets it; backfill populates it for legacy rows.
    targetField: v.optional(
      v.union(
        v.literal("system_message"),
        v.literal("user_message_template"),
      ),
    ),
    // M18: canonical anchor — points at a stable message id on the version's
    // messages[] array. Absent only on legacy rows not yet backfilled.
    target: v.optional(
      v.object({
        kind: v.literal("message"),
        messageId: v.string(),
      }),
    ),
    annotationData: v.object({
      from: v.number(),
      to: v.number(),
      highlightedText: v.string(),
      comment: v.string(),
    }),
    // M11: optional feedback tags
    tags: v.optional(
      v.array(
        v.union(
          v.literal("accuracy"),
          v.literal("tone"),
          v.literal("length"),
          v.literal("relevance"),
          v.literal("safety"),
          v.literal("format"),
          v.literal("clarity"),
          v.literal("other"),
        ),
      ),
    ),
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

  // M10: Run Comments (general run-level feedback)
  runComments: defineTable({
    runId: v.id("promptRuns"),
    userId: v.id("users"),
    comment: v.string(),
  })
    .index("by_run", ["runId"])
    .index("by_run_user", ["runId", "userId"]),

  // M10: Output Preferences (preference ranking)
  outputPreferences: defineTable({
    runId: v.id("promptRuns"),
    outputId: v.id("runOutputs"),
    userId: v.id("users"),
    rating: v.union(
      v.literal("best"),
      v.literal("acceptable"),
      v.literal("weak"),
    ),
    // M19: links a preference back to the review session that produced it,
    // so session resume can find prior ratings by this user. Absent on legacy
    // rows from before M19.
    reviewSessionId: v.optional(v.id("reviewSessions")),
    // M25: guest principal attribution (see outputFeedback.guestIdentityId).
    guestIdentityId: v.optional(v.id("guestIdentities")),
  })
    .index("by_run_user", ["runId", "userId"])
    .index("by_output", ["outputId"])
    .index("by_run", ["runId"])
    .index("by_review_session", ["reviewSessionId"]),

  // Solo Blind Self-Evaluation (Issue #54)
  soloEvalSessions: defineTable({
    projectId: v.id("projects"),
    userId: v.id("users"),
    status: v.union(
      v.literal("active"),
      v.literal("completed"),
      v.literal("abandoned"),
    ),
    // Server-shuffled queue of outputs to evaluate (bounded, set once at creation)
    queue: v.array(
      v.object({
        outputId: v.id("runOutputs"),
        runId: v.id("promptRuns"),
        soloLabel: v.number(),
      }),
    ),
    currentIndex: v.number(),
    totalCount: v.number(),
    ratedCount: v.number(),
    skippedCount: v.number(),
    sourceRunIds: v.array(v.id("promptRuns")),
    completedAt: v.optional(v.number()),
  })
    .index("by_project_user", ["projectId", "userId"])
    .index("by_user_status", ["userId", "status"]),

  // M10: Evaluator Notifications (extended in M14 with cycle types + cycleId)
  evaluatorNotifications: defineTable({
    userId: v.id("users"),
    projectId: v.id("projects"),
    type: v.union(
      v.literal("new_run"),
      v.literal("feedback_used"),
      v.literal("cycle_assigned"),
      v.literal("cycle_reminder"),
      v.literal("cycle_closed"),
    ),
    message: v.string(),
    read: v.boolean(),
    // M14: optional cycle reference for deep linking
    cycleId: v.optional(v.id("reviewCycles")),
  })
    .index("by_user", ["userId"])
    .index("by_user_read", ["userId", "read"]),

  // M11: AI Feedback Digests
  feedbackDigests: defineTable({
    projectId: v.id("projects"),
    promptVersionId: v.id("promptVersions"),
    status: v.union(
      v.literal("pending"),
      v.literal("processing"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    summary: v.optional(v.string()),
    themes: v.optional(
      v.array(
        v.object({
          title: v.string(),
          severity: v.union(
            v.literal("high"),
            v.literal("medium"),
            v.literal("low"),
          ),
          description: v.string(),
          feedbackCount: v.number(),
        }),
      ),
    ),
    preferenceBreakdown: v.optional(
      v.object({
        totalRatings: v.number(),
        bestCount: v.number(),
        acceptableCount: v.number(),
        weakCount: v.number(),
      }),
    ),
    recommendations: v.optional(v.array(v.string())),
    tagSummary: v.optional(v.record(v.string(), v.number())),
    errorMessage: v.optional(v.string()),
    requestedById: v.id("users"),
  })
    .index("by_version", ["promptVersionId"])
    .index("by_project_and_status", ["projectId", "status"]),

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
    // M18: messages[] version of the optimizer output. v1 only populates this
    // for single-turn source prompts; multi-turn optimization is a future
    // milestone. Coexists with the legacy string fields during M18-M22.
    generatedMessages: v.optional(
      v.array(
        v.union(
          v.object({
            id: v.string(),
            role: v.union(v.literal("system"), v.literal("developer")),
            content: v.string(),
            format: v.optional(
              v.union(v.literal("plain"), v.literal("markdown")),
            ),
          }),
          v.object({
            id: v.string(),
            role: v.literal("user"),
            content: v.string(),
            format: v.optional(
              v.union(v.literal("plain"), v.literal("markdown")),
            ),
          }),
          v.object({
            id: v.string(),
            role: v.literal("assistant"),
            content: v.optional(v.string()),
          }),
        ),
      ),
    ),
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
    // M14: optional cycle reference for tracing which cycle triggered optimization
    sourceCycleId: v.optional(v.id("reviewCycles")),
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

  // M13: Shareable blind comparison links
  shareableEvalLinks: defineTable({
    token: v.string(),
    runId: v.id("promptRuns"),
    projectId: v.id("projects"),
    createdById: v.id("users"),
    expiresAt: v.number(),
    maxResponses: v.optional(v.number()),
    responseCount: v.number(),
    active: v.boolean(),
    purpose: v.optional(v.literal("invitation")),
  })
    .index("by_token", ["token"])
    .index("by_run", ["runId"]),

  // M13: Anonymous preferences from shareable links
  anonymousPreferences: defineTable({
    shareableLinkId: v.id("shareableEvalLinks"),
    runId: v.id("promptRuns"),
    sessionId: v.string(),
    ratings: v.array(
      v.object({
        blindLabel: v.string(),
        rating: v.union(
          v.literal("best"),
          v.literal("acceptable"),
          v.literal("weak"),
        ),
      }),
    ),
  })
    .index("by_link", ["shareableLinkId"])
    .index("by_session", ["shareableLinkId", "sessionId"]),

  // Landing page: anonymous demo votes
  demoVotes: defineTable({
    choice: v.union(v.literal("A"), v.literal("B")),
  }),

  demoVoteStats: defineTable({
    countA: v.number(),
    countB: v.number(),
  }),

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

  // =========================================================================
  // M14: Review Cycles
  // =========================================================================

  // The first-class cycle entity — pools outputs from multiple versions for
  // structured blind evaluation with explicit evaluator tracking.
  reviewCycles: defineTable({
    projectId: v.id("projects"),
    primaryVersionId: v.id("promptVersions"),
    controlVersionId: v.optional(v.id("promptVersions")),
    parentCycleId: v.optional(v.id("reviewCycles")),
    name: v.string(),
    status: v.union(
      v.literal("draft"),
      v.literal("open"),
      v.literal("closed"),
    ),
    includeSoloEval: v.boolean(),
    createdById: v.id("users"),
    openedAt: v.optional(v.number()),
    closedAt: v.optional(v.number()),
    closedAction: v.optional(
      v.union(
        v.literal("new_version_manual"),
        v.literal("optimizer_requested"),
        v.literal("no_action"),
      ),
    ),
    resultingVersionId: v.optional(v.id("promptVersions")),
    resultingOptimizationId: v.optional(v.id("optimizationRequests")),
  })
    .index("by_project", ["projectId"])
    .index("by_primary_version", ["primaryVersionId"])
    .index("by_project_and_status", ["projectId", "status"])
    .index("by_parent_cycle", ["parentCycleId"]),

  // Maps run outputs into a cycle with new cycle-scoped blind labels.
  // outputContentSnapshot is a frozen copy — immutable once pooled.
  // SECURITY: source fields are NEVER exposed to evaluators.
  cycleOutputs: defineTable({
    cycleId: v.id("reviewCycles"),
    sourceOutputId: v.id("runOutputs"),
    sourceRunId: v.id("promptRuns"),
    sourceVersionId: v.id("promptVersions"),
    cycleBlindLabel: v.string(), // A-Z
    outputContentSnapshot: v.string(),
  })
    .index("by_cycle", ["cycleId"])
    .index("by_cycle_and_label", ["cycleId", "cycleBlindLabel"])
    .index("by_source_output", ["sourceOutputId"]),

  // Per-cycle evaluator assignment + progress tracking.
  cycleEvaluators: defineTable({
    cycleId: v.id("reviewCycles"),
    userId: v.id("users"),
    status: v.union(
      v.literal("pending"),
      v.literal("in_progress"),
      v.literal("completed"),
    ),
    assignedAt: v.number(),
    startedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    lastReminderSentAt: v.optional(v.number()),
    reminderCount: v.number(),
  })
    .index("by_cycle", ["cycleId"])
    .index("by_user", ["userId"])
    .index("by_cycle_and_user", ["cycleId", "userId"])
    .index("by_cycle_and_status", ["cycleId", "status"]),

  // Ratings with source tracking — unified table for evaluator, anonymous,
  // solo, and author ratings. userId is null for anonymous entries.
  cyclePreferences: defineTable({
    cycleId: v.id("reviewCycles"),
    cycleOutputId: v.id("cycleOutputs"),
    userId: v.optional(v.id("users")),
    rating: v.union(
      v.literal("best"),
      v.literal("acceptable"),
      v.literal("weak"),
    ),
    source: v.union(
      v.literal("evaluator"),
      v.literal("anonymous"),
      v.literal("solo"),
      v.literal("author"),
    ),
    sessionId: v.optional(v.string()),
    // M19: links back to the review session that produced this rating.
    reviewSessionId: v.optional(v.id("reviewSessions")),
    // M25: guest principal attribution (see outputFeedback.guestIdentityId).
    guestIdentityId: v.optional(v.id("guestIdentities")),
  })
    .index("by_cycle", ["cycleId"])
    .index("by_cycle_user", ["cycleId", "userId"])
    .index("by_cycle_output", ["cycleOutputId"])
    .index("by_cycle_and_source", ["cycleId", "source"])
    .index("by_review_session", ["reviewSessionId"]),

  // Text annotations with source tracking for cycle outputs.
  cycleFeedback: defineTable({
    cycleId: v.id("reviewCycles"),
    cycleOutputId: v.id("cycleOutputs"),
    userId: v.optional(v.id("users")),
    annotationData: v.object({
      from: v.number(),
      to: v.number(),
      highlightedText: v.string(),
      comment: v.string(),
    }),
    tags: v.optional(
      v.array(
        v.union(
          v.literal("accuracy"),
          v.literal("tone"),
          v.literal("length"),
          v.literal("relevance"),
          v.literal("safety"),
          v.literal("format"),
          v.literal("clarity"),
          v.literal("other"),
        ),
      ),
    ),
    source: v.union(
      v.literal("evaluator"),
      v.literal("anonymous"),
      v.literal("invited"),
      v.literal("solo"),
      v.literal("author"),
    ),
    sessionId: v.optional(v.string()),
    // M19: links back to the review session that produced this annotation.
    reviewSessionId: v.optional(v.id("reviewSessions")),
    // M19: "inline" (existing) anchors to a text range; "overall" is a
    // per-output note with empty annotationData. Absent = "inline".
    targetKind: v.optional(
      v.union(v.literal("inline"), v.literal("overall")),
    ),
    // M25: guest principal attribution (see outputFeedback.guestIdentityId).
    guestIdentityId: v.optional(v.id("guestIdentities")),
  })
    .index("by_cycle_output", ["cycleOutputId"])
    .index("by_cycle", ["cycleId"])
    .index("by_user", ["userId"])
    .index("by_review_session", ["reviewSessionId"]),

  // =========================================================================
  // M19: Unified Review Sessions (Flash deck + Battle arena)
  // =========================================================================
  // A reviewSession is a single pass by one reviewer over a pool of outputs
  // (from one run OR one cycle). It tracks phase state, cursor, and is the
  // coordinating key for Phase 1 ratings/annotations (written to the existing
  // preference + feedback tables via reviewSessionId) and Phase 2 matchups.
  reviewSessions: defineTable({
    projectId: v.id("projects"),
    // Exactly one of runId / cycleId is set (enforced in code).
    runId: v.optional(v.id("promptRuns")),
    cycleId: v.optional(v.id("reviewCycles")),
    // M25: exactly one of {userId, guestIdentityId} is set. userId was
    // required pre-M25 and remains the common case; guestIdentityId is set
    // only when an unauthenticated guest accepts a cycle invite.
    userId: v.optional(v.id("users")),
    guestIdentityId: v.optional(v.id("guestIdentities")),
    // Reviewer's capacity for this session. "author" is the run/cycle creator;
    // "collaborator" is another project member; "evaluator" is an invited
    // blind reviewer routed via cycleEvaluators.
    role: v.union(
      v.literal("author"),
      v.literal("collaborator"),
      v.literal("evaluator"),
    ),
    phase: v.union(
      v.literal("phase1"),
      v.literal("phase2"),
      v.literal("complete"),
      v.literal("abandoned"),
    ),
    requirePhase1: v.boolean(),
    requirePhase2: v.boolean(),
    // Phase 1 cursor so resumes land on the last viewed card.
    currentIndex: v.number(),
    // Server-shuffled, frozen at session start. Blind labels here are
    // session-scoped (not the run/cycle label) so two reviewers see different
    // orderings. Each entry points at exactly one runOutput or cycleOutput.
    outputOrder: v.array(
      v.object({
        runOutputId: v.optional(v.id("runOutputs")),
        cycleOutputId: v.optional(v.id("cycleOutputs")),
        sessionBlindLabel: v.string(),
        testCaseId: v.optional(v.id("testCases")),
      }),
    ),
    startedAt: v.number(),
    phase1CompletedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
  })
    .index("by_project_user", ["projectId", "userId"])
    .index("by_user_status", ["userId", "phase"])
    .index("by_guest_status", ["guestIdentityId", "phase"])
    .index("by_run", ["runId"])
    .index("by_cycle", ["cycleId"]),

  // Phase 2 head-to-head matchups. Swiss-paired by the server so each round
  // is generated from current standings; matchups are only ever between
  // outputs of the same testCaseId (apples to apples). Winner feeds the
  // Bradley-Terry scorer downstream.
  reviewMatchups: defineTable({
    sessionId: v.id("reviewSessions"),
    round: v.number(),
    pairIndex: v.number(),
    // Both slots reference the same output kind as the session scope.
    leftRunOutputId: v.optional(v.id("runOutputs")),
    leftCycleOutputId: v.optional(v.id("cycleOutputs")),
    rightRunOutputId: v.optional(v.id("runOutputs")),
    rightCycleOutputId: v.optional(v.id("cycleOutputs")),
    leftBlindLabel: v.string(),
    rightBlindLabel: v.string(),
    testCaseId: v.optional(v.id("testCases")),
    winner: v.optional(
      v.union(
        v.literal("left"),
        v.literal("right"),
        v.literal("tie"),
        v.literal("skip"),
      ),
    ),
    reasonTags: v.array(
      v.union(
        v.literal("tone"),
        v.literal("accuracy"),
        v.literal("clarity"),
        v.literal("length"),
        v.literal("format"),
        v.literal("relevance"),
        v.literal("safety"),
        v.literal("other"),
      ),
    ),
    decidedAt: v.optional(v.number()),
  })
    .index("by_session", ["sessionId"])
    .index("by_session_round", ["sessionId", "round"]),

  // =========================================================================
  // M25: Unified Invites & Guest Identities
  // =========================================================================

  // A verified email identity for users who haven't created an account yet.
  // Created lazily on first click of an invite link. If the guest later signs
  // up with the same email, `promotedToUserId` is set and queries that fan
  // out across both principals can follow the pointer.
  //
  // Attribution guarantees: every cyclePreferences / cycleFeedback /
  // outputPreferences / outputFeedback row authored by a guest carries
  // guestIdentityId, so cycle owners can see "3 reviewers (2 users + 1 guest:
  // jane@example.com)" without exposing version identity.
  guestIdentities: defineTable({
    email: v.string(),
    verifiedAt: v.number(),
    displayName: v.optional(v.string()),
    promotedToUserId: v.optional(v.id("users")),
    promotedAt: v.optional(v.number()),
  })
    .index("by_email", ["email"])
    .index("by_promoted_user", ["promotedToUserId"]),

  // Unified invitation table. Replaces the Phase 5 migration source tables:
  //   organizationMembers (pending invites only), projectCollaborators,
  //   cycleEvaluators, evalInvitations, cycleShareableLinks.
  //
  // `shareable: true` means a single token many guests can redeem (replaces
  // public cycleShareableLinks). Targeted email invites have shareable=false
  // and a single recipient email.
  invitations: defineTable({
    scope: v.union(
      v.literal("org"),
      v.literal("project"),
      v.literal("cycle"),
    ),
    // String form of the scope entity id — Convex can't parametrize v.id(...)
    // on a sibling field. Code resolves scopeId back to the proper table id
    // based on `scope`.
    scopeId: v.string(),
    // Denormalized for fast org-wide admin queries. Always the containing
    // organization, even for project/cycle scopes.
    orgId: v.id("organizations"),

    role: v.union(
      // org roles
      v.literal("org_owner"),
      v.literal("org_admin"),
      v.literal("org_member"),
      // project roles
      v.literal("project_owner"),
      v.literal("project_editor"),
      v.literal("project_evaluator"),
      // cycle roles (guests can only accept this)
      v.literal("cycle_reviewer"),
    ),

    email: v.string(),
    token: v.string(),
    shareable: v.boolean(),

    status: v.union(
      v.literal("pending"),
      v.literal("accepted"),
      v.literal("revoked"),
      v.literal("expired"),
    ),

    invitedById: v.id("users"),
    invitedAt: v.number(),
    expiresAt: v.number(),

    // Set when accepted. Exactly one of acceptedByUserId / acceptedByGuestId
    // for shareable=false. For shareable=true, these are left empty on the
    // root invite and acceptance is tracked via acceptCount + child
    // guestIdentities / user membership rows.
    acceptedByUserId: v.optional(v.id("users")),
    acceptedByGuestId: v.optional(v.id("guestIdentities")),
    acceptedAt: v.optional(v.number()),

    acceptCount: v.number(),
    maxAccepts: v.optional(v.number()),
  })
    .index("by_token", ["token"])
    .index("by_scope", ["scope", "scopeId"])
    .index("by_email_scope", ["email", "scope", "scopeId"])
    .index("by_org_status", ["orgId", "status"]),
});

export default schema;
