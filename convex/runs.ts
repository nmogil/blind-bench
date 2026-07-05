import { v } from "convex/values";
import {
  mutation,
  query,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { requireAuth, requireProjectRole } from "./lib/auth";
import type { Id } from "./_generated/dataModel";
import { getBlindLabels, validateSlotConfigs } from "./lib/slotConfig";
import { collectReferencedVariables } from "./lib/templateValidation";
import { readMessages } from "./lib/messages";
import { modelSupportsImages } from "./lib/modelCapabilities";
import { buildInputSnapshot } from "./lib/inputSnapshot";

const CONCURRENT_CAP = 10;

export const execute = mutation({
  args: {
    versionId: v.id("promptVersions"),
    testCaseId: v.optional(v.id("testCases")),
    // M12: Quick run — inline variable values when no test case
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
  },
  handler: async (ctx, args) => {
    const version = await ctx.db.get(args.versionId);
    if (!version) throw new Error("Version not found");

    const { userId } = await requireProjectRole(ctx, version.projectId, [
      "owner",
      "editor",
    ]);

    // Require exactly one of testCaseId or inlineVariables
    if (!args.testCaseId && !args.inlineVariables) {
      throw new Error("Provide a test case or inline variable values.");
    }

    // Verify test case belongs to same project (when using test case)
    let testCaseVarValues: Record<string, string> | undefined;
    let testCaseAttachments: Record<string, Id<"_storage">> | undefined;
    let testCaseHasImages = false;
    if (args.testCaseId) {
      const testCase = await ctx.db.get(args.testCaseId);
      if (!testCase || testCase.projectId !== version.projectId) {
        throw new Error("Test case not found");
      }
      testCaseVarValues = testCase.variableValues;
      testCaseAttachments = testCase.variableAttachments;
      testCaseHasImages =
        Object.keys(testCase.variableAttachments ?? {}).length > 0;
    }

    // Required-variable check — applies across every message in messages[] so
    // a {{var}} appearing only in an assistant turn still counts.
    const effectiveValues =
      args.inlineVariables ?? testCaseVarValues ?? {};
    const messages = readMessages(version);
    const referenced = collectReferencedVariables(
      messages.map((m) =>
        m.role === "assistant" ? (m.content ?? "") : m.content,
      ),
    );
    const projectVars = await ctx.db
      .query("projectVariables")
      .withIndex("by_project", (q) => q.eq("projectId", version.projectId))
      .take(200);
    const missing: string[] = [];
    for (const pv of projectVars) {
      if (!pv.required) continue;
      if (!referenced.has(pv.name)) continue;
      const value = effectiveValues[pv.name];
      if (value === undefined || value === "") {
        missing.push(pv.name);
      }
    }
    if (missing.length > 0) {
      throw new Error(
        `Missing required variable${missing.length === 1 ? "" : "s"}: ${missing
          .map((n) => `{{${n}}}`)
          .join(", ")}`,
      );
    }

    // Enforce concurrent run cap
    const pending = await ctx.db
      .query("promptRuns")
      .withIndex("by_project_and_status", (q) =>
        q.eq("projectId", version.projectId).eq("status", "pending"),
      )
      .take(11);
    const running = await ctx.db
      .query("promptRuns")
      .withIndex("by_project_and_status", (q) =>
        q.eq("projectId", version.projectId).eq("status", "running"),
      )
      .take(11);

    if (pending.length + running.length >= CONCURRENT_CAP) {
      throw new Error(
        "10 runs in flight. Wait for one to finish before starting another.",
      );
    }

    // Determine mode and validate slot configs
    const isMix = args.mode === "mix" && args.slotConfigs && args.slotConfigs.length > 0;

    if (isMix) {
      validateSlotConfigs(args.slotConfigs!);
    }

    const labels = isMix
      ? getBlindLabels(args.slotConfigs!.length)
      : getBlindLabels(3);

    // M21.7: vision capability gate. If the test case binds image variables,
    // every dispatched model must accept image input. Fail fast with a named
    // model so the user can pick an alternative without waiting on a real run.
    if (testCaseHasImages) {
      const modelsToCheck = isMix
        ? Array.from(new Set(args.slotConfigs!.map((s) => s.model)))
        : [args.model];
      for (const modelId of modelsToCheck) {
        if (!(await modelSupportsImages(ctx, modelId))) {
          throw new Error(
            `Model ${modelId} doesn't support image inputs. Choose a vision-capable model.`,
          );
        }
      }
    }

    // #188: Freeze the inputs we're about to dispatch onto the run row so the
    // run's "what we sent" history survives later edits to the test case.
    const inputSnapshot = buildInputSnapshot({
      inlineVariables: args.inlineVariables,
      testCase: args.testCaseId
        ? {
            variableValues: testCaseVarValues ?? {},
            variableAttachments: testCaseAttachments,
          }
        : null,
    });

    // Create run
    const runId = await ctx.db.insert("promptRuns", {
      projectId: version.projectId,
      promptVersionId: args.versionId,
      testCaseId: args.testCaseId,
      inlineVariables: args.inlineVariables,
      inputSnapshot,
      model: args.model,
      temperature: args.temperature,
      maxTokens: args.maxTokens,
      mode: isMix ? "mix" : undefined,
      slotConfigs: isMix ? args.slotConfigs : undefined,
      status: "pending",
      triggeredById: userId,
    });

    // Create empty output rows — per-slot model/temp in mix mode
    const outputIds = [];
    for (let i = 0; i < labels.length; i++) {
      const slotConfig = isMix ? args.slotConfigs![i] : undefined;
      const outputId = await ctx.db.insert("runOutputs", {
        runId,
        blindLabel: labels[i]!,
        outputContent: "",
        model: slotConfig?.model,
        temperature: slotConfig?.temperature,
      });
      outputIds.push(outputId);
    }

    // Schedule the streaming action
    await ctx.scheduler.runAfter(
      0,
      internal.runsActions.executeRunAction,
      {
        runId,
        outputIds,
        slotConfigs: isMix ? args.slotConfigs : undefined,
      },
    );

    await ctx.scheduler.runAfter(0, internal.analyticsActions.track, {
      event: "run executed",
      distinctId: userId as string,
      properties: {
        run_id: runId as string,
        project_id: version.projectId as string,
        model: args.model,
        mode: isMix ? "mix" : "uniform",
        slot_count: labels.length,
        has_test_case: !!args.testCaseId,
      },
    });

    return runId;
  },
});

/**
 * M29.6: Has the current user triggered at least one successful run on this
 * project? Used by the co-pilot collab nudge to gate the "Get feedback" card
 * — we only surface it after the user has felt the loop work end-to-end.
 *
 * Returns the runId so the caller can deep-link to the actual run if needed,
 * not just a boolean.
 */
export const firstSuccessfulRun = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    const collaborator = await ctx.db
      .query("projectCollaborators")
      .withIndex("by_project_and_user", (q) =>
        q.eq("projectId", args.projectId).eq("userId", userId),
      )
      .unique();
    if (!collaborator) return { runId: null as Id<"promptRuns"> | null };

    const runs = await ctx.db
      .query("promptRuns")
      .withIndex("by_project_and_status", (q) =>
        q.eq("projectId", args.projectId).eq("status", "completed"),
      )
      .take(50);

    const mine = runs
      .filter((r) => r.triggeredById === userId)
      .sort((a, b) => a._creationTime - b._creationTime)[0];

    return { runId: mine?._id ?? null };
  },
});

