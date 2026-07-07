/**
 * Management-safe customer scorecard generator.
 *
 * Wraps the local eval runner's `Summary` into a customer-facing scorecard
 * artifact (Markdown + JSON). Deterministic and local-only: no network, no
 * hosted infra, no timestamps.
 *
 * MANAGEMENT-SAFE CONTRACT: the scorecard exposes only case IDs, product
 * labels, scorer IDs, and aggregate counts. It never includes raw model
 * outputs, transcripts, or scorer `reason` strings — those can echo the very
 * forbidden/leaked values a hard-fail scorer caught. `scorecard.test.ts`
 * scans the rendered artifacts to enforce this.
 *
 * Run it:
 *   npm run scorecard:demo     # writes artifacts/ai-quality-scorecard.{md,json}
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { AgentOutput } from "./evalCase";
import { PACKS, type Summary, runPack } from "./runner";
import { HARD_FAIL_SCORERS } from "./scorers";

const isHard = (scorer: string) => HARD_FAIL_SCORERS.has(scorer);

/** Count occurrences keyed by string, sorted desc then by key for determinism. */
function tally(keys: string[]): { key: string; count: number }[] {
  const m = new Map<string, number>();
  for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1);
  return [...m.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

export interface Scorecard {
  pack: string;
  scope: { products: string[]; cases_evaluated: number; dataset: string; review_basis: string };
  coverage: { missing_fixtures: string[] };
  quality: {
    cases_evaluated: number;
    cases_fully_passing: number;
    cases_with_soft_issues: number;
    mean_score: number;
    soft_failures_by_scorer: { key: string; count: number }[];
  };
  safety_privacy: {
    hard_failed_cases: number;
    findings: { case_id: string; product: string; failing_safety_scorers: string[] }[];
    by_scorer: { key: string; count: number }[];
  };
  cost_latency: {
    cases_with_metrics: number;
    mean_cost_usd: number | null;
    mean_latency_ms: number | null;
    note: string;
  };
  regression_set_updates: {
    regression_set_size: number;
    cases_to_remediate: string[];
    cases_approved_for_training_export: number;
  };
  fine_tuning_readiness: {
    reviewed_examples: number;
    preference_pairs: number;
    status: string;
  };
  next_actions: string[];
}

const FOLLOW_UP_TICKETS = [
  "#220 real Cloudflare AI Gateway production trace ingestion",
  "#234 human review console for preference labels",
  "#233 agent harness trace capture",
  "#228 Fireworks training dataset compiler",
];

/**
 * Build the management-safe scorecard from a runner `Summary`. Cost/latency
 * uses the metrics attached to the scored case rows. The optional `fixtures`
 * fallback exists only for older summaries that predate per-row metrics.
 */
export function buildScorecard(summary: Summary, fixtures?: Record<string, AgentOutput>): Scorecard {
  const source = fixtures ?? PACKS[summary.pack]?.fixtures ?? {};

  // Per-case scorer failures, split hard (safety/privacy) vs soft (quality).
  const softFailures: string[] = [];
  const safetyFindings: Scorecard["safety_privacy"]["findings"] = [];
  for (const r of summary.results) {
    const failing = r.scores.filter((s) => !s.passed).map((s) => s.scorer);
    softFailures.push(...failing.filter((s) => !isHard(s)));
    const hardFails = failing.filter(isHard);
    if (hardFails.length) {
      safetyFindings.push({ case_id: r.case_id, product: r.product, failing_safety_scorers: hardFails.sort() });
    }
  }
  safetyFindings.sort((a, b) => a.case_id.localeCompare(b.case_id));

  // Aggregate cost/latency from output.raw where present (synthetic metadata).
  const costs: number[] = [];
  const latencies: number[] = [];
  let casesWithMetrics = 0;
  for (const r of summary.results) {
    const fallbackRaw = (source[r.case_id]?.raw ?? {}) as Record<string, unknown>;
    const cost = r.metrics?.cost_usd ?? fallbackRaw.cost_usd;
    const latency = r.metrics?.latency_ms ?? fallbackRaw.latency_ms;
    const hasCost = typeof cost === "number";
    const hasLatency = typeof latency === "number";
    if (hasCost) costs.push(cost);
    if (hasLatency) latencies.push(latency);
    if (hasCost || hasLatency) casesWithMetrics++;
  }
  const mean = (xs: number[]) => (xs.length ? Number((xs.reduce((s, x) => s + x, 0) / xs.length).toFixed(4)) : null);

  const casesWithSoftIssues = summary.results.filter(
    (r) => r.scores.some((s) => !s.passed && !isHard(s.scorer)),
  ).length;

  return {
    pack: summary.pack,
    scope: {
      products: [...new Set(summary.results.map((r) => r.product))].sort(),
      cases_evaluated: summary.total,
      dataset: "Synthetic demo smoke pack (fake data only; no production PII or transcripts).",
      review_basis: "Deterministic local scorers. LLM-judge and human review not yet applied.",
    },
    coverage: { missing_fixtures: [...summary.missing_fixtures].sort() },
    quality: {
      cases_evaluated: summary.total,
      cases_fully_passing: summary.passed,
      cases_with_soft_issues: casesWithSoftIssues,
      mean_score: summary.mean_score,
      soft_failures_by_scorer: tally(softFailures),
    },
    safety_privacy: {
      hard_failed_cases: summary.hard_failed,
      findings: safetyFindings,
      by_scorer: tally(safetyFindings.flatMap((f) => f.failing_safety_scorers)),
    },
    cost_latency: {
      cases_with_metrics: casesWithMetrics,
      mean_cost_usd: mean(costs),
      mean_latency_ms: mean(latencies),
      note: "Synthetic metadata; indicative only. Real cost/latency requires production trace ingestion (#220).",
    },
    regression_set_updates: {
      regression_set_size: summary.total,
      cases_to_remediate: safetyFindings.map((f) => f.case_id),
      cases_approved_for_training_export: 0,
    },
    fine_tuning_readiness: {
      reviewed_examples: 0,
      preference_pairs: 0,
      status: "Not ready — pack is synthetic and unreviewed. Needs human-approved production-derived examples.",
    },
    next_actions: [
      ...(summary.hard_failed > 0
        ? [`Remediate ${summary.hard_failed} safety/privacy hard-fail case(s) before any production exposure: ${safetyFindings.map((f) => f.case_id).join(", ")}.`]
        : ["No safety/privacy hard-fails in this run; keep them gated in CI."]),
      ...FOLLOW_UP_TICKETS.map((t) => `Follow-up: ${t}.`),
    ],
  };
}

// --- formatting --------------------------------------------------------------

export function formatScorecardJson(card: Scorecard): string {
  return JSON.stringify(card, null, 2);
}

export function formatScorecardMarkdown(card: Scorecard): string {
  const L: string[] = [];
  const q = card.quality;
  const passRate = q.cases_evaluated ? Math.round((q.cases_fully_passing / q.cases_evaluated) * 100) : 0;

  L.push("# Customer AI Quality Scorecard");
  L.push("");
  L.push(`_Pack: \`${card.pack}\` · synthetic demo smoke pack · deterministic local run._`);
  L.push("");

  L.push("## Executive summary");
  L.push("");
  L.push(`- **${q.cases_fully_passing}/${q.cases_evaluated} cases fully passing** (${passRate}%), mean quality score ${q.mean_score}.`);
  L.push(
    card.safety_privacy.hard_failed_cases > 0
      ? `- **${card.safety_privacy.hard_failed_cases} safety/privacy hard-fail(s)** — blocking. Must be remediated before production exposure.`
      : "- **0 safety/privacy hard-fails** — no blocking findings in this run.",
  );
  L.push(`- ${q.cases_with_soft_issues} case(s) had soft quality issues (non-blocking).`);
  L.push(
    `- Recommendation: ${card.safety_privacy.hard_failed_cases > 0 ? "do not ship the evaluated configuration until hard-fails clear" : "configuration clears the gate; proceed to broader review"}.`,
  );
  L.push("");

  L.push("## Scope");
  L.push("");
  L.push(`- Products evaluated: ${card.scope.products.join(", ")}`);
  L.push(`- Cases evaluated: ${card.scope.cases_evaluated}`);
  L.push(`- Missing fixtures skipped: ${card.coverage.missing_fixtures.length}`);
  L.push(`- Dataset: ${card.scope.dataset}`);
  L.push(`- Review basis: ${card.scope.review_basis}`);
  L.push("");

  L.push("## Quality results");
  L.push("");
  L.push(`- Cases fully passing: ${q.cases_fully_passing}/${q.cases_evaluated}`);
  L.push(`- Cases with soft quality issues: ${q.cases_with_soft_issues}`);
  L.push(`- Mean quality score: ${q.mean_score}`);
  if (q.soft_failures_by_scorer.length) {
    L.push("- Top soft failure modes:");
    for (const f of q.soft_failures_by_scorer) L.push(`  - \`${f.key}\`: ${f.count} case(s)`);
  } else {
    L.push("- Top soft failure modes: none.");
  }
  L.push("");

  L.push("## Safety/privacy results");
  L.push("");
  L.push("> Hard-fails are blocking and tracked separately from soft quality scores.");
  L.push("");
  L.push(`- Hard-failed cases: ${card.safety_privacy.hard_failed_cases}`);
  if (card.safety_privacy.findings.length) {
    L.push("- Findings (case ID + safety scorer only; no raw content):");
    L.push("");
    L.push("| Case | Product | Failing safety scorers |");
    L.push("| --- | --- | --- |");
    for (const f of card.safety_privacy.findings) {
      L.push(`| \`${f.case_id}\` | ${f.product} | ${f.failing_safety_scorers.map((s) => `\`${s}\``).join(", ")} |`);
    }
  } else {
    L.push("- No cross-context leakage, hallucinated data, or destructive-tool findings.");
  }
  L.push("");

  L.push("## Cost/latency note");
  L.push("");
  L.push(`- Cases with metrics: ${card.cost_latency.cases_with_metrics}`);
  L.push(`- Mean cost: ${card.cost_latency.mean_cost_usd === null ? "n/a" : `$${card.cost_latency.mean_cost_usd}`}`);
  L.push(`- Mean latency: ${card.cost_latency.mean_latency_ms === null ? "n/a" : `${card.cost_latency.mean_latency_ms} ms`}`);
  L.push(`- ${card.cost_latency.note}`);
  L.push("");

  L.push("## Regression set updates");
  L.push("");
  L.push(`- Regression set size: ${card.regression_set_updates.regression_set_size} cases`);
  L.push(
    `- Cases to remediate: ${card.regression_set_updates.cases_to_remediate.map((c) => `\`${c}\``).join(", ") || "none"}`,
  );
  L.push(`- Cases approved for training export: ${card.regression_set_updates.cases_approved_for_training_export}`);
  L.push("");

  L.push("## Fine-tuning readiness");
  L.push("");
  L.push(`- Reviewed examples: ${card.fine_tuning_readiness.reviewed_examples}`);
  L.push(`- Preference pairs: ${card.fine_tuning_readiness.preference_pairs}`);
  L.push(`- Status: ${card.fine_tuning_readiness.status}`);
  L.push("");

  L.push("## Recommended next actions");
  L.push("");
  for (const a of card.next_actions) L.push(`- ${a}`);
  L.push("");

  return L.join("\n");
}

// --- CLI entrypoint ----------------------------------------------------------

const DEFAULT_PACK = "demo/smoke";
const OUT_DIR = "artifacts";

export async function main(argv: string[]): Promise<number> {
  const pack = argv[0] ?? DEFAULT_PACK;
  const summary = await runPack(pack);
  const card = buildScorecard(summary);
  const md = formatScorecardMarkdown(card);
  const json = formatScorecardJson(card);

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(`${OUT_DIR}/ai-quality-scorecard.md`, md);
  writeFileSync(`${OUT_DIR}/ai-quality-scorecard.json`, json);

  process.stdout.write(md + "\n");
  process.stdout.write(
    `\nWrote ${OUT_DIR}/ai-quality-scorecard.md and .json (${card.safety_privacy.hard_failed_cases} hard-fail(s)).\n`,
  );
  // Reporting command only: hard-fails remain visible in the artifact but do not
  // make scorecard generation fail. Use the lower-level eval CLI for CI gates.
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
