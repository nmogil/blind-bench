import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { chatCompletion } from "./lib/openrouter";
import { RUN_ASSISTANT_MODEL } from "./lib/runAssistantPrompt";

const POST_RUN_INSIGHT_PROMPT = `You are an AI assistant analyzing the results of a prompt A/B test. Multiple model/temperature configurations were used to generate outputs from the same prompt. Your job is to compare the outputs and provide actionable insights.

## Input

You receive a JSON object with:
- promptSystemMessage: the system message used
- promptUserTemplate: the user message template
- outputs: array of { blindLabel, model, temperature, outputContent, promptTokens, completionTokens, latencyMs, estimatedCost }
- metaContext: project context (domain, audience, tone)

## Output

Return a markdown-formatted analysis with these sections:

### Key Differences
Compare the outputs, noting differences in quality, length, style, accuracy, and creativity.

### Cost & Performance
Compare token usage, latency, and estimated cost across outputs.

### Recommendation
Suggest which model/temperature combination best fits this prompt's use case, and why.

## Rules

1. Reference outputs by their blind labels (A, B, C, etc.)
2. Be specific and actionable — don't just say "Output A is better"
3. When cost data is available, calculate cost differences
4. Keep the analysis concise (under 300 words)
5. Return ONLY the markdown, no JSON wrapper`;

export const generateInsightsAction = internalAction({
  args: {
    insightId: v.id("runInsights"),
    runId: v.id("promptRuns"),
  },
  handler: async (ctx, args) => {
    const { insightId, runId } = args;

    // 1. Load context
    const context = await ctx.runQuery(
      internal.runInsights.getInsightContext,
      { runId },
    );
    const { version, outputs, metaContext, organizationId } = context;

    // 2. Decrypt org's OpenRouter key
    let apiKey: string;
    try {
      apiKey = await ctx.runQuery(
        internal.openRouterKeys.getDecryptedKey,
        { orgId: organizationId },
      );
    } catch {
      await ctx.runMutation(internal.runInsights.failInsights, {
        insightId,
        errorMessage: "No OpenRouter key found.",
      });
      return;
    }

    // 3. Set status to processing
    await ctx.runMutation(internal.runInsights.updateInsightStatus, {
      insightId,
      status: "processing",
    });

    // 4. Build the input
    const input = {
      promptSystemMessage: version.systemMessage ?? null,
      promptUserTemplate: version.userMessageTemplate,
      outputs: outputs.map((o: {
        blindLabel: string;
        model: string;
        temperature: number;
        outputContent: string;
        promptTokens?: number;
        completionTokens?: number;
        latencyMs?: number;
        estimatedCost?: number;
      }) => ({
        blindLabel: o.blindLabel,
        model: o.model,
        temperature: o.temperature,
        outputContent: o.outputContent,
        promptTokens: o.promptTokens,
        completionTokens: o.completionTokens,
        latencyMs: o.latencyMs,
        estimatedCost: o.estimatedCost,
      })),
      metaContext: metaContext.map((mc: { question: string; answer: string }) => ({
        question: mc.question,
        answer: mc.answer,
      })),
    };

    // 5. Call the LLM
    try {
      const result = await chatCompletion({
        apiKey,
        model: RUN_ASSISTANT_MODEL,
        messages: [
          { role: "system", content: POST_RUN_INSIGHT_PROMPT },
          { role: "user", content: JSON.stringify(input) },
        ],
        temperature: 0,
      });

      // 6. Write the markdown content
      await ctx.runMutation(internal.runInsights.completeInsights, {
        insightId,
        insightContent: result.content,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await ctx.runMutation(internal.runInsights.failInsights, {
        insightId,
        errorMessage: message.slice(0, 500),
      });
    }
  },
});
