import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type ComparisonTolerances,
  compareModels,
  formatComparisonJson,
  formatComparisonMarkdown,
  main,
} from "./modelComparison";
import { runPack } from "./runner";
import { demoSmokeFixturesAllPass } from "./packs/demoPack";

// baseline = planted hard-fail fixtures; candidate = all-pass fixtures (an improvement).
const improving = async (t?: ComparisonTolerances) =>
  compareModels(
    await runPack("demo/smoke"),
    await runPack("demo/smoke-pass"),
    { tolerances: t },
  );

// baseline = all-pass; candidate = planted hard-fail (a regression).
const regressing = async (t?: ComparisonTolerances) =>
  compareModels(
    await runPack("demo/smoke-pass"),
    await runPack("demo/smoke"),
    { tolerances: t },
  );

describe("compareModels — candidate improvements", () => {
  it("detects fixed hard-fail, pass-rate gain, and recommends promote", async () => {
    const cmp = await improving();
    expect(cmp.cases_compared).toBe(50);
    expect(cmp.safety_privacy.hard_fail_fixes).toEqual(["demo-support-balance-00"]);
    expect(cmp.safety_privacy.hard_fail_regressions).toEqual([]);
    expect(cmp.safety_privacy.hard_fail_delta).toBe(-1);
    expect(cmp.quality.candidate_pass_rate).toBeGreaterThan(cmp.quality.baseline_pass_rate);
    expect(cmp.quality.pass_rate_delta).toBeGreaterThan(0);
    expect(cmp.recommendation.decision).toBe("promote");
    expect(cmp.recommendation.blocking).toBe(false);
  });
});

describe("compareModels — candidate hard-fail regressions block", () => {
  it("flags a new privacy hard-fail and recommends reject (blocking)", async () => {
    const cmp = await regressing();
    expect(cmp.safety_privacy.hard_fail_regressions).toEqual([
      {
        case_id: "demo-support-balance-00",
        product: "support-assistant",
        failing_safety_scorers: ["no_cross_context_leakage"],
      },
    ]);
    expect(cmp.safety_privacy.hard_fail_delta).toBe(1);
    expect(cmp.recommendation.decision).toBe("reject");
    expect(cmp.recommendation.blocking).toBe(true);
  });
});

describe("compareModels — cost/latency/token deltas", () => {
  it("aggregates and diffs cost, latency, and tokens", async () => {
    const cmp = await improving();
    const { baseline, candidate, delta } = cmp.cost_latency_tokens;
    // 10 cases carry synthetic cost/latency/token metadata (renewal + paydate factories).
    expect(baseline.cases_with_metrics).toBe(10);
    expect(candidate.cases_with_metrics).toBe(10);
    expect(baseline.mean_tokens).not.toBeNull();
    expect(candidate.mean_tokens).not.toBeNull();
    // Same metadata on both sides → zero deltas, but the fields must be present.
    expect(delta).toEqual({ mean_cost_usd: 0, mean_latency_ms: 0, mean_tokens: 0 });
  });
});

describe("compareModels — coverage of missing fixtures", () => {
  it("represents skipped fixtures and one-sided cases without overstating coverage", async () => {
    const baseline = await runPack("demo/smoke");
    // Candidate scored on a single case only → 49 missing fixtures.
    const candidate = await runPack("demo/smoke", {
      "demo-docs-renewal-00": demoSmokeFixturesAllPass["demo-docs-renewal-00"]!,
    });
    const cmp = compareModels(baseline, candidate);
    expect(cmp.coverage.candidate_missing_fixtures.length).toBe(49);
    expect(cmp.coverage.only_in_baseline.length).toBe(49);
    expect(cmp.cases_compared).toBe(1);
  });

  it("rejects (blocking) a candidate that only scored 1 of 50 baseline cases", async () => {
    const baseline = await runPack("demo/smoke");
    const candidate = await runPack("demo/smoke", {
      "demo-docs-renewal-00": demoSmokeFixturesAllPass["demo-docs-renewal-00"]!,
    });
    const cmp = compareModels(baseline, candidate);
    expect(cmp.recommendation.decision).toBe("reject");
    expect(cmp.recommendation.blocking).toBe(true);
    expect(
      cmp.recommendation.reasons.some((r) => /incomplete|coverage|unscored/i.test(r)),
    ).toBe(true);
  });
});

