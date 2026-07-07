/**
 * Local, deterministic baseline-vs-candidate eval comparison runner (issue #229).
 *
 * Runs ONE eval pack against TWO fixture sets ("baseline" and "candidate",
 * standing in for two model endpoints) and produces a management-safe Markdown +
 * JSON comparison report: pass-rate / mean-score / cost / latency / token deltas,
 * privacy/tool-safety hard-fail regressions, fixture coverage, and an explicit
 * promote/hold/reject recommendation with CI-friendly exit semantics.
 *
 * Pure and local: no live model providers, no Fireworks, no Cloudflare, no Convex,
 * no network. The runner scores fixtures only. Endpoint/provider adapters can be
 * layered on later by feeding their captured outputs in as fixture sets — the
 * comparison logic here is unchanged.
 *
 * MANAGEMENT-SAFE CONTRACT (mirrors scorecard.ts): the report exposes only case
 * IDs, product labels, scorer IDs, scores, and aggregate counts/deltas. It NEVER
 * includes raw prompts, raw model output, transcripts, scorer `reason` strings,
 * account IDs, phone numbers, emails, forbidden sentinels, SSNs, or card-like
 * numbers. `modelComparison.test.ts` scans the rendered artifacts to enforce this.
 *
 * Run it:
 *   npm run compare:demo   # writes artifacts/model-comparison.{md,json}
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { type CaseRow, type Summary, runPack } from "./runner";
import { HARD_FAIL_SCORERS } from "./scorers";

const isHard = (scorer: string) => HARD_FAIL_SCORERS.has(scorer);

/** The hard-fail (privacy/tool-safety) scorers a case row failed, sorted. */
function failingSafetyScorers(row: CaseRow): string[] {
  return row.scores
    .filter((s) => !s.passed && isHard(s.scorer))
    .map((s) => s.scorer)
    .sort();
}

// --- Tolerances + recommendation --------------------------------------------

/**
 * Promote/hold/reject thresholds. All optional; absent thresholds are not
 * enforced. Drops are positive numbers (e.g. `max_pass_rate_drop: 0.02` allows
 * the candidate to lose up to 2 points of pass rate before it blocks).
 */
export interface ComparisonTolerances {
  /** Candidate pass rate (0–1) must be >= this absolute floor. */
  min_pass_rate?: number;
  /** Candidate mean score (0–1) must be >= this absolute floor. */
  min_mean_score?: number;
  /** Max allowed pass-rate regression (baseline − candidate) before blocking. */
  max_pass_rate_drop?: number;
  /** Max allowed mean-score regression (baseline − candidate) before blocking. */
  max_mean_score_drop?: number;
}

export type Decision = "promote" | "hold" | "reject";

export interface Recommendation {
  decision: Decision;
  /** True => CI should exit non-zero. Always true for `reject`. */
  blocking: boolean;
  reasons: string[];
}

// --- Comparison shape --------------------------------------------------------

export interface MetricAggregate {
  cases_with_metrics: number;
  mean_cost_usd: number | null;
  mean_latency_ms: number | null;
  mean_tokens: number | null;
}

export interface MetricDelta {
  /** candidate − baseline; null when either side lacks the metric. */
  mean_cost_usd: number | null;
  mean_latency_ms: number | null;
  mean_tokens: number | null;
}

export interface SafetyFinding {
  case_id: string;
  product: string;
  failing_safety_scorers: string[];
}

export interface ModelComparison {
  baseline_pack: string;
  candidate_pack: string;
  baseline_label: string;
  candidate_label: string;
  cases_compared: number;
  coverage: {
    baseline_missing_fixtures: string[];
    candidate_missing_fixtures: string[];
    /** Cases scored on one side only — not directly comparable. */
    only_in_baseline: string[];
    only_in_candidate: string[];
  };
  quality: {
    baseline_pass_rate: number;
    candidate_pass_rate: number;
    pass_rate_delta: number;
    baseline_mean_score: number;
    candidate_mean_score: number;
    mean_score_delta: number;
    /** Cases that went fail → pass (excludes hard-fail-only flips). */
    fixed: string[];
    /** Cases that went pass → fail without a new hard-fail. */
    regressed: string[];
  };
  safety_privacy: {
    baseline_hard_failed: number;
    candidate_hard_failed: number;
    hard_fail_delta: number;
    /** Cases that newly hard-fail in the candidate. BLOCKING. */
    hard_fail_regressions: SafetyFinding[];
    /** Cases whose baseline hard-fail the candidate cleared. */
    hard_fail_fixes: string[];
  };
  cost_latency_tokens: {
    baseline: MetricAggregate;
    candidate: MetricAggregate;
    delta: MetricDelta;
    note: string;
  };
  tolerances: ComparisonTolerances;
  recommendation: Recommendation;
}

