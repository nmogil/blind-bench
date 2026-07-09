import { SCORECARD_SCORER_CATALOG } from "./scorecardScoring";

export type ScorerConfigValue = string | number | boolean | string[];
export type ScorerConfigMap = Record<string, Record<string, ScorerConfigValue>>;

export interface ProjectScorecardConfig {
  scorerIds: string[];
  scorerConfig: ScorerConfigMap;
}

/**
 * Default deterministic scorers for a production-log case whose `expected` is
 * sparse (no curated must / must_not lists): the three HARD_FAIL safety scorers
 * — no_hallucinated_data, no_cross_context_leakage, read_only_no_destructive_tool
 * — which pass (never hard-fail) when their forbidden lists are empty, plus
 * tone_customer_fit as a standalone quality scorer that grades output tone
 * against built-in defaults. None fails vacuously on a normal captured output.
 */
export const DEFAULT_PRODUCTION_LOG_SCORER_IDS: readonly string[] = [
  "no_hallucinated_data",
  "no_cross_context_leakage",
  "read_only_no_destructive_tool",
  "tone_customer_fit",
];

const CATALOG_BY_ID = new Map(
  SCORECARD_SCORER_CATALOG.map((scorer) => [scorer.id, scorer]),
);

function uniqueKnownScorers(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (!CATALOG_BY_ID.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function normalizeStringList(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/\r?\n|,/)
      : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= 50) break;
  }
  return out;
}

function normalizeNumber(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export function defaultProjectScorecardConfig(): ProjectScorecardConfig {
  return {
    scorerIds: [...DEFAULT_PRODUCTION_LOG_SCORER_IDS],
    scorerConfig: {},
  };
}

/**
 * Keep scorecard config deterministic and management-safe: known scorer ids only,
 * known config field keys only, bounded string lists, and non-negative numbers.
 */
export function sanitizeProjectScorecardConfig(input?: {
  scorerIds?: string[];
  scorerConfig?: ScorerConfigMap;
}): ProjectScorecardConfig {
  const scorerIds = uniqueKnownScorers(input?.scorerIds ?? []);
  const enabled = scorerIds.length ? scorerIds : [...DEFAULT_PRODUCTION_LOG_SCORER_IDS];
  const enabledSet = new Set(enabled);
  const scorerConfig: ScorerConfigMap = {};

  for (const id of enabled) {
    const catalog = CATALOG_BY_ID.get(id);
    const raw = input?.scorerConfig?.[id] ?? {};
    if (!catalog || catalog.configFields.length === 0) continue;
    const next: Record<string, ScorerConfigValue> = {};
    for (const field of catalog.configFields) {
      const rawValue = raw[field.key];
      if (field.type === "stringList") {
        const list = normalizeStringList(rawValue);
        if (list.length > 0) next[field.key] = list;
      } else {
        const n = normalizeNumber(rawValue);
        if (n !== undefined) next[field.key] = n;
      }
    }
    if (Object.keys(next).length > 0 && enabledSet.has(id)) {
      scorerConfig[id] = next;
    }
  }

  return { scorerIds: enabled, scorerConfig };
}
