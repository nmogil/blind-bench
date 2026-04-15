import { useEffect, useRef } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { MODELS, type OpenRouterModel } from "@/lib/models";

export interface CatalogModel {
  id: string;
  name: string;
  provider: string;
  contextWindow: number;
  supportsVision: boolean;
  promptPricing: number;
  completionPricing: number;
}

/**
 * Returns the model catalog from the server, falling back to the
 * hardcoded MODELS array when the catalog is unavailable or empty.
 * Auto-triggers a refresh when the catalog is stale (>1 hour).
 */
export function useModelCatalog(): {
  models: CatalogModel[];
  isLoading: boolean;
} {
  const catalogModels = useQuery(api.modelCatalog.list);
  const staleness = useQuery(api.modelCatalog.needsRefresh);
  const requestRefresh = useMutation(api.modelCatalog.requestRefresh);
  const refreshedRef = useRef(false);

  useEffect(() => {
    if (staleness?.needsRefresh && !refreshedRef.current) {
      refreshedRef.current = true;
      requestRefresh().catch(() => {});
    }
  }, [staleness?.needsRefresh, requestRefresh]);

  if (catalogModels === undefined) {
    return { models: fallbackModels(), isLoading: true };
  }

  if (catalogModels.length === 0) {
    return { models: fallbackModels(), isLoading: false };
  }

  return {
    models: catalogModels.map((m) => ({
      id: m.modelId,
      name: m.name,
      provider: m.provider,
      contextWindow: m.contextWindow,
      supportsVision: m.supportsVision,
      promptPricing: m.promptPricing,
      completionPricing: m.completionPricing,
    })),
    isLoading: false,
  };
}

function fallbackModels(): CatalogModel[] {
  return MODELS.map((m: OpenRouterModel) => ({
    id: m.id,
    name: m.name,
    provider: m.provider,
    contextWindow: m.contextWindow,
    supportsVision: m.supportsVision,
    promptPricing: m.promptPricing ?? 0,
    completionPricing: m.completionPricing ?? 0,
  }));
}
