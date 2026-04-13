import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { chatCompletion } from "./lib/openrouter";
import {
  RUN_ASSISTANT_MODEL,
  PRE_RUN_SUGGESTION_PROMPT,
} from "./lib/runAssistantPrompt";

export const generateSuggestionsAction = internalAction({
  args: {
    requestId: v.id("runAssistantSuggestions"),
    slotCount: v.number(),
  },
  handler: async (ctx, args) => {
    const { requestId, slotCount } = args;

    // 1. Load context
    const context = await ctx.runQuery(
      internal.runAssistant.getAssistantContext,
      { requestId },
    );
    const { version, models, metaContext, organizationId } = context;

    // 2. Decrypt org's OpenRouter key
    let apiKey: string;
    try {
      apiKey = await ctx.runQuery(
        internal.openRouterKeys.getDecryptedKey,
        { orgId: organizationId },
      );
    } catch {
      await ctx.runMutation(internal.runAssistant.failSuggestions, {
        requestId,
        errorMessage: "No OpenRouter key found. Set one in org settings.",
      });
      return;
    }

    // 3. Set status to processing
    await ctx.runMutation(internal.runAssistant.updateSuggestionStatus, {
      requestId,
      status: "processing",
    });

    // 4. Build the input for the AI
    const input = {
      promptSystemMessage: version.systemMessage ?? null,
      promptUserTemplate: version.userMessageTemplate,
      metaContext: metaContext.map((mc: { question: string; answer: string }) => ({
        question: mc.question,
        answer: mc.answer,
      })),
      availableModels: models.length > 0
        ? models
        : [
            { id: "anthropic/claude-sonnet-4", name: "Claude Sonnet 4", provider: "Anthropic", promptPricing: 3, completionPricing: 15 },
            { id: "openai/gpt-4o-mini", name: "GPT-4o Mini", provider: "OpenAI", promptPricing: 0.15, completionPricing: 0.6 },
            { id: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash", provider: "Google", promptPricing: 0.15, completionPricing: 0.6 },
          ],
      currentSlotCount: slotCount,
    };

    // 5. Call the LLM
    try {
      const result = await chatCompletion({
        apiKey,
        model: RUN_ASSISTANT_MODEL,
        messages: [
          { role: "system", content: PRE_RUN_SUGGESTION_PROMPT },
          { role: "user", content: JSON.stringify(input) },
        ],
        temperature: 0,
        responseFormat: { type: "json_object" },
      });

      // 6. Parse and validate
      const parsed = JSON.parse(result.content) as {
        suggestions?: Array<{
          title: string;
          description: string;
          slotConfigs: Array<{
            label: string;
            model: string;
            temperature: number;
          }>;
        }>;
      };

      if (!parsed.suggestions || !Array.isArray(parsed.suggestions)) {
        throw new Error("AI returned invalid format: missing suggestions array");
      }

      // Basic validation
      const validSuggestions = parsed.suggestions
        .filter((s) => s.title && s.description && Array.isArray(s.slotConfigs))
        .map((s) => ({
          title: s.title.slice(0, 60),
          description: s.description.slice(0, 300),
          slotConfigs: s.slotConfigs.map((sc) => ({
            label: sc.label,
            model: sc.model,
            temperature: Math.min(2, Math.max(0, sc.temperature)),
          })),
        }));

      if (validSuggestions.length === 0) {
        throw new Error("AI returned no valid suggestions");
      }

      // 7. Write results
      await ctx.runMutation(internal.runAssistant.completeSuggestions, {
        requestId,
        suggestions: validSuggestions,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await ctx.runMutation(internal.runAssistant.failSuggestions, {
        requestId,
        errorMessage: message.slice(0, 500),
      });
    }
  },
});
