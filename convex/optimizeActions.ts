import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { chatCompletion } from "./lib/openrouter";
import { getOptimizerPrompt } from "./lib/optimizerPrompt";
import {
  validateOptimizerOutput,
  type OptimizerInput,
} from "./lib/optimizerValidation";
import { captureEvent, captureException } from "./lib/posthog";

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
      overallNotes: context.overallNotes,
      ratingDistribution: context.ratingDistribution,
      headToHead: context.headToHead,
      promptFeedback: context.promptFeedback,
      metaContext: context.metaContext,
    };

    // 5. Call OpenRouter — retry once on image-variable failures (Constraint 9
    //    is a known soft spot; one corrective re-prompt typically resolves it).
    const baseMessages = [
      { role: "system" as const, content: getOptimizerPrompt() },
      { role: "user" as const, content: JSON.stringify(optimizerInput) },
    ];
    try {
      let result = await chatCompletion({
        apiKey,
        model: context.request.optimizerModel,
        messages: baseMessages,
        temperature: 0,
        responseFormat: { type: "json_object" },
      });

      let validation = validateOptimizerOutput(result.content, optimizerInput);

      if (!validation.ok && validation.errorKind === "image_var") {
        result = await chatCompletion({
          apiKey,
          model: context.request.optimizerModel,
          messages: [
            ...baseMessages,
            { role: "assistant", content: result.content },
            {
              role: "user",
              content:
                `Your previous response violated Constraint 9: ${validation.error} ` +
                `Re-emit the JSON object preserving every image variable token verbatim in newUserTemplate ` +
                `and keeping image tokens out of newSystemMessage. Return ONLY the corrected JSON object.`,
            },
          ],
          temperature: 0,
          responseFormat: { type: "json_object" },
        });
        validation = validateOptimizerOutput(result.content, optimizerInput);
      }

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
        changes: validation.output.changes,
      });
      await captureEvent(
        "optimization completed",
        context.request.requestedById as string,
        {
          request_id: requestId as string,
          project_id: context.request.projectId as string,
          model: context.request.optimizerModel,
          output_feedback_count: context.outputFeedback.length,
          prompt_feedback_count: context.promptFeedback.length,
          overall_notes_count: context.overallNotes.length,
          rating_distribution_count: context.ratingDistribution.length,
          head_to_head_count: context.headToHead.length,
        },
      );
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unknown error during optimization";
      const errorObj = err instanceof Error ? err : new Error(message);
      await captureException(errorObj, context.request.requestedById as string, {
        function: "runOptimizerAction",
        request_id: requestId as string,
        project_id: context.request.projectId as string,
      });
      await ctx.runMutation(internal.optimize.failOptimization, {
        requestId,
        errorMessage: message,
      });
      await captureEvent(
        "optimization failed",
        context.request.requestedById as string,
        {
          request_id: requestId as string,
          project_id: context.request.projectId as string,
          error_message: message,
        },
      );
    }
  },
});