// --- Aggregation helpers -----------------------------------------------------

const round4 = (n: number) => Number(n.toFixed(4));
const mean = (xs: number[]): number | null =>
  xs.length ? round4(xs.reduce((s, x) => s + x, 0) / xs.length) : null;

function aggregateMetrics(rows: CaseRow[]): MetricAggregate {
  const costs: number[] = [];
  const latencies: number[] = [];
  const tokens: number[] = [];
  let withMetrics = 0;
  for (const r of rows) {
    const c = r.metrics?.cost_usd;
    const l = r.metrics?.latency_ms;
    const t = r.metrics?.tokens;
    if (typeof c === "number") costs.push(c);
    if (typeof l === "number") latencies.push(l);
    if (typeof t === "number") tokens.push(t);
    if (typeof c === "number" || typeof l === "number" || typeof t === "number") withMetrics++;
  }
  return {
    cases_with_metrics: withMetrics,
    mean_cost_usd: mean(costs),
    mean_latency_ms: mean(latencies),
    mean_tokens: mean(tokens),
  };
}

const subOrNull = (a: number | null, b: number | null): number | null =>
  a === null || b === null ? null : round4(a - b);

// --- Build the comparison ----------------------------------------------------

export interface CompareOptions {
  baseline_label?: string;
  candidate_label?: string;
  tolerances?: ComparisonTolerances;
  /** Overrides the cost/latency/tokens provenance note (e.g. for live captures). */
  metrics_note?: string;
}

/**
 * Diff two summaries scored over the SAME pack. `baseline` and `candidate` must
 * come from the same pack (same case set); only their fixtures/outputs differ.
 */
export function compareModels(
  baseline: Summary,
  candidate: Summary,
  opts: CompareOptions = {},
): ModelComparison {
  // Compared by case id, not pack name: the two sides may be different fixture
  // packs over the same case set (the default demo). Cases present on only one
  // side are surfaced in `coverage`, never silently matched.
  const tolerances = opts.tolerances ?? {};
  const baseRows = new Map(baseline.results.map((r) => [r.case_id, r]));
  const candRows = new Map(candidate.results.map((r) => [r.case_id, r]));

  // Coverage: which side scored which case.
  const onlyInBaseline = [...baseRows.keys()].filter((id) => !candRows.has(id)).sort();
  const onlyInCandidate = [...candRows.keys()].filter((id) => !baseRows.has(id)).sort();

  // Per-case transitions over the cases scored on BOTH sides.
  const fixed: string[] = [];
  const regressed: string[] = [];
  const hardFailRegressions: SafetyFinding[] = [];
  const hardFailFixes: string[] = [];
  for (const [id, cand] of candRows) {
    const base = baseRows.get(id);
    if (!base) continue;
    // Hard-fail (privacy/tool-safety) transitions are tracked separately and dominate.
    if (cand.hard_failed && !base.hard_failed) {
      hardFailRegressions.push({
        case_id: id,
        product: cand.product,
        failing_safety_scorers: failingSafetyScorers(cand),
      });
    } else if (base.hard_failed && !cand.hard_failed) {
      hardFailFixes.push(id);
    }
    // Soft pass/fail transitions, excluding cases involved in a hard-fail flip.
    if (cand.hard_failed !== base.hard_failed) continue;
    if (!base.passed && cand.passed) fixed.push(id);
    else if (base.passed && !cand.passed) regressed.push(id);
  }
  fixed.sort();
  regressed.sort();
  hardFailFixes.sort();
  hardFailRegressions.sort((a, b) => a.case_id.localeCompare(b.case_id));

  const passRate = (s: Summary) => (s.total ? round4(s.passed / s.total) : 0);
  const baseline_pass_rate = passRate(baseline);
  const candidate_pass_rate = passRate(candidate);
  const pass_rate_delta = round4(candidate_pass_rate - baseline_pass_rate);
  const mean_score_delta = round4(candidate.mean_score - baseline.mean_score);

  const baseMetrics = aggregateMetrics(baseline.results);
  const candMetrics = aggregateMetrics(candidate.results);

  const recommendation = recommend({
    hardFailRegressions,
    candidate_pass_rate,
    candidate_mean_score: candidate.mean_score,
    pass_rate_delta,
    mean_score_delta,
    fixed,
    regressed,
    hardFailFixes,
    tolerances,
    candidateMissingFixtures: [...candidate.missing_fixtures],
    onlyInBaseline,
    baselineMissingFixtures: [...baseline.missing_fixtures],
    onlyInCandidate,
  });

  return {
    baseline_pack: baseline.pack,
    candidate_pack: candidate.pack,
    baseline_label: opts.baseline_label ?? "baseline",
    candidate_label: opts.candidate_label ?? "candidate",
    cases_compared: [...candRows.keys()].filter((id) => baseRows.has(id)).length,
    coverage: {
      baseline_missing_fixtures: [...baseline.missing_fixtures].sort(),
      candidate_missing_fixtures: [...candidate.missing_fixtures].sort(),
      only_in_baseline: onlyInBaseline,
      only_in_candidate: onlyInCandidate,
    },
    quality: {
      baseline_pass_rate,
      candidate_pass_rate,
      pass_rate_delta,
      baseline_mean_score: baseline.mean_score,
      candidate_mean_score: candidate.mean_score,
      mean_score_delta,
      fixed,
      regressed,
    },
    safety_privacy: {
      baseline_hard_failed: baseline.hard_failed,
      candidate_hard_failed: candidate.hard_failed,
      hard_fail_delta: candidate.hard_failed - baseline.hard_failed,
      hard_fail_regressions: hardFailRegressions,
      hard_fail_fixes: hardFailFixes,
    },
    cost_latency_tokens: {
      baseline: baseMetrics,
      candidate: candMetrics,
      delta: {
        mean_cost_usd: subOrNull(candMetrics.mean_cost_usd, baseMetrics.mean_cost_usd),
        mean_latency_ms: subOrNull(candMetrics.mean_latency_ms, baseMetrics.mean_latency_ms),
        mean_tokens: subOrNull(candMetrics.mean_tokens, baseMetrics.mean_tokens),
      },
      note:
        opts.metrics_note ??
        "Synthetic metadata; indicative only. Real cost/latency/token figures require production trace ingestion (#220).",
    },
    tolerances,
    recommendation,
  };
}

