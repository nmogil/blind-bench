import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { chatCompletion } from "./lib/openrouter";
import { getOptimizerPrompt } from "./lib/optimizerPrompt";
import {
  validateOptimizerOutput,
  type OptimizerInput,
} from "./lib/optimizerValidation";

export const runOptimizerAction = internalAction({
  args: { requestId: v.id("optimizationRequests") },
  handler: async (ctx, args) => {
    const { requestId } = args;

    // 1. Load full context
    const context = await ctx.runQuery(
      internal.optimize.getOptimizationContext,
      { requestId },
    );

    // 2. Set status to processing
    await ctx.runMutation(internal.optimize.updateOptimizationStatus, {
      requestId,
      status: "processing",
    });

    // 3. Decrypt org's OpenRouter key
    let apiKey: string;
    try {
      apiKey = await ctx.runQuery(internal.openRouterKeys.getDecryptedKey, {
        orgId: context.organizationId,
      });
    } catch {
      await ctx.runMutation(internal.optimize.failOptimization, {
        requestId,
        errorMessage: "No OpenRouter key found",
      });
      return;
    }

    // 4. Build OptimizerInput
    const optimizerInput: OptimizerInput = {
      currentSystemMessage: context.version.systemMessage ?? null,
      currentUserTemplate: context.version.userMessageTemplate,
      projectVariables: context.variables,
      outputFeedback: context.outputFeedback,
      promptFeedback: context.promptFeedback,
      metaContext: context.metaContext,
    };

    // 5. Call OpenRouter
    try {
      const result = await chatCompletion({
        apiKey,
        model: context.request.optimizerModel,
        messages: [
          { role: "system", content: getOptimizerPrompt() },
          { role: "user", content: JSON.stringify(optimizerInput) },
        ],
        temperature: 0,
        responseFormat: { type: "json_object" },
      });

      // 6. Validate the response
      const validation = validateOptimizerOutput(result.content, optimizerInput);

      if (!validation.ok) {
        await ctx.runMutation(internal.optimize.failOptimization, {
          requestId,
          errorMessage: validation.error,
        });
        return;
      }

      // 7. Write successful result
      await ctx.runMutation(internal.optimize.completeOptimization, {
        requestId,
        generatedSystemMessage:
          validation.output.newSystemMessage ?? undefined,
        generatedUserTemplate: validation.output.newUserTemplate,
        changesSummary: validation.output.changesSummary,
        changesReasoning: validation.output.changesReasoning,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unknown error during optimization";
      await ctx.runMutation(internal.optimize.failOptimization, {
        requestId,
        errorMessage: message,
      });
    }
  },
});