export const list = query({
  args: { versionId: v.id("promptVersions") },
  handler: async (ctx, args) => {
    const version = await ctx.db.get(args.versionId);
    if (!version) return [];

    // M26: non-blind reviewers can read runs (criterion #4 of #163). Blind
    // evaluators stay denied — they only see runs through the session flow.
    const { collaborator } = await requireProjectRole(
      ctx,
      version.projectId,
      ["owner", "editor", "evaluator"],
    );
    if (
      collaborator.role === "evaluator" &&
      (collaborator.blindMode ?? true)
    ) {
      throw new Error("Permission denied");
    }

    const runs = await ctx.db
      .query("promptRuns")
      .withIndex("by_version", (q) =>
        q.eq("promptVersionId", args.versionId),
      )
      .take(50);

    // Enrich with trigger user info
    const enriched = [];
    for (const run of runs) {
      const trigger = await ctx.db.get(run.triggeredById);
      enriched.push({
        ...run,
        triggeredByName: trigger?.name ?? null,
      });
    }

    return enriched.sort(
      (a, b) => (b._creationTime ?? 0) - (a._creationTime ?? 0),
    );
  },
});

export const get = query({
  args: { runId: v.id("promptRuns") },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run) return null;

    // M26: non-blind reviewers can read runs (criterion #4 of #163). Blind
    // evaluators stay denied.
    const { collaborator } = await requireProjectRole(
      ctx,
      run.projectId,
      ["owner", "editor", "evaluator"],
    );
    if (
      collaborator.role === "evaluator" &&
      (collaborator.blindMode ?? true)
    ) {
      throw new Error("Permission denied");
    }

    const outputs = await ctx.db
      .query("runOutputs")
      .withIndex("by_run", (q) => q.eq("runId", args.runId))
      .take(10);

    const version = await ctx.db.get(run.promptVersionId);
    const testCase = run.testCaseId
      ? await ctx.db.get(run.testCaseId)
      : null;
    const trigger = await ctx.db.get(run.triggeredById);

    // #188: The inputs shown in the run's "what we sent" view. Prefer the
    // frozen snapshot; then inline variables (immutable, so accurate for both
    // old and new quick runs); finally, for pre-#188 test-case runs with no
    // snapshot, fall back to the *live* test case values and flag it so the UI
    // can warn the reader instead of silently presenting current state as
    // history.
    const inputVariables =
      run.inputSnapshot?.text ??
      run.inlineVariables ??
      testCase?.variableValues ??
      null;
    const inputSnapshotMissing = run.testCaseId != null && !run.inputSnapshot;

    return {
      ...run,
      outputs: outputs.sort((a, b) => a.blindLabel.localeCompare(b.blindLabel)),
      versionNumber: version?.versionNumber ?? null,
      outputFormat: version?.userMessageTemplateFormat ?? null,
      testCaseName: testCase?.name ?? null,
      isQuickRun: !run.testCaseId,
      inlineVariables: run.inlineVariables ?? null,
      inputVariables,
      inputSnapshotMissing,
      triggeredByName: trigger?.name ?? null,
    };
  },
});