// --- Recommendation logic ----------------------------------------------------

interface RecommendInput {
  hardFailRegressions: SafetyFinding[];
  candidate_pass_rate: number;
  candidate_mean_score: number;
  pass_rate_delta: number;
  mean_score_delta: number;
  fixed: string[];
  regressed: string[];
  hardFailFixes: string[];
  tolerances: ComparisonTolerances;
  /** Baseline cases the candidate never scored (no fixture). Blocking. */
  candidateMissingFixtures: string[];
  /** Cases scored on baseline only — candidate coverage gap. Blocking. */
  onlyInBaseline: string[];
  /** Cases the baseline never scored. Reported, not blocking. */
  baselineMissingFixtures: string[];
  /** Cases scored on candidate only — not comparable. Reported, not blocking. */
  onlyInCandidate: string[];
}

/**
 * Explicit promote/hold/reject decision:
 *  - REJECT (blocking) if the candidate introduces ANY privacy/tool-safety
 *    hard-fail regression, has INCOMPLETE coverage of the baseline case set
 *    (missing candidate fixtures, or cases scored on baseline only), OR falls
 *    below a configured absolute minimum, OR regresses pass-rate/mean-score
 *    beyond a configured drop tolerance.
 *  - PROMOTE if not rejected AND the candidate is a net improvement (clears a
 *    hard-fail, fixes a case, or raises pass-rate/mean-score).
 *  - HOLD otherwise: no blocking violation, but no clear gain to justify a promote.
 *
 * Coverage is a hard gate on the CANDIDATE side: a smaller pass-rate denominator
 * is not a pass. Baseline-side gaps are reported but never block the candidate.
 */
