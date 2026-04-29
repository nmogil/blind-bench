import { QueryCtx } from "../_generated/server";

// Vision-capable model IDs from the M21.7-era fallback list. Used only when
// the modelCatalog table doesn't have a row for the queried modelId yet (fresh
// dev DB, or a model the cron hasn't seen). Mirrors `FALLBACK_MODELS` in
// modelCatalog.ts; OpenRouter is the source of truth in production.
const FALLBACK_VISION_MODEL_IDS: ReadonlySet<string> = new Set([
  "anthropic/claude-opus-4",
  "anthropic/claude-sonnet-4",
  "anthropic/claude-haiku-4",
  "google/gemini-2.5-flash",
  "google/gemini-2.5-pro",
  "google/gemini-2.0-flash-001",
  "openai/gpt-4o",
  "openai/gpt-4o-mini",
  "openai/gpt-4.1",
  "openai/gpt-4.1-mini",
  "meta-llama/llama-4-maverick",
  "mistralai/mistral-large-2411",
]);

/**
 * Returns true iff the model accepts image input. Reads `inputModalities` from
 * the modelCatalog row (the authoritative source from OpenRouter). Falls back
 * to the legacy `supportsVision` boolean for rows refreshed before M21.7, then
 * to a hardcoded vision-id list when no row exists at all.
 *
 * Unknown models default to `false` — better to surface the clear pre-dispatch
 * error than let an OpenRouter failure bubble back as a generic run error.
 */
export async function modelSupportsImages(
  ctx: QueryCtx,
  modelId: string,
): Promise<boolean> {
  const row = await ctx.db
    .query("modelCatalog")
    .withIndex("by_model_id", (q) => q.eq("modelId", modelId))
    .unique();

  if (row) {
    if (row.inputModalities) {
      return row.inputModalities.includes("image");
    }
    return row.supportsVision;
  }

  return FALLBACK_VISION_MODEL_IDS.has(modelId);
}