export const countInFlightRuns = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    await requireProjectRole(ctx, args.projectId, ["owner", "editor"]);

    const pending = await ctx.db
      .query("promptRuns")
      .withIndex("by_project_and_status", (q) =>
        q.eq("projectId", args.projectId).eq("status", "pending"),
      )
      .take(11);
    const running = await ctx.db
      .query("promptRuns")
      .withIndex("by_project_and_status", (q) =>
        q.eq("projectId", args.projectId).eq("status", "running"),
      )
      .take(11);

    return { inFlight: pending.length + running.length, cap: CONCURRENT_CAP };
  },
});

// --- Cross-version comparison (M6) ---

export const compareAcrossVersions = query({
  args: {
    projectId: v.id("projects"),
    testCaseId: v.id("testCases"),
    versionIds: v.array(v.id("promptVersions")),
  },
  handler: async (ctx, args) => {
    await requireProjectRole(ctx, args.projectId, ["owner", "editor"]);

    if (args.versionIds.length < 2 || args.versionIds.length > 5) {
      throw new Error("Select between 2 and 5 versions to compare");
    }

    const testCase = await ctx.db.get(args.testCaseId);
    if (!testCase || testCase.projectId !== args.projectId) {
      throw new Error("Test case not found");
    }

    const results = [];
    for (const versionId of args.versionIds) {
      const version = await ctx.db.get(versionId);
      if (!version || version.projectId !== args.projectId) continue;

      // Find runs for this (version, testCase) pair
      const runs = await ctx.db
        .query("promptRuns")
        .withIndex("by_version_testcase", (q) =>
          q.eq("promptVersionId", versionId).eq("testCaseId", args.testCaseId),
        )
        .take(10);

      // Prefer active (pending/running) run, then most recent completed
      const activeRun =
        runs.find((r) => r.status === "pending" || r.status === "running") ??
        null;
      const completedRuns = runs
        .filter((r) => r.status === "completed")
        .sort((a, b) => (b._creationTime ?? 0) - (a._creationTime ?? 0));
      const latestCompleted = completedRuns[0] ?? null;

      const runToShow = activeRun ?? latestCompleted;

      let outputs: Array<{
        _id: string;
        runId: string;
        blindLabel: string;
        outputContent: string;
        model?: string;
        temperature?: number;
        promptTokens?: number;
        completionTokens?: number;
        totalTokens?: number;
        latencyMs?: number;
      }> = [];
      if (runToShow) {
        const rawOutputs = await ctx.db
          .query("runOutputs")
          .withIndex("by_run", (q) => q.eq("runId", runToShow._id))
          .take(10);
        outputs = rawOutputs
          .map((o) => ({
            _id: o._id as string,
            runId: o.runId as string,
            blindLabel: o.blindLabel,
            outputContent: o.outputContent,
            model: o.model,
            temperature: o.temperature,
            promptTokens: o.promptTokens,
            completionTokens: o.completionTokens,
            totalTokens: o.totalTokens,
            latencyMs: o.latencyMs,
          }))
          .sort((a, b) => a.blindLabel.localeCompare(b.blindLabel));
      }

      results.push({
        versionId: versionId as string,
        versionNumber: version.versionNumber,
        versionStatus: version.status,
        sourceVersionId: version.sourceVersionId
          ? (version.sourceVersionId as string)
          : null,
        run: runToShow
          ? {
              _id: runToShow._id as string,
              status: runToShow.status,
              model: runToShow.model,
              temperature: runToShow.temperature,
              mode: runToShow.mode ?? undefined,
              _creationTime: runToShow._creationTime,
            }
          : null,
        outputs,
        hasCompletedRun: latestCompleted !== null,
      });
    }

    return results;
  },
});