function recommend(input: RecommendInput): Recommendation {
  const t = input.tolerances;
  const reasons: string[] = [];
  let blocking = false;

  // Candidate must cover the full baseline case set. A candidate that scored
  // fewer cases must not auto-promote on a smaller denominator.
  const candidateGap = [
    ...new Set([...input.candidateMissingFixtures, ...input.onlyInBaseline]),
  ].sort();
  if (candidateGap.length > 0) {
    blocking = true;
    reasons.push(
      `Incomplete candidate coverage: ${candidateGap.length} baseline case(s) unscored by the candidate. Pass rate is not comparable until coverage is complete.`,
    );
  }
  // Baseline-side gaps are informational — they do not block the candidate.
  const baselineGap = [...new Set([...input.baselineMissingFixtures, ...input.onlyInCandidate])];
  if (baselineGap.length > 0) {
    reasons.push(
      `Note: ${baselineGap.length} case(s) scored on the candidate only (baseline coverage gap); not blocking.`,
    );
  }

  if (input.hardFailRegressions.length > 0) {
    blocking = true;
    reasons.push(
      `${input.hardFailRegressions.length} privacy/tool-safety hard-fail regression(s): ${input.hardFailRegressions
        .map((f) => f.case_id)
        .join(", ")}.`,
    );
  }
  if (t.min_pass_rate !== undefined && input.candidate_pass_rate < t.min_pass_rate) {
    blocking = true;
    reasons.push(`Candidate pass rate ${input.candidate_pass_rate} < min ${t.min_pass_rate}.`);
  }
  if (t.min_mean_score !== undefined && input.candidate_mean_score < t.min_mean_score) {
    blocking = true;
    reasons.push(`Candidate mean score ${input.candidate_mean_score} < min ${t.min_mean_score}.`);
  }
  if (t.max_pass_rate_drop !== undefined && -input.pass_rate_delta > t.max_pass_rate_drop) {
    blocking = true;
    reasons.push(
      `Pass-rate dropped ${round4(-input.pass_rate_delta)} > tolerance ${t.max_pass_rate_drop}.`,
    );
  }
  if (t.max_mean_score_drop !== undefined && -input.mean_score_delta > t.max_mean_score_drop) {
    blocking = true;
    reasons.push(
      `Mean-score dropped ${round4(-input.mean_score_delta)} > tolerance ${t.max_mean_score_drop}.`,
    );
  }

  if (blocking) return { decision: "reject", blocking: true, reasons };

  const improved =
    input.hardFailFixes.length > 0 ||
    input.pass_rate_delta > 0 ||
    input.mean_score_delta > 0 ||
    (input.fixed.length > 0 && input.regressed.length === 0);
  if (improved) {
    if (input.hardFailFixes.length)
      reasons.push(`Cleared ${input.hardFailFixes.length} baseline hard-fail(s).`);
    if (input.pass_rate_delta > 0) reasons.push(`Pass rate up ${input.pass_rate_delta}.`);
    if (input.mean_score_delta > 0) reasons.push(`Mean score up ${input.mean_score_delta}.`);
    return { decision: "promote", blocking: false, reasons };
  }

  reasons.push("No blocking regressions, but no measurable improvement over baseline.");
  return { decision: "hold", blocking: false, reasons };
}

// --- Formatting --------------------------------------------------------------

export function formatComparisonJson(cmp: ModelComparison): string {
  return JSON.stringify(cmp, null, 2);
}

const signed = (n: number | null, unit = "") =>
  n === null ? "n/a" : `${n > 0 ? "+" : ""}${n}${unit}`;
const pct = (n: number) => `${Math.round(n * 100)}%`;
// Pass-rate deltas read in percentage points, not raw decimals (+0.04 → +4pp).
const signedPp = (n: number) => `${n > 0 ? "+" : ""}${round4(n * 100)}pp`;

