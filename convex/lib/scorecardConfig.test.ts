import { describe, expect, it } from "vitest";
import {
  DEFAULT_PRODUCTION_LOG_SCORER_IDS,
  sanitizeProjectScorecardConfig,
} from "./scorecardConfig";

describe("sanitizeProjectScorecardConfig", () => {
  it("falls back to the production-log default assignment", () => {
    expect(sanitizeProjectScorecardConfig()).toEqual({
      scorerIds: [...DEFAULT_PRODUCTION_LOG_SCORER_IDS],
      scorerConfig: {},
    });
  });

  it("keeps known scorers, drops unknown ids, de-dupes, and keeps valid config", () => {
    const config = sanitizeProjectScorecardConfig({
      scorerIds: [
        "no_hallucinated_data",
        "unknown_scorer",
        "no_hallucinated_data",
        "cost_latency_threshold",
      ],
      scorerConfig: {
        no_hallucinated_data: {
          phrases: [" ssn 123 ", "", "ssn 123", "routing number"],
          ignored: ["not-a-field"],
        },
        cost_latency_threshold: {
          maxLatencyMs: "2500" as unknown as number,
          maxCostUsd: -1,
        },
        unknown_scorer: { phrases: ["drop me"] },
      },
    });

    expect(config).toEqual({
      scorerIds: ["no_hallucinated_data", "cost_latency_threshold"],
      scorerConfig: {
        no_hallucinated_data: { phrases: ["ssn 123", "routing number"] },
        cost_latency_threshold: { maxLatencyMs: 2500 },
      },
    });
  });

  it("normalizes comma/newline phrase input and drops config for disabled scorers", () => {
    const config = sanitizeProjectScorecardConfig({
      scorerIds: ["tone_customer_fit"],
      scorerConfig: {
        tone_customer_fit: { banned: "obviously, calm down\nwhatever" },
        no_hallucinated_data: { phrases: ["disabled"] },
      },
    });

    expect(config).toEqual({
      scorerIds: ["tone_customer_fit"],
      scorerConfig: {
        tone_customer_fit: { banned: ["obviously", "calm down", "whatever"] },
      },
    });
  });
});