describe("compareModels — tolerance / decision logic", () => {
  it("rejects an improvement that still misses a configured pass-rate floor", async () => {
    const cmp = await improving({ min_pass_rate: 1.1 }); // unreachable floor
    expect(cmp.recommendation.decision).toBe("reject");
    expect(cmp.recommendation.blocking).toBe(true);
  });

  it("holds when there is no regression and no measurable gain", async () => {
    const same = await runPack("demo/smoke-pass");
    const cmp = compareModels(same, same);
    expect(cmp.quality.pass_rate_delta).toBe(0);
    expect(cmp.safety_privacy.hard_fail_regressions).toEqual([]);
    expect(cmp.recommendation.decision).toBe("hold");
    expect(cmp.recommendation.blocking).toBe(false);
  });

  it("rejects a mean-score drop beyond the configured tolerance", async () => {
    const cmp = await regressing({ max_mean_score_drop: 0.001 });
    expect(cmp.recommendation.decision).toBe("reject");
    expect(cmp.recommendation.reasons.some((r) => r.includes("Mean-score"))).toBe(true);
  });

  it("compares two different fixture packs over the same case set by case id", async () => {
    const cmp = await improving();
    expect(cmp.baseline_pack).toBe("demo/smoke");
    expect(cmp.candidate_pack).toBe("demo/smoke-pass");
    expect(cmp.cases_compared).toBe(50);
    expect(cmp.coverage.only_in_baseline).toEqual([]);
    expect(cmp.coverage.only_in_candidate).toEqual([]);
  });
});

describe("modelComparison — deterministic + management-safe reports", () => {
  it("renders byte-identical reports across runs", async () => {
    const a = formatComparisonJson(await improving()) + formatComparisonMarkdown(await improving());
    const b = formatComparisonJson(await improving()) + formatComparisonMarkdown(await improving());
    expect(a).toBe(b);
  });

  it("never leaks sentinels, transcripts, scorer reasons, or PII-like values", async () => {
    // The regressing comparison is the worst case — the candidate leaks raw data
    // that the scorers caught; the report must not echo any of it.
    const cmp = await regressing();
    const blob = formatComparisonMarkdown(cmp) + "\n" + formatComparisonJson(cmp);
    for (const forbidden of [
      "OTHER-7777", // cross-context sentinel
      "123-45-6789", // synthetic SSN
      "4111111111111111", // synthetic card number
      "Leaked forbidden data", // scorer reason text
      "overdue balance", // raw model output
      "current balance is", // raw model output
    ]) {
      expect(blob).not.toContain(forbidden);
    }
  });

  it("includes every required management-safe section", async () => {
    const md = formatComparisonMarkdown(await improving());
    for (const heading of [
      "## Recommendation",
      "## Quality deltas",
      "## Safety / privacy",
      "## Cost / latency / tokens",
      "## Coverage",
    ]) {
      expect(md).toContain(heading);
    }
  });
});

describe("modelComparison — CLI exit codes", () => {
  // Stub stdout so the full report doesn't spam test output; we only assert exit codes.
  let stdout: ReturnType<typeof vi.spyOn>;
  beforeAll(() => {
    stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  });
  afterAll(() => stdout.mockRestore());

  it("exits 0 when the candidate is a clear improvement (default ordering)", async () => {
    const code = await main(["demo/smoke", "demo/smoke-pass"]);
    expect(code).toBe(0);
  });

  it("exits non-zero when the candidate introduces a hard-fail regression", async () => {
    const code = await main(["demo/smoke-pass", "demo/smoke"]);
    expect(code).toBe(1);
  });
});