export function formatComparisonMarkdown(cmp: ModelComparison): string {
  const L: string[] = [];
  const q = cmp.quality;
  const sp = cmp.safety_privacy;
  const clt = cmp.cost_latency_tokens;

  L.push("# Baseline vs candidate model comparison");
  L.push("");
  L.push(
    `_Packs: \`${cmp.baseline_pack}\` → \`${cmp.candidate_pack}\` · ${cmp.baseline_label} → ${cmp.candidate_label} · deterministic local run._`,
  );
  L.push("");

  L.push("## Recommendation");
  L.push("");
  const verdict = { promote: "✅ PROMOTE", hold: "⏸ HOLD", reject: "🛑 REJECT" }[
    cmp.recommendation.decision
  ];
  L.push(`- **${verdict}**${cmp.recommendation.blocking ? " (blocking — CI fails)" : ""}`);
  for (const r of cmp.recommendation.reasons) L.push(`  - ${r}`);
  L.push("");

  L.push("## Quality deltas");
  L.push("");
  L.push(
    `- Pass rate: ${pct(q.baseline_pass_rate)} → ${pct(q.candidate_pass_rate)} (${signedPp(q.pass_rate_delta)})`,
  );
  L.push(
    `- Mean score: ${q.baseline_mean_score} → ${q.candidate_mean_score} (${signed(q.mean_score_delta)})`,
  );
  L.push(`- Cases compared: ${cmp.cases_compared}`);
  L.push(`- Fixed (fail → pass): ${q.fixed.length ? q.fixed.map((c) => `\`${c}\``).join(", ") : "none"}`);
  L.push(
    `- Regressed (pass → fail): ${q.regressed.length ? q.regressed.map((c) => `\`${c}\``).join(", ") : "none"}`,
  );
  L.push("");

  L.push("## Safety / privacy");
  L.push("");
  L.push("> Hard-fails are privacy/tool-safety violations and are blocking.");
  L.push("");
  L.push(`- Hard-failed cases: ${sp.baseline_hard_failed} → ${sp.candidate_hard_failed} (${signed(sp.hard_fail_delta)})`);
  L.push(
    `- Hard-fail fixes: ${sp.hard_fail_fixes.length ? sp.hard_fail_fixes.map((c) => `\`${c}\``).join(", ") : "none"}`,
  );
  if (sp.hard_fail_regressions.length) {
    L.push("- **Hard-fail regressions (blocking):**");
    L.push("");
    L.push("| Case | Product | Failing safety scorers |");
    L.push("| --- | --- | --- |");
    for (const f of sp.hard_fail_regressions) {
      L.push(
        `| \`${f.case_id}\` | ${f.product} | ${f.failing_safety_scorers.map((s) => `\`${s}\``).join(", ") || "—"} |`,
      );
    }
  } else {
    L.push("- Hard-fail regressions: none.");
  }
  L.push("");

  L.push("## Cost / latency / tokens");
  L.push("");
  L.push("| Metric | Baseline | Candidate | Delta |");
  L.push("| --- | --- | --- | --- |");
  const fmt = (n: number | null, unit = "") => (n === null ? "n/a" : `${n}${unit}`);
  L.push(
    `| Mean cost (USD) | ${fmt(clt.baseline.mean_cost_usd)} | ${fmt(clt.candidate.mean_cost_usd)} | ${signed(clt.delta.mean_cost_usd)} |`,
  );
  L.push(
    `| Mean latency (ms) | ${fmt(clt.baseline.mean_latency_ms)} | ${fmt(clt.candidate.mean_latency_ms)} | ${signed(clt.delta.mean_latency_ms)} |`,
  );
  L.push(
    `| Mean tokens | ${fmt(clt.baseline.mean_tokens)} | ${fmt(clt.candidate.mean_tokens)} | ${signed(clt.delta.mean_tokens)} |`,
  );
  L.push("");
  L.push(`- Cases with metrics: baseline ${clt.baseline.cases_with_metrics}, candidate ${clt.candidate.cases_with_metrics}`);
  L.push(`- ${clt.note}`);
  L.push("");

  L.push("## Coverage");
  L.push("");
  L.push(`- Baseline missing fixtures: ${cmp.coverage.baseline_missing_fixtures.length}`);
  L.push(`- Candidate missing fixtures: ${cmp.coverage.candidate_missing_fixtures.length}`);
  L.push(
    `- Scored on baseline only: ${cmp.coverage.only_in_baseline.length ? cmp.coverage.only_in_baseline.map((c) => `\`${c}\``).join(", ") : "none"}`,
  );
  L.push(
    `- Scored on candidate only: ${cmp.coverage.only_in_candidate.length ? cmp.coverage.only_in_candidate.map((c) => `\`${c}\``).join(", ") : "none"}`,
  );
  L.push("");

  return L.join("\n");
}

// --- CLI entrypoint ----------------------------------------------------------

const OUT_DIR = "artifacts";
const BASENAME = "model-comparison";
// Default demo: baseline = planted hard-fail fixtures, candidate = all-pass fixtures,
// over the SAME synthetic demo pack. Candidate is a clear improvement
// (clears the planted privacy hard-fail) so the CLI exits 0.
const DEFAULT_BASELINE_PACK = "demo/smoke";
const DEFAULT_CANDIDATE_PACK = "demo/smoke-pass";

export async function main(argv: string[]): Promise<number> {
  const baselinePack = argv[0] ?? DEFAULT_BASELINE_PACK;
  const candidatePack = argv[1] ?? DEFAULT_CANDIDATE_PACK;
  const baseline = await runPack(baselinePack);
  const candidate = await runPack(candidatePack);
  const cmp = compareModels(baseline, candidate, {
    baseline_label: `baseline (${baselinePack})`,
    candidate_label: `candidate (${candidatePack})`,
  });

  const md = formatComparisonMarkdown(cmp);
  const json = formatComparisonJson(cmp);
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(`${OUT_DIR}/${BASENAME}.md`, md);
  writeFileSync(`${OUT_DIR}/${BASENAME}.json`, json);

  process.stdout.write(md + "\n");
  process.stdout.write(
    `\nWrote ${OUT_DIR}/${BASENAME}.{md,json} — decision: ${cmp.recommendation.decision}.\n`,
  );
  // CI gate: non-zero only when the candidate is blocking (hard-fail regression
  // or configured-minimum failure). promote/hold succeed.
  return cmp.recommendation.blocking ? 1 : 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
