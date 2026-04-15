import { v } from "convex/values";
import {
  query,
  mutation,
  internalAction,
  internalMutation,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";

// Hardcoded fallback models — mirrors src/lib/models.ts
const FALLBACK_MODELS = [
  { modelId: "anthropic/claude-opus-4", name: "Claude Opus 4", provider: "Anthropic", contextWindow: 200000, supportsVision: true, promptPricing: 15, completionPricing: 75 },
  { modelId: "anthropic/claude-sonnet-4", name: "Claude Sonnet 4", provider: "Anthropic", contextWindow: 200000, supportsVision: true, promptPricing: 3, completionPricing: 15 },
  { modelId: "anthropic/claude-haiku-4", name: "Claude Haiku 4", provider: "Anthropic", contextWindow: 200000, supportsVision: true, promptPricing: 0.8, completionPricing: 4 },
  { modelId: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash", provider: "Google", contextWindow: 1000000, supportsVision: true, promptPricing: 0.15, completionPricing: 0.6 },
  { modelId: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "Google", contextWindow: 1000000, supportsVision: true, promptPricing: 1.25, completionPricing: 10 },
  { modelId: "google/gemini-2.0-flash-001", name: "Gemini 2.0 Flash", provider: "Google", contextWindow: 1000000, supportsVision: true, promptPricing: 0.1, completionPricing: 0.4 },
  { modelId: "openai/gpt-4o", name: "GPT-4o", provider: "OpenAI", contextWindow: 128000, supportsVision: true, promptPricing: 2.5, completionPricing: 10 },
  { modelId: "openai/gpt-4o-mini", name: "GPT-4o Mini", provider: "OpenAI", contextWindow: 128000, supportsVision: true, promptPricing: 0.15, completionPricing: 0.6 },
  { modelId: "openai/gpt-4.1", name: "GPT-4.1", provider: "OpenAI", contextWindow: 1000000, supportsVision: true, promptPricing: 2, completionPricing: 8 },
  { modelId: "openai/gpt-4.1-mini", name: "GPT-4.1 Mini", provider: "OpenAI", contextWindow: 1000000, supportsVision: true, promptPricing: 0.4, completionPricing: 1.6 },
  { modelId: "openai/o3-mini", name: "o3-mini", provider: "OpenAI", contextWindow: 200000, supportsVision: false, promptPricing: 1.1, completionPricing: 4.4 },
  { modelId: "meta-llama/llama-4-maverick", name: "Llama 4 Maverick", provider: "Meta", contextWindow: 1000000, supportsVision: true, promptPricing: 0.2, completionPricing: 0.6 },
  { modelId: "meta-llama/llama-3.3-70b-instruct", name: "Llama 3.3 70B", provider: "Meta", contextWindow: 131072, supportsVision: false, promptPricing: 0.18, completionPricing: 0.36 },
  { modelId: "mistralai/mistral-large-2411", name: "Mistral Large", provider: "Mistral", contextWindow: 128000, supportsVision: true, promptPricing: 2, completionPricing: 6 },
  { modelId: "mistralai/mistral-small-2503", name: "Mistral Small", provider: "Mistral", contextWindow: 32000, supportsVision: false, promptPricing: 0.1, completionPricing: 0.3 },
  { modelId: "deepseek/deepseek-chat-v3-0324", name: "DeepSeek V3", provider: "DeepSeek", contextWindow: 131072, supportsVision: false, promptPricing: 0.27, completionPricing: 1.1 },
  { modelId: "deepseek/deepseek-r1", name: "DeepSeek R1", provider: "DeepSeek", contextWindow: 163840, supportsVision: false, promptPricing: 0.55, completionPricing: 2.19 },
];

const ONE_HOUR_MS = 60 * 60 * 1000;

export const list = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const models = await ctx.db.query("modelCatalog").take(500);

    if (models.length === 0) {
      // Return fallback shape without persisting
      return FALLBACK_MODELS.map((m) => ({
        ...m,
        _id: null,
        lastRefreshedAt: 0,
      }));
    }

    return models
      .map((m) => ({
        modelId: m.modelId,
        name: m.name,
        provider: m.provider,
        contextWindow: m.contextWindow,
        supportsVision: m.supportsVision,
        promptPricing: m.promptPricing,
        completionPricing: m.completionPricing,
        _id: m._id,
        lastRefreshedAt: m.lastRefreshedAt,
      }))
      .sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));
  },
});

