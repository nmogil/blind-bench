/**
 * Shared logic for kicking off a prompt run and reading its current state.
 *
 * PUBLIC API: this file is the single source of truth for run-execution
 * behavior. Both convex/runs.ts (user mutations) and convex/api.ts
 * (service-token HTTP mutations) call into these helpers.
 *
 * Auth is the CALLER's responsibility.
 */

import { MutationCtx, QueryCtx } from "../_generated/server";
import { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { getBlindLabels, validateSlotConfigs, type SlotConfig } from "./slotConfig";

export const CONCURRENT_RUN_CAP = 10;

export interface ExecuteRunInput {
  versionId: Id<"promptVersions">;
  testCaseId?: Id<"testCases">;
  inlineVariables?: Record<string, string>;
  model: string;
  temperature: number;
  maxTokens?: number;
  mode?: "uniform" | "mix";
  slotConfigs?: SlotConfig[];
  userId: Id<"users">;
}

export async function executeRunCore(
  ctx: MutationCtx,
  args: ExecuteRunInput,
): Promise<Id<"promptRuns">> {
  const version = await ctx.db.get(args.versionId);
  if (!version) throw new Error("Version not found");

  if (!args.testCaseId && !args.inlineVariables) {
    throw new Error("Provide a test case or inline variable values.");
  }

  if (args.testCaseId) {
    const testCase = await ctx.db.get(args.testCaseId);
    if (!testCase || testCase.projectId !== version.projectId) {
      throw new Error("Test case not found");
    }
  }

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

  if (pending.length + running.length >= CONCURRENT_RUN_CAP) {
    throw new Error(
      "10 runs in flight. Wait for one to finish before starting another.",
    );
  }

  const isMix =
    args.mode === "mix" && args.slotConfigs && args.slotConfigs.length > 0;
  if (isMix) {
    validateSlotConfigs(args.slotConfigs!);
  }
  const labels = isMix
    ? getBlindLabels(args.slotConfigs!.length)
    : getBlindLabels(3);

  const runId = await ctx.db.insert("promptRuns", {
    projectId: version.projectId,
    promptVersionId: args.versionId,
    testCaseId: args.testCaseId,
    inlineVariables: args.inlineVariables,
    model: args.model,
    temperature: args.temperature,
    maxTokens: args.maxTokens,
    mode: isMix ? "mix" : undefined,
    slotConfigs: isMix ? args.slotConfigs : undefined,
    status: "pending",
    triggeredById: args.userId,
  });

  const outputIds: Id<"runOutputs">[] = [];
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

  await ctx.scheduler.runAfter(0, internal.runsActions.executeRunAction, {
    runId,
    outputIds,
    slotConfigs: isMix ? args.slotConfigs : undefined,
  });

  return runId;
}

export interface RunSnapshot {
  runId: Id<"promptRuns">;
  status: "pending" | "running" | "completed" | "failed";
  versionId: Id<"promptVersions">;
  versionNumber: number | null;
  testCaseId: Id<"testCases"> | null;
  model: string;
  temperature: number;
  mode: "uniform" | "mix" | null;
  startedAt: number | null;
  completedAt: number | null;
  errorMessage: string | null;
  outputs: {
    outputId: Id<"runOutputs">;
    blindLabel: string;
    outputContent: string;
    model: string | null;
    temperature: number | null;
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
    latencyMs: number | null;
  }[];
}

export async function getRunSnapshotCore(
  ctx: QueryCtx,
  runId: Id<"promptRuns">,
): Promise<RunSnapshot | null> {
  const run = await ctx.db.get(runId);
  if (!run) return null;

  const version = await ctx.db.get(run.promptVersionId);
  const outputs = await ctx.db
    .query("runOutputs")
    .withIndex("by_run", (q) => q.eq("runId", runId))
    .take(10);

  return {
    runId: run._id,
    status: run.status,
    versionId: run.promptVersionId,
    versionNumber: version?.versionNumber ?? null,
    testCaseId: run.testCaseId ?? null,
    model: run.model,
    temperature: run.temperature,
    mode: run.mode ?? null,
    startedAt: run.startedAt ?? null,
    completedAt: run.completedAt ?? null,
    errorMessage: run.errorMessage ?? null,
    outputs: outputs
      .sort((a, b) => a.blindLabel.localeCompare(b.blindLabel))
      .map((o) => ({
        outputId: o._id,
        blindLabel: o.blindLabel,
        outputContent: o.outputContent,
        model: o.model ?? null,
        temperature: o.temperature ?? null,
        promptTokens: o.promptTokens ?? null,
        completionTokens: o.completionTokens ?? null,
        totalTokens: o.totalTokens ?? null,
        latencyMs: o.latencyMs ?? null,
      })),
  };
}
