import { defineSchema, defineTable } from "convex/server";
import { authTables } from "@convex-dev/auth/server";
import { v } from "convex/values";

const schema = defineSchema({
  ...authTables,

  // M28.7: extend the Convex Auth users table with `firstActivationAt`. Set
  // exactly once when the user accepts their first optimizer suggestion. All
  // other fields mirror the upstream `authTables.users` shape; if Convex Auth
  // adds fields, mirror them here too.
  users: defineTable({
    name: v.optional(v.string()),
    image: v.optional(v.string()),
    email: v.optional(v.string()),
    emailVerificationTime: v.optional(v.number()),
    phone: v.optional(v.string()),
    phoneVerificationTime: v.optional(v.number()),
    isAnonymous: v.optional(v.boolean()),
    firstActivationAt: v.optional(v.number()),
  })
    .index("email", ["email"])
    .index("phone", ["phone"])
    // M30: lets the cleanupAnonUsers cron sweep guest accounts cheaply.
    .index("by_anonymous", ["isAnonymous"]),

  // M1: Organizations & Projects
  organizations: defineTable({
    name: v.string(),
    slug: v.string(),
    logoUrl: v.optional(v.string()),
    createdById: v.id("users"),
  })
    .index("by_slug", ["slug"])
    // M29.1: lookup "does this user own a personal workspace?" without
    // scanning. Drives ensureFirstRunSeed's onboarding gate so we no longer
    // overload organizationMembers as the seed signal.
    .index("by_creator", ["createdById"]),

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
    // M26: blind-review flag. Only meaningful for role="evaluator" — when true
    // (or undefined), the reviewer sees the blinded eval surface; when false
    // they see the open review surface with attribution. Ignored for
    // owner/editor. Absent = legacy evaluator semantics (blind).
    blindMode: v.optional(v.boolean()),
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
    // M21.1: Variable type. Absent on pre-M21 rows — readers must default
    // to "text". Locked after creation; image variables MAY NOT have
    // defaultValue (per-test-case via testCases.variableAttachments).
    type: v.optional(v.union(v.literal("text"), v.literal("image"))),
  }).index("by_project", ["projectId"]),

  // M2: Test Cases
  testCases: defineTable({
    projectId: v.id("projects"),
    name: v.string(),
    variableValues: v.record(v.string(), v.string()),
    attachmentIds: v.array(v.id("_storage")),
    order: v.number(),
    createdById: v.id("users"),
    // M21.1: Per-test-case image attachments keyed by variable name. Spliced
    // into user messages as image_url content blocks at dispatch (M21.6).
    variableAttachments: v.optional(v.record(v.string(), v.id("_storage"))),
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
    // #188: Frozen copy of the inputs actually dispatched for this run. Test
    // cases are mutable, so without this the run's "what we sent" view would
    // silently re-render with the test case's *current* values whenever it is
    // edited after the run. Written at dispatch; absent on pre-#188 runs (no
    // backfill — readers fall back to the live test case with a visible note).
    // `images` maps image-variable name → the _storage blob that was sent; the
    // blob-retention check in convex/lib/inputSnapshot.ts keeps those blobs
    // alive even after the test case is edited or deleted.
    inputSnapshot: v.optional(
      v.object({
        text: v.record(v.string(), v.string()),
        images: v.optional(v.record(v.string(), v.id("_storage"))),
      }),
    ),
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
    // M27.4: conventional-comments-style label. Optional for legacy rows;
    // new annotations always set it (default "thought") at write time.
    label: v.optional(
      v.union(
        v.literal("suggestion"),
        v.literal("issue"),
        v.literal("praise"),
        v.literal("question"),
        v.literal("nitpick"),
        v.literal("thought"),
      ),
    ),
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
    // M27.4: conventional-comments-style label. Optional for legacy rows;
    // new annotations always set it (default "thought") at write time.
    label: v.optional(
      v.union(
        v.literal("suggestion"),
        v.literal("issue"),
        v.literal("praise"),
        v.literal("question"),
        v.literal("nitpick"),
        v.literal("thought"),
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
  })
    .index("by_run_user", ["runId", "userId"])
    .index("by_output", ["outputId"])
    .index("by_run", ["runId"])
    .index("by_review_session", ["reviewSessionId"]),

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
    // M27.5: per-change rationale emitted by the optimizer for inline marker
    // popovers. Optional — the optimizer is not required to populate it
    // (legacy v1.1 prompt does not emit this field). Each entry anchors to
    // a range in the resulting (post-optimization) text.
    changes: v.optional(
      v.array(
        v.object({
          targetField: v.union(
            v.literal("system_message"),
            v.literal("user_message_template"),
          ),
          range: v.object({ from: v.number(), to: v.number() }),
          rationale: v.string(),
        }),
      ),
    ),
  })
    .index("by_version", ["promptVersionId"])
    .index("by_project_and_status", ["projectId", "status"]),
  // M6: User preferences (onboarding state)
  userPreferences: defineTable({
    userId: v.id("users"),
    dismissedCallouts: v.array(v.string()),
    // M27.8: first-run tour state. tourStatus drives the tour modal:
    //   "unstarted" — show on first sign-in (default for new users)
    //   "in_progress" — resume at tourStep on next sign-in
    //   "skipped" — user dismissed; reopenable from Settings
    //   "completed" — user finished all six steps
    tourStatus: v.optional(
      v.union(
        v.literal("unstarted"),
        v.literal("in_progress"),
        v.literal("skipped"),
        v.literal("completed"),
      ),
    ),
    tourStep: v.optional(v.number()),
    // M28.3: Co-pilot side panel visibility. `copilotCollapsed` shrinks to an
    // icon-only rail; `copilotDismissed` hides it entirely (reopenable from the
    // help menu). Absent = expanded + visible.
    copilotCollapsed: v.optional(v.boolean()),
    copilotDismissed: v.optional(v.boolean()),
    // M28.4: keys whose <NextActionRing> has been clicked at least once.
    // Append-only; once a ring is dismissed it stays dismissed forever for
    // that user, so the same target never pulses again on later sessions.
    copilotDismissedRings: v.optional(v.array(v.string())),
  }).index("by_user", ["userId"]),

  // M8: Model catalog (global, refreshed from OpenRouter API)
  modelCatalog: defineTable({
    modelId: v.string(),
    name: v.string(),
    provider: v.string(),
    contextWindow: v.number(),
    supportsVision: v.boolean(),
    // M21.7: raw `architecture.input_modalities` from OpenRouter (e.g.
    // ["text", "image"]). Authoritative source for vision capability gating;
    // `supportsVision` stays as the legacy boolean derived from `modality`.
    // Absent on rows refreshed before M21.7 — readers must fall back to
    // `supportsVision`.
    inputModalities: v.optional(v.array(v.string())),
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

  // Landing page: anonymous demo votes
  demoVotes: defineTable({
    choice: v.union(v.literal("A"), v.literal("B")),
  }),

  demoVoteStats: defineTable({
    countA: v.number(),
    countB: v.number(),
  }),

  // M22: Trace imports — foundation for pulling completed runs from external
  // observability tools (Langfuse, PostHog, PromptLayer) or pasted JSON into
  // Blind Bench. Adapters parse provider payloads into the canonical
  // ParsedTrace shape (see convex/traceAdapters/types.ts); this row tracks the
  // import identity, optional dedup key, and the resulting prompt version /
  // run output the trace was materialized into.
  traceImports: defineTable({
    projectId: v.id("projects"),
    source: v.union(
      v.literal("langfuse"),
      v.literal("posthog"),
      v.literal("promptlayer"),
      v.literal("manual_paste"),
      v.literal("cloudflare_ai_gateway"),
      // #265: Claude Code session .jsonl upload — first trajectory ingestion.
      v.literal("claude_code"),
      // #263: OTLP Gen-AI span push (Cloudflare AI Gateway + any OTel source).
      v.literal("otlp"),
      // Native `eval-record` v1 JSON push — Blind Bench's own public ingest schema.
      v.literal("native"),
    ),
    // Provider's stable trace identifier when available — manual_paste imports
    // don't have one. Combined with `source` it forms the dedup key.
    sourceTraceId: v.optional(v.string()),
    importedById: v.id("users"),
    // Materialized targets. Populated by the importer once it decides whether
    // to land the trace as a new prompt version, a completed run output, or
    // both. Optional so we can record the import row before resolution.
    promptVersionId: v.optional(v.id("promptVersions")),
    runOutputId: v.optional(v.id("runOutputs")),
    // Original provider payload, persisted verbatim so adapter improvements
    // can re-parse without re-fetching from the source.
    rawPayloadStorageId: v.optional(v.id("_storage")),
    // #259: once a cloudflare_ai_gateway import is materialized into an eval
    // case this points at that row. Presence is the idempotency signal for
    // `gatewayImport.materializeImportedTraces` (skip already-materialized).
    evalCaseId: v.optional(v.id("evalCases")),
  })
    .index("by_project", ["projectId"])
    .index("by_source_trace", ["source", "sourceTraceId"]),

  // #259: imported production-log traces materialized into runnable eval cases.
  // Project-scoped. One row per materialized traceImport (`by_trace_import`
  // enforces idempotency). Stores the captured production output alongside the
  // request messages so the per-org scorecard can grade the real output; it is
  // NEVER exposed to blind reviewers and scorecard client queries return only
  // ids/products/scorer keys/numbers, never messages/outputText.
  evalCases: defineTable({
    projectId: v.id("projects"),
    traceImportId: v.id("traceImports"),
    // Only production-log cases for now; keep as a literal so a future
    // synthetic/replay source is an explicit, migrated schema change.
    source: v.literal("production_log"),
    // From the trace's metadata.product, fallback "unknown".
    product: v.string(),
    title: v.string(),
    messages: v.array(v.object({ role: v.string(), content: v.string() })),
    // The captured production output; absent when the response was redacted.
    outputText: v.optional(v.string()),
    // Deterministic scorer ids assigned at materialization (see
    // convex/traceAdapters/materializeEvalCase.ts).
    scorerIds: v.array(v.string()),
    requestMissing: v.boolean(),
    responseMissing: v.boolean(),
    model: v.optional(v.string()),
    provider: v.optional(v.string()),
    timestamp: v.optional(v.string()),
    inputTokens: v.optional(v.number()),
    outputTokens: v.optional(v.number()),
    costUsd: v.optional(v.number()),
    durationMs: v.optional(v.number()),
    createdById: v.id("users"),
  })
    .index("by_project", ["projectId"])
    .index("by_trace_import", ["traceImportId"]),

  // #264 (M31 Trajectory Spine): parent row for a normalized agent-run trace.
  // Deliberately tiny — metadata + usage rollups only, NO step content — so it
  // stays well under the Convex ~1MiB doc cap regardless of trace length. Step
  // bodies live in `agentTraceSteps` rows + file storage. `traceId` is the
  // normalizer's stable id (opaque external ref + dedup key), distinct from the
  // Convex `_id`. `status` drives async-import progress and in-flight dedup.
  // Free text (final answer) goes to storage, never inline, to keep the row
  // bounded. `errorMessage` is sanitized (counts/generic strings only).
  agentTraces: defineTable({
    projectId: v.id("projects"),
    // Provenance. Optional so a trace can be persisted directly (round-trip
    // tests, non-import paths) without a traceImports row.
    traceImportId: v.optional(v.id("traceImports")),
    traceId: v.string(),
    source: v.literal("agent_harness"),
    harnessName: v.string(),
    harnessVersion: v.optional(v.string()),
    harnessSdk: v.optional(v.string()),
    product: v.string(),
    module: v.optional(v.string()),
    environment: v.optional(v.string()),
    model: v.optional(v.string()),
    runId: v.optional(v.string()),
    stepCount: v.number(),
    status: v.union(
      v.literal("pending"),
      v.literal("ready"),
      v.literal("failed"),
    ),
    errorMessage: v.optional(v.string()),
    privacyClass: v.union(
      v.literal("public"),
      v.literal("internal"),
      v.literal("confidential"),
      v.literal("pii"),
      v.literal("phi"),
    ),
    costUsd: v.optional(v.number()),
    durationMs: v.optional(v.number()),
    totalTokens: v.optional(v.number()),
    // Final answer bodies → storage (full + precomputed blind projection), so
    // the parent row never carries unbounded free text.
    finalAnswerStorageId: v.optional(v.id("_storage")),
    finalAnswerBlindStorageId: v.optional(v.id("_storage")),
    importedById: v.id("users"),
  })
    .index("by_project", ["projectId"])
    .index("by_trace_id", ["traceId"])
    .index("by_project_and_status", ["projectId", "status"]),

  // #264 (M31 Trajectory Spine): one row per trace step, ordered by
  // (agentTraceId, stepIndex). Own ~1MiB doc budget per row. Light,
  // indexable/renderable scalars inline; heavy payloads (tool args/results,
  // reasoning, terminal output, state snapshots, message content) go to file
  // storage. Two body pointers per step: `fullBodyStorageId` (reviewer view)
  // and `blindBodyStorageId` (PRECOMPUTED blind projection). The blind
  // projection is computed once at ingest — never on the fly in the read query
  // — and the paginated step query hands a blind principal ONLY the blind
  // blob's URL; the full storage id is never returned to them (enforcement at
  // the function boundary, minimal leak surface). Bodyless steps (policy_event)
  // leave both pointers null. #266 refines the projection function; because the
  // slot already exists, that is a reprocess, not a schema migration.
  agentTraceSteps: defineTable({
    agentTraceId: v.id("agentTraces"),
    stepIndex: v.number(),
    kind: v.union(
      v.literal("message"),
      v.literal("tool_call"),
      v.literal("tool_result"),
      v.literal("state"),
      v.literal("policy_event"),
    ),
    role: v.optional(v.string()),
    toolName: v.optional(v.string()),
    toolCallId: v.optional(v.string()),
    label: v.optional(v.string()),
    policy: v.optional(v.string()),
    action: v.optional(v.string()),
    reason: v.optional(v.string()),
    timestamp: v.optional(v.string()),
    privacyClass: v.optional(
      v.union(
        v.literal("public"),
        v.literal("internal"),
        v.literal("confidential"),
        v.literal("pii"),
        v.literal("phi"),
      ),
    ),
    // Populated by richer importers (#265 Claude Code JSONL); absent here.
    inputTokens: v.optional(v.number()),
    outputTokens: v.optional(v.number()),
    durationMs: v.optional(v.number()),
    fullBodyStorageId: v.optional(v.id("_storage")),
    blindBodyStorageId: v.optional(v.id("_storage")),
  }).index("by_trace_and_index", ["agentTraceId", "stepIndex"]),

  // #267 (M31.4): step-granular review annotations on an agent trace. Anchored
  // by `stepIndex` (stable + identical for blind and owner — the opaque
  // `call-N` tool-call id a blind reviewer sees is NOT a durable anchor), with
  // a `kind` discriminator so a comment on a tool call reads distinctly from a
  // comment on a whole step or the whole trajectory. Reuses the conventional-
  // comment label + tag vocabulary from outputFeedback/cycleFeedback.
  agentTraceComments: defineTable({
    agentTraceId: v.id("agentTraces"),
    projectId: v.id("projects"),
    userId: v.id("users"),
    target: v.union(
      v.object({ kind: v.literal("trace") }),
      v.object({ kind: v.literal("step"), stepIndex: v.number() }),
      v.object({ kind: v.literal("tool_call"), stepIndex: v.number() }),
    ),
    comment: v.string(),
    label: v.union(
      v.literal("suggestion"),
      v.literal("issue"),
      v.literal("praise"),
      v.literal("question"),
      v.literal("nitpick"),
      v.literal("thought"),
    ),
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
    .index("by_trace", ["agentTraceId"])
    .index("by_trace_and_user", ["agentTraceId", "userId"]),

  // #267 (M31.4): whole-trajectory verdict, reusing the best/acceptable/weak
  // rating vocabulary. One row per (trace, reviewer).
  agentTraceVerdicts: defineTable({
    agentTraceId: v.id("agentTraces"),
    projectId: v.id("projects"),
    userId: v.id("users"),
    rating: v.union(
      v.literal("best"),
      v.literal("acceptable"),
      v.literal("weak"),
    ),
    note: v.optional(v.string()),
  })
    .index("by_trace", ["agentTraceId"])
    .index("by_trace_and_user", ["agentTraceId", "userId"]),

  // #267 (M31.4): step-level pairwise preference — two blind trajectories of the
  // same task aligned at a divergence point; the reviewer picks the better next
  // action. This is the DPO-shaped signal (single-turn preference over the next
  // action given an identical prefix) the training-export bridge (#53) needs.
  // Mirrors reviewMatchups (winner left/right/tie/skip + reasonTags).
  agentTraceMatchups: defineTable({
    projectId: v.id("projects"),
    leftTraceId: v.id("agentTraces"),
    rightTraceId: v.id("agentTraces"),
    // Length of the shared prefix; both sides diverge at this step index.
    divergenceStepIndex: v.number(),
    leftBlindLabel: v.string(),
    rightBlindLabel: v.string(),
    userId: v.optional(v.id("users")),
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
    .index("by_project", ["projectId"])
    .index("by_left", ["leftTraceId"]),

  // #53 (export bridge): a generated training-data export. The JSONL is in
  // storage; this row tracks provenance + counts and gates the download to a
  // 1-hour window (AC6). `excludedCount` reflects rows dropped by the
  // data-boundary gate (reported to the user, never silently lost).
  trainingExports: defineTable({
    projectId: v.id("projects"),
    source: v.union(
      v.literal("trajectory"),
      v.literal("output_preference"),
    ),
    format: v.union(
      v.literal("dpo"),
      v.literal("annotated"),
      v.literal("sft"),
    ),
    storageId: v.id("_storage"),
    rowCount: v.number(),
    excludedCount: v.number(),
    // #288: JSON-serialized ExportManifest (Fireworks handoff report). Optional
    // for back-compat with exports created before the manifest existed.
    manifest: v.optional(v.string()),
    createdById: v.id("users"),
    createdAt: v.number(),
  }).index("by_project", ["projectId"]),

  // #263: per-project ingest tokens for the OTLP push endpoint. Opaque 128-bit
  // bearer token (generateToken), stored plaintext with a by_token index — the
  // house pattern (invitations); it only needs comparison, not decryption. The
  // customer configures it in their gateway/exporter (BYOK — Blind Bench never
  // holds the customer's Cloudflare/provider credential). Revoke by setting
  // `revokedAt`; the list surface never returns the full token after creation.
  ingestTokens: defineTable({
    projectId: v.id("projects"),
    token: v.string(),
    label: v.string(),
    createdById: v.id("users"),
    lastUsedAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
  })
    .index("by_token", ["token"])
    .index("by_project", ["projectId"]),

  // #259: per-org scorecard runs. Grades every org eval case that has a
  // captured production output against its assigned deterministic scorers.
  // `summary` and `errorMessage` are sanitized — counts + generic strings only,
  // never trace/message/output content.
  scorecardRuns: defineTable({
    orgId: v.id("organizations"),
    status: v.union(
      v.literal("pending"),
      v.literal("running"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    triggeredById: v.id("users"),
    startedAt: v.number(),
    completedAt: v.optional(v.number()),
    errorMessage: v.optional(v.string()),
    summary: v.optional(
      v.object({
        cases: v.number(),
        passed: v.number(),
        hardFailed: v.number(),
        meanScore: v.number(),
        skippedNoOutput: v.number(),
      }),
    ),
  }).index("by_org", ["orgId"]),

  // #259: one row per graded case in a scorecard run. `failingScorers` holds the
  // scorer keys whose result did not pass. No content — ids, product, scorer
  // keys, numbers, booleans only.
  scorecardResults: defineTable({
    runId: v.id("scorecardRuns"),
    caseId: v.id("evalCases"),
    product: v.string(),
    score: v.number(),
    passed: v.boolean(),
    hardFailed: v.boolean(),
    failingScorers: v.array(v.string()),
  }).index("by_run", ["runId"]),

  // M26: dedup ledger for "new draft published" emails to non-blind
  // reviewers. One row per (reviewer, project, version) so we can rate-limit
  // to one email per reviewer-per-project-per-24h regardless of how many
  // versions ship in that window.
  reviewerNotifications: defineTable({
    userId: v.id("users"),
    projectId: v.id("projects"),
    versionId: v.id("promptVersions"),
    sentAt: v.number(),
  })
    .index("by_user_project", ["userId", "projectId"])
    .index("by_version", ["versionId"]),

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
    // M27.4: conventional-comments-style label (see outputFeedback.label).
    label: v.optional(
      v.union(
        v.literal("suggestion"),
        v.literal("issue"),
        v.literal("praise"),
        v.literal("question"),
        v.literal("nitpick"),
        v.literal("thought"),
      ),
    ),
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
    // The reviewer who owns this session. M30: guests are anonymous Convex
    // Auth users (isAnonymous: true), so this is always a real users row —
    // there is no separate guest principal.
    userId: v.id("users"),
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
  // M25: Unified Invites (M30: guests are anonymous users, not a separate
  // principal — see invitations.acceptInviteAsGuest)
  // =========================================================================

  // Unified invitation table. `shareable: true` means a single token many
  // people can redeem. Targeted email invites have shareable=false and a
  // single recipient email.
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
      // M30: project_evaluator + cycle_reviewer are the reviewer roles an
      // anonymous guest may accept (both resolve to an evaluator row).
      v.literal("project_evaluator"),
      // cycle roles
      v.literal("cycle_reviewer"),
    ),

    email: v.string(),
    token: v.string(),
    shareable: v.boolean(),

    // M26: blind-review flag for reviewer-capable roles
    // (`project_evaluator`, `cycle_reviewer`). Propagated to
    // `projectCollaborators.blindMode` on accept. Ignored for owner/editor/org
    // roles. Absent = legacy evaluator semantics (blind).
    blindMode: v.optional(v.boolean()),

    status: v.union(
      v.literal("pending"),
      v.literal("accepted"),
      v.literal("revoked"),
      v.literal("expired"),
    ),

    invitedById: v.id("users"),
    invitedAt: v.number(),
    expiresAt: v.number(),

    // Set when a targeted (shareable=false) invite is accepted. M30: guests
    // are anonymous users, so acceptance is always recorded against a real
    // users row. For shareable=true this is left empty on the root invite and
    // acceptance is tracked via acceptCount + the membership rows written on
    // accept.
    acceptedByUserId: v.optional(v.id("users")),
    acceptedAt: v.optional(v.number()),

    acceptCount: v.number(),
    maxAccepts: v.optional(v.number()),
  })
    .index("by_token", ["token"])
    .index("by_scope", ["scope", "scopeId"])
    .index("by_email_scope", ["email", "scope", "scopeId"])
    .index("by_org_status", ["orgId", "status"]),

  // =========================================================================
  // Polar self-serve billing. Payment state lives ONLY in these four tables
  // and is never joined to trace/eval/test-case data. Nothing here stores
  // customer trace content — only money/entitlement bookkeeping and Polar IDs.
  // =========================================================================

  // One row per org once it touches billing. `externalCustomerId` is the
  // stable handle we send to Polar (derived from the org id) so checkout can
  // create-or-resume the same Polar customer; `polarCustomerId` is filled in
  // once Polar assigns one.
  billingCustomers: defineTable({
    organizationId: v.id("organizations"),
    externalCustomerId: v.string(),
    polarCustomerId: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org", ["organizationId"])
    .index("by_polar_customer", ["polarCustomerId"])
    .index("by_external_customer", ["externalCustomerId"]),

  // Current package grant for an org. One active row per org at a time; older
  // grants are flipped to "revoked" rather than deleted for audit.
  billingEntitlements: defineTable({
    organizationId: v.id("organizations"),
    packageKey: v.string(),
    status: v.union(
      v.literal("trialing"),
      v.literal("active"),
      v.literal("revoked"),
    ),
    polarSubscriptionId: v.optional(v.string()),
    grantedAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org", ["organizationId"])
    .index("by_org_and_status", ["organizationId", "status"])
    .index("by_subscription", ["polarSubscriptionId"]),

  // Append-only credit ledger. Remaining credits = sum of `creditDelta` for an
  // org. Purchases/trials add positive deltas; refunds/revocations and eval
  // consumption add negative ones. Carries Polar IDs and product-run IDs for
  // idempotency and audit — never trace/test-case content.
  billingLedger: defineTable({
    organizationId: v.id("organizations"),
    creditDelta: v.number(),
    reason: v.string(),
    packageKey: v.optional(v.string()),
    polarOrderId: v.optional(v.string()),
    polarSubscriptionId: v.optional(v.string()),
    polarEventId: v.optional(v.string()),
    promptRunId: v.optional(v.id("promptRuns")),
    scorecardRunId: v.optional(v.id("scorecardRuns")),
    createdAt: v.number(),
  })
    .index("by_org", ["organizationId"])
    .index("by_order", ["polarOrderId"])
    .index("by_subscription", ["polarSubscriptionId"])
    .index("by_event", ["polarEventId"])
    .index("by_prompt_run", ["promptRunId"])
    .index("by_scorecard_run", ["scorecardRunId"]),

  // Idempotency + audit log of every webhook delivery we accepted. Keyed by the
  // Standard Webhooks `webhook-id`; a repeat delivery is a no-op.
  polarWebhookEvents: defineTable({
    eventId: v.string(),
    eventType: v.string(),
    processedAt: v.number(),
    result: v.string(),
  }).index("by_event_id", ["eventId"]),
});

export default schema;
