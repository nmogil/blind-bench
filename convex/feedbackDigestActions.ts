import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { chatCompletion } from "./lib/openrouter";
import { buildDigestSystemPrompt, buildDigestUserPrompt } from "./lib/digestPrompt";

const DIGEST_MODEL = "anthropic/claude-sonnet-4";

export const generateDigestAction = internalAction({
  args: { digestId: v.id("feedbackDigests") },
  handler: async (ctx, args) => {
    const { digestId } = args;

    // 1. Load context
    const context = await ctx.runQuery(
      internal.feedbackDigest.getDigestContext,
      { digestId },
    );

    // 2. Set status to processing
    await ctx.runMutation(internal.feedbackDigest.updateDigestStatus, {
      digestId,
      status: "processing",
    });

    // 3. Decrypt org's OpenRouter key
    let apiKey: string;
    try {
      apiKey = await ctx.runQuery(internal.openRouterKeys.getDecryptedKey, {
        orgId: context.organizationId!,
      });
    } catch {
      await ctx.runMutation(internal.feedbackDigest.failDigest, {
        digestId,
        errorMessage: "No OpenRouter key found. Set up your API key first.",
      });
      return;
    }

    // 4. Build and call LLM
    try {
      const result = await chatCompletion({
        apiKey,
        model: DIGEST_MODEL,
        messages: [
          { role: "system", content: buildDigestSystemPrompt() },
          { role: "user", content: buildDigestUserPrompt(context) },
        ],
        temperature: 0,
        responseFormat: { type: "json_object" },
      });

      // 5. Parse JSON response
      const parsed = JSON.parse(result.content) as {
        summary?: string;
        themes?: Array<{
          title: string;
          severity: string;
          description: string;
          feedbackCount: number;
        }>;
        recommendations?: string[];
      };

      if (!parsed.summary || !parsed.themes) {
        throw new Error("Invalid digest response format");
      }

      // Build tag summary from the input context
      const tagSummary: Record<string, number> = {};
      for (const fb of context.outputFeedback) {
        if (fb.tags) {
          for (const tag of fb.tags) {
            tagSummary[tag] = (tagSummary[tag] ?? 0) + 1;
          }
        }
      }
      for (const fb of context.promptFeedback) {
        if (fb.tags) {
          for (const tag of fb.tags) {
            tagSummary[tag] = (tagSummary[tag] ?? 0) + 1;
          }
        }
      }

      // 6. Write successful result
      await ctx.runMutation(internal.feedbackDigest.completeDigest, {
        digestId,
        summary: parsed.summary,
        themes: parsed.themes.map((t) => ({
          title: t.title,
          severity: (["high", "medium", "low"].includes(t.severity)
            ? t.severity
            : "medium") as "high" | "medium" | "low",
          description: t.description,
          feedbackCount: t.feedbackCount ?? 0,
        })),
        recommendations: parsed.recommendations ?? [],
        preferenceBreakdown: context.preferences ?? undefined,
        tagSummary: Object.keys(tagSummary).length > 0 ? tagSummary : undefined,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unknown error generating digest";
      await ctx.runMutation(internal.feedbackDigest.failDigest, {
        digestId,
        errorMessage: message,
      });
    }
  },
});
