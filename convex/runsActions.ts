import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import {
  streamChatCompletion,
  type OpenRouterMessage,
  type MessageContent,
  type StreamUsage,
} from "./lib/openrouter";
import { captureEvent, captureException } from "./lib/posthog";
import { readMessages, type PromptMessage } from "./lib/messages";

/**
 * Replace {{varName}} placeholders with values from the test case.
 */
function substituteVariables(
  template: string,
  variableValues: Record<string, string>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => {
    return variableValues[name] ?? match;
  });
}

export const executeRunAction = internalAction({
  args: {
    runId: v.id("promptRuns"),
    outputIds: v.array(v.id("runOutputs")),
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
    const { runId, outputIds, slotConfigs } = args;

    // 1. Load full context
    const context = await ctx.runQuery(internal.runs.getRunContext, { runId });
    const { run, version, testCase, promptAttachments, organizationId } = context;

    // 2. Decrypt org's OpenRouter key
    let apiKey: string;
    try {
      apiKey = await ctx.runQuery(
        internal.openRouterKeys.getDecryptedKey,
        { orgId: organizationId },
      );
    } catch {
      await ctx.runMutation(internal.runs.updateRunStatus, {
        runId,
        status: "failed",
        errorMessage: "No OpenRouter key found",
        completedAt: Date.now(),
      });
      return;
    }

    // 3. Set status to running
    const startTime = Date.now();
    await ctx.runMutation(internal.runs.updateRunStatus, {
      runId,
      status: "running",
      startedAt: startTime,
    });

    // 4. Build the canonical messages[] — prefer the version's authored
    //    messages[]; synthesize from legacy fields for pre-M18 versions that
    //    haven't been backfilled yet.
    const authoredMessages: PromptMessage[] = readMessages(version);

    // 5. Variable-substitute every message and attach vision content to the
    //    last user message (preserves prior behaviour where attachments rode
    //    on the single user turn).
    const messages: OpenRouterMessage[] = await buildDispatchMessages(
      ctx,
      authoredMessages,
      testCase.variableValues,
      testCase.attachmentIds,
      promptAttachments.map((a) => a.storageId),
    );

    // 6. Fire 3 parallel streaming calls
    const appendChunk = (outputId: Id<"runOutputs">, chunk: string) =>
      ctx.runMutation(internal.runs.appendOutputChunk, { outputId, chunk });
    const finalize = (
      outputId: Id<"runOutputs">,
      stats: {
        promptTokens?: number;
        completionTokens?: number;
        totalTokens?: number;
        latencyMs?: number;
      },
    ) => ctx.runMutation(internal.runs.finalizeOutput, { outputId, ...stats });

    const results = await Promise.allSettled(
      outputIds.map((outputId, index) => {
        const slotConfig = slotConfigs?.[index];
        return runSingleOutput({
          apiKey,
          model: slotConfig?.model ?? run.model,
          messages,
          temperature: slotConfig?.temperature ?? run.temperature,
          maxTokens: run.maxTokens,
          outputId,
          startTime,
          appendChunk,
          finalize,
        });
      }),
    );

    // 7. Determine final run status
    const failures = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );

    if (failures.length > 0) {
      const firstError = failures[0]!.reason;
      const errorMessage = (
        firstError instanceof Error ? firstError.message : String(firstError)
      ).slice(0, 500);
      const errorObj = firstError instanceof Error ? firstError : new Error(errorMessage);
      await captureException(errorObj, run.triggeredById as string, {
        function: "executeRunAction",
        run_id: runId as string,
        project_id: run.projectId as string,
      });
      const finalStatus = failures.length === outputIds.length ? "failed" : "completed";
      await ctx.runMutation(internal.runs.updateRunStatus, {
        runId,
        status: finalStatus,
        errorMessage,
        completedAt: Date.now(),
      });
      await captureEvent("run failed", run.triggeredById as string, {
        run_id: runId as string,
        project_id: run.projectId as string,
        model: run.model,
        mode: run.mode ?? "uniform",
        failure_count: failures.length,
        slot_count: outputIds.length,
      });
    } else {
      await ctx.runMutation(internal.runs.updateRunStatus, {
        runId,
        status: "completed",
        completedAt: Date.now(),
      });
      await captureEvent("run completed", run.triggeredById as string, {
        run_id: runId as string,
        project_id: run.projectId as string,
        model: run.model,
        mode: run.mode ?? "uniform",
        slot_count: outputIds.length,
        latency_ms: Date.now() - startTime,
      });
    }
  },
});

async function buildDispatchMessages(
  ctx: { storage: { getUrl: (id: Id<"_storage">) => Promise<string | null> } },
  authored: PromptMessage[],
  variableValues: Record<string, string>,
  testCaseAttachmentIds: Id<"_storage">[],
  promptAttachmentIds: Id<"_storage">[],
): Promise<OpenRouterMessage[]> {
  const allAttachmentIds = [...promptAttachmentIds, ...testCaseAttachmentIds];
  const lastUserIndex = findLastIndex(authored, (m) => m.role === "user");

  const out: OpenRouterMessage[] = [];
  for (let i = 0; i < authored.length; i++) {
    const m = authored[i]!;
    const rawText =
      m.role === "assistant" ? (m.content ?? "") : m.content;
    const text = substituteVariables(rawText, variableValues);

    // Attach vision parts to the last user message so existing vision runs
    // keep working. Non-user messages always pass text-only content.
    if (
      m.role === "user" &&
      i === lastUserIndex &&
      allAttachmentIds.length > 0
    ) {
      const content: MessageContent = [{ type: "text", text }];
      for (const storageId of allAttachmentIds) {
        const url = await ctx.storage.getUrl(storageId);
        if (url) {
          content.push({ type: "image_url", image_url: { url } });
        }
      }
      out.push({ role: "user", content });
      continue;
    }

    out.push({ role: m.role, content: text });
  }
  return out;
}

function findLastIndex<T>(arr: T[], predicate: (v: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (predicate(arr[i]!)) return i;
  }
  return -1;
}

async function runSingleOutput(params: {
  apiKey: string;
  model: string;
  messages: OpenRouterMessage[];
  temperature: number;
  maxTokens?: number;
  outputId: Id<"runOutputs">;
  startTime: number;
  appendChunk: (outputId: Id<"runOutputs">, chunk: string) => Promise<unknown>;
  finalize: (
    outputId: Id<"runOutputs">,
    stats: {
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
      latencyMs?: number;
    },
  ) => Promise<unknown>;
}): Promise<void> {
  const {
    apiKey, model, messages, temperature, maxTokens,
    outputId, startTime, appendChunk, finalize,
  } = params;

  let finalUsage: StreamUsage | undefined;

  await streamChatCompletion({
    apiKey,
    model,
    messages,
    temperature,
    maxTokens,
    onChunk: async ({ chunk, done, usage }) => {
      if (chunk) {
        await appendChunk(outputId, chunk);
      }
      if (done && usage) {
        finalUsage = usage;
      }
    },
  });

  await finalize(outputId, {
    promptTokens: finalUsage?.promptTokens,
    completionTokens: finalUsage?.completionTokens,
    totalTokens: finalUsage?.totalTokens,
    latencyMs: Date.now() - startTime,
  });
}
