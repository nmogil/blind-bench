import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import {
  streamChatCompletion,
  type OpenRouterMessage,
  type MessageContent,
  type StreamUsage,
} from "./lib/openrouter";
import { captureEvent, captureException } from "./lib/posthog";
import { readMessages, type PromptMessage } from "./lib/messages";

const TEMPLATE_TOKEN_PATTERN = /\{\{(\w+)\}\}/g;

/**
 * Replace {{varName}} placeholders with values from the test case.
 */
function substituteVariables(
  template: string,
  variableValues: Record<string, string>,
): string {
  return template.replace(TEMPLATE_TOKEN_PATTERN, (match, name: string) => {
    return variableValues[name] ?? match;
  });
}

type ImageVarInfo = {
  required: boolean;
};

/**
 * Build a content[] array for a single user message, splicing image_url blocks
 * at every {{imageVar}} token position. Surrounding text segments become text
 * blocks; text-typed variables substitute inline. Returns `null` when the
 * message contains zero image tokens — caller falls back to the plain string
 * path so non-vision runs stay unchanged on the wire.
 */
async function buildUserContent(
  ctx: { storage: { get: (id: Id<"_storage">) => Promise<Blob | null> } },
  rawText: string,
  variableValues: Record<string, string>,
  imageVars: Map<string, ImageVarInfo>,
  variableAttachments: Record<string, Id<"_storage">>,
  testCaseLabel: string,
): Promise<MessageContent | null> {
  if (imageVars.size === 0) return null;

  // Quick scan — if the message references no image variables, skip the
  // expensive blob fetch path entirely.
  let hasImageToken = false;
  TEMPLATE_TOKEN_PATTERN.lastIndex = 0;
  let scan: RegExpExecArray | null;
  while ((scan = TEMPLATE_TOKEN_PATTERN.exec(rawText)) !== null) {
    if (imageVars.has(scan[1]!)) {
      hasImageToken = true;
      break;
    }
  }
  if (!hasImageToken) return null;

  const parts: Array<
    { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }
  > = [];
  let cursor = 0;
  TEMPLATE_TOKEN_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TEMPLATE_TOKEN_PATTERN.exec(rawText)) !== null) {
    const name = match[1]!;
    const start = match.index;
    const end = start + match[0].length;
    const imageInfo = imageVars.get(name);

    if (!imageInfo) {
      // Not an image variable — leave the token in place; the inline text
      // substitution pass below will resolve it like any other text var.
      continue;
    }

    // Flush preceding text (with text variables substituted) up to the token.
    if (start > cursor) {
      const prefix = substituteVariables(
        rawText.slice(cursor, start),
        variableValues,
      );
      if (prefix.length > 0) parts.push({ type: "text", text: prefix });
    }

    const storageId = variableAttachments[name];
    if (!storageId) {
      if (imageInfo.required) {
        throw new Error(
          `Required image variable {{${name}}} has no value on test case ${testCaseLabel}`,
        );
      }
      // Optional + missing: substitute empty string (drop the token entirely).
    } else {
      const blob = await ctx.storage.get(storageId);
      if (!blob) {
        throw new Error(
          `Image variable {{${name}}} references missing storage on test case ${testCaseLabel}`,
        );
      }
      const dataUrl = await blobToDataUrl(blob);
      parts.push({ type: "image_url", image_url: { url: dataUrl } });
    }

    cursor = end;
  }

  // Flush trailing text after the last token.
  if (cursor < rawText.length) {
    const tail = substituteVariables(
      rawText.slice(cursor),
      variableValues,
    );
    if (tail.length > 0) parts.push({ type: "text", text: tail });
  }

  return parts;
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  const arrayBuffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  // Chunk to avoid blowing the stack on large files (5MB ≈ 5M iterations
  // through String.fromCharCode.apply otherwise).
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)),
    );
  }
  const base64 = btoa(binary);
  const mime = blob.type || "application/octet-stream";
  return `data:${mime};base64,${base64}`;
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
    const {
      run,
      version,
      testCase,
      variables,
      promptAttachments,
      organizationId,
    } = context;

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
      testCase.variableAttachments ?? {},
      variables,
      testCase.attachmentIds,
      promptAttachments.map((a) => a.storageId),
      run.testCaseId ?? null,
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
  ctx: {
    storage: {
      get: (id: Id<"_storage">) => Promise<Blob | null>;
      getUrl: (id: Id<"_storage">) => Promise<string | null>;
    };
  },
  authored: PromptMessage[],
  variableValues: Record<string, string>,
  variableAttachments: Record<string, Id<"_storage">>,
  projectVariables: Doc<"projectVariables">[],
  testCaseAttachmentIds: Id<"_storage">[],
  promptAttachmentIds: Id<"_storage">[],
  testCaseId: Id<"testCases"> | null,
): Promise<OpenRouterMessage[]> {
  const imageVars = new Map<string, ImageVarInfo>();
  for (const pv of projectVariables) {
    if (pv.type === "image") {
      imageVars.set(pv.name, { required: pv.required });
    }
  }

  const allAttachmentIds = [...promptAttachmentIds, ...testCaseAttachmentIds];
  const lastUserIndex = findLastIndex(authored, (m) => m.role === "user");
  const testCaseLabel = testCaseId ?? "(quick run)";

  const out: OpenRouterMessage[] = [];
  for (let i = 0; i < authored.length; i++) {
    const m = authored[i]!;
    const rawText =
      m.role === "assistant" ? (m.content ?? "") : m.content;

    // Image variables are user-only (M21.3 enforces this at save time, but
    // we still treat non-user roles as plain-text-substituted to be safe).
    let imageContent: MessageContent | null = null;
    if (m.role === "user") {
      imageContent = await buildUserContent(
        ctx,
        rawText,
        variableValues,
        imageVars,
        variableAttachments,
        String(testCaseLabel),
      );
    }

    const isLastUser = m.role === "user" && i === lastUserIndex;

    if (imageContent !== null) {
      const parts = imageContent as Array<
        | { type: "text"; text: string }
        | { type: "image_url"; image_url: { url: string } }
      >;
      // Append legacy promptAttachments + testCase.attachmentIds to the last
      // user message so existing vision runs keep working.
      if (isLastUser && allAttachmentIds.length > 0) {
        for (const storageId of allAttachmentIds) {
          const url = await ctx.storage.getUrl(storageId);
          if (url) {
            parts.push({ type: "image_url", image_url: { url } });
          }
        }
      }
      out.push({ role: "user", content: parts });
      continue;
    }

    const text = substituteVariables(rawText, variableValues);

    // Legacy attachment path — no image-var splicing in this message, but
    // promptAttachments / testCase.attachmentIds still need to ride on the
    // last user turn.
    if (isLastUser && allAttachmentIds.length > 0) {
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
  let streamError: unknown;

  try {
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
  } catch (err) {
    streamError = err;
  }

  // Always finalize so this slot's promise settles. Without this, a thrown
  // stream leaves latencyMs unset and (combined with the run-level promise
  // race) keeps the overall run pinned in "running" until the action times
  // out. If the stream errored we still re-throw below so executeRunAction's
  // Promise.allSettled records the failure.
  await finalize(outputId, {
    promptTokens: finalUsage?.promptTokens,
    completionTokens: finalUsage?.completionTokens,
    totalTokens: finalUsage?.totalTokens,
    latencyMs: Date.now() - startTime,
  });

  if (streamError) throw streamError;
}