export const needsRefresh = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { needsRefresh: true, lastRefreshedAt: null };

    const models = await ctx.db.query("modelCatalog").take(1);
    if (models.length === 0) {
      return { needsRefresh: true, lastRefreshedAt: null };
    }

    const oldest = models[0]!;
    const stale = Date.now() - oldest.lastRefreshedAt > ONE_HOUR_MS;
    return { needsRefresh: stale, lastRefreshedAt: oldest.lastRefreshedAt };
  },
});

export const requestRefresh = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    await ctx.scheduler.runAfter(0, internal.modelCatalog.refreshAction, {});
  },
});

export const refreshAction = internalAction({
  args: {},
  handler: async (ctx) => {
    const response = await fetch("https://openrouter.ai/api/v1/models", {
      headers: { "Content-Type": "application/json" },
    });

    if (!response.ok) {
      console.error(`OpenRouter model fetch failed: ${response.status}`);
      return;
    }

    const data = (await response.json()) as {
      data?: Array<{
        id: string;
        name: string;
        context_length?: number;
        architecture?: { modality?: string };
        pricing?: { prompt?: string; completion?: string };
      }>;
    };

    if (!data.data || !Array.isArray(data.data)) {
      console.error("OpenRouter returned unexpected format");
      return;
    }

    // Filter to chat models that have pricing info
    const models = data.data
      .filter((m) => m.pricing?.prompt && m.pricing?.completion)
      .map((m) => {
        const parts = m.id.split("/");
        const providerSlug = parts[0] ?? "unknown";
        // Capitalize provider name
        const provider = providerSlug.charAt(0).toUpperCase() + providerSlug.slice(1);
        // Convert from per-token string to per-1M-tokens number
        const promptPrice = parseFloat(m.pricing!.prompt!) * 1_000_000;
        const completionPrice = parseFloat(m.pricing!.completion!) * 1_000_000;

        return {
          modelId: m.id,
          name: m.name,
          provider,
          contextWindow: m.context_length ?? 0,
          supportsVision: (m.architecture?.modality ?? "").includes("image"),
          promptPricing: Math.round(promptPrice * 100) / 100,
          completionPricing: Math.round(completionPrice * 100) / 100,
          lastRefreshedAt: Date.now(),
        };
      })
      // Keep models that have any pricing — only exclude if BOTH prompt and completion are zero
      .filter((m) => m.promptPricing > 0 || m.completionPricing > 0);

    // Batch upsert in chunks
    const BATCH_SIZE = 50;
    for (let i = 0; i < models.length; i += BATCH_SIZE) {
      const batch = models.slice(i, i + BATCH_SIZE);
      await ctx.runMutation(internal.modelCatalog.upsertModels, {
        models: batch,
      });
    }
  },
});

export const upsertModels = internalMutation({
  args: {
    models: v.array(
      v.object({
        modelId: v.string(),
        name: v.string(),
        provider: v.string(),
        contextWindow: v.number(),
        supportsVision: v.boolean(),
        promptPricing: v.number(),
        completionPricing: v.number(),
        lastRefreshedAt: v.number(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    for (const model of args.models) {
      const existing = await ctx.db
        .query("modelCatalog")
        .withIndex("by_model_id", (q) => q.eq("modelId", model.modelId))
        .unique();

      if (existing) {
        await ctx.db.patch(existing._id, model);
      } else {
        await ctx.db.insert("modelCatalog", model);
      }
    }
  },
});

export const seedFromHardcoded = internalMutation({
  args: {},
  handler: async (ctx) => {
    const existing = await ctx.db.query("modelCatalog").take(1);
    if (existing.length > 0) return;

    for (const model of FALLBACK_MODELS) {
      await ctx.db.insert("modelCatalog", {
        ...model,
        lastRefreshedAt: Date.now(),
      });
    }
  },
});