// --- Internal functions (called by the streaming action) ---

export const getRunContext = internalQuery({
  args: { runId: v.id("promptRuns") },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run) throw new Error("Run not found");

    const version = await ctx.db.get(run.promptVersionId);
    if (!version) throw new Error("Version not found");

    // Quick run: no test case — use inline variables
    const testCase = run.testCaseId
      ? await ctx.db.get(run.testCaseId)
      : null;
    if (run.testCaseId && !testCase) throw new Error("Test case not found");

    // #188: Dispatch from the frozen input snapshot, not the live test case.
    // The action runs asynchronously after the run row is created, so a test
    // case edited in that window would otherwise change "what we sent".
    // `attachmentIds` (legacy prompt/test-case attachments, not keyed by
    // variable) are outside the snapshot's scope, so those still ride on the
    // live test case. Pre-#188 runs have no snapshot and fall back to live.
    const snapshot = run.inputSnapshot;
    const effectiveTestCase = {
      variableValues:
        snapshot?.text ??
        testCase?.variableValues ??
        ((run.inlineVariables ?? {}) as Record<string, string>),
      attachmentIds: (testCase?.attachmentIds ?? []) as Array<
        import("./_generated/dataModel").Id<"_storage">
      >,
      variableAttachments:
        snapshot?.images ??
        testCase?.variableAttachments ??
        ({} as Record<
          string,
          import("./_generated/dataModel").Id<"_storage">
        >),
    };

    const project = await ctx.db.get(version.projectId);
    if (!project) throw new Error("Project not found");

    const variables = await ctx.db
      .query("projectVariables")
      .withIndex("by_project", (q) => q.eq("projectId", version.projectId))
      .take(200);

    // Load prompt attachments
    const promptAttachments = await ctx.db
      .query("promptAttachments")
      .withIndex("by_version", (q) =>
        q.eq("promptVersionId", run.promptVersionId),
      )
      .take(50);

    return {
      run,
      version,
      testCase: effectiveTestCase,
      project,
      variables,
      promptAttachments,
      organizationId: project.organizationId,
    };
  },
});

export const appendOutputChunk = internalMutation({
  args: {
    outputId: v.id("runOutputs"),
    chunk: v.string(),
  },
  handler: async (ctx, args) => {
    const output = await ctx.db.get(args.outputId);
    if (!output) return;
    await ctx.db.patch(args.outputId, {
      outputContent: output.outputContent + args.chunk,
    });
  },
});

export const updateRunStatus = internalMutation({
  args: {
    runId: v.id("promptRuns"),
    status: v.union(
      v.literal("running"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    errorMessage: v.optional(v.string()),
    startedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const updates: Record<string, unknown> = { status: args.status };
    if (args.errorMessage !== undefined) updates.errorMessage = args.errorMessage;
    if (args.startedAt !== undefined) updates.startedAt = args.startedAt;
    if (args.completedAt !== undefined) updates.completedAt = args.completedAt;
    await ctx.db.patch(args.runId, updates);

    // Auto-trigger post-run insights for mix-mode runs
    if (args.status === "completed") {
      const run = await ctx.db.get(args.runId);
      if (run && run.mode === "mix") {
        const insightId = await ctx.db.insert("runInsights", {
          runId: args.runId,
          projectId: run.projectId,
          status: "pending",
        });
        await ctx.scheduler.runAfter(
          0,
          internal.runInsightsActions.generateInsightsAction,
          { insightId, runId: args.runId },
        );
      }
    }
  },
});

export const finalizeOutput = internalMutation({
  args: {
    outputId: v.id("runOutputs"),
    promptTokens: v.optional(v.number()),
    completionTokens: v.optional(v.number()),
    totalTokens: v.optional(v.number()),
    latencyMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { outputId, ...stats } = args;
    await ctx.db.patch(outputId, stats);
  },
});
