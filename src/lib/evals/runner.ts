/**
 * Local, portable eval runner. No hosted Blind Bench infra, no network calls:
 * it scores synthetic fixture outputs against a pack's assigned scorers and emits
 * JSON + Markdown summaries. The CLI (`cli.ts`) is a thin wrapper over this.
 */
import { AgentOutput, EvalCase, type EvalResult } from "./evalCase";
import { scoreCase } from "./scorers";
import {
  customerPilotSmokeCases,
  customerPilotSmokeFixtures,
  customerPilotSmokeFixturesAllPass,
} from "./packs/customerPilot";

export interface Pack {
  cases: typeof customerPilotSmokeCases;
  fixtures: Record<string, AgentOutput>;
}

export const PACKS: Record<string, Pack> = {
  "customer-pilot/smoke": { cases: customerPilotSmokeCases, fixtures: customerPilotSmokeFixtures },
  // All-pass variant, handy for CI smoke / exit-behavior demos.
  "customer-pilot/smoke-pass": { cases: customerPilotSmokeCases, fixtures: customerPilotSmokeFixturesAllPass },
};

export interface CaseRow {
  case_id: string;
  product: string;
  title: string;
  score: number;
  passed: boolean;
  hard_failed: boolean;
  metrics?: {
    cost_usd?: number;
    latency_ms?: number;
  };
  scores: Pick<EvalResult["scores"][number], "scorer" | "passed" | "hard_fail" | "reason">[];
}

export interface Summary {
  pack: string;
  total: number;
  passed: number;
  failed: number;
  hard_failed: number;
  missing_fixtures: string[];
  mean_score: number;
  results: CaseRow[];
}

/** Score every case in a pack against `fixtures` (defaults to the pack's own). */
export async function runPack(
  packName: string,
  fixtures?: Record<string, AgentOutput>,
): Promise<Summary> {
  const pack = PACKS[packName];
  if (!pack) {
    throw new Error(`Unknown pack: ${packName}. Known: ${Object.keys(PACKS).join(", ")}`);
  }
  const source = fixtures ?? pack.fixtures;
  const results: CaseRow[] = [];
  const missing: string[] = [];

  for (const raw of pack.cases) {
    const evalCase = EvalCase.parse(raw);
    const fixture = source[evalCase.id];
    if (!fixture) {
      missing.push(evalCase.id);
      continue;
    }
    const output = AgentOutput.parse(fixture);
    const outputRaw = (output.raw ?? {}) as Record<string, unknown>;
    const metrics = {
      ...(typeof outputRaw.cost_usd === "number" ? { cost_usd: outputRaw.cost_usd } : {}),
      ...(typeof outputRaw.latency_ms === "number" ? { latency_ms: outputRaw.latency_ms } : {}),
    };
    const { scores, score, passed, hard_failed } = await scoreCase(evalCase, output);
    results.push({
      case_id: evalCase.id,
      product: evalCase.product,
      title: evalCase.title,
      score,
      passed,
      hard_failed,
      ...(Object.keys(metrics).length ? { metrics } : {}),
      scores: scores.map((s) => ({
        scorer: s.scorer,
        passed: s.passed,
        hard_fail: s.hard_fail,
        reason: s.reason,
      })),
    });
  }

  const passed = results.filter((r) => r.passed).length;
  const hard_failed = results.filter((r) => r.hard_failed).length;
  const mean =
    results.length === 0
      ? 0
      : results.reduce((s, r) => s + r.score, 0) / results.length;

  return {
    pack: packName,
    total: results.length,
    passed,
    failed: results.length - passed,
    hard_failed,
    missing_fixtures: missing,
    mean_score: Number(mean.toFixed(4)),
    results,
  };
}

/** Baseline-vs-candidate diff: which cases regressed (pass→fail) or got fixed. */
export interface Comparison {
  regressions: string[];
  fixes: string[];
  baseline_passed: number;
  candidate_passed: number;
}
export function compareSummaries(baseline: Summary, candidate: Summary): Comparison {
  const base = new Map(baseline.results.map((r) => [r.case_id, r.passed]));
  const regressions: string[] = [];
  const fixes: string[] = [];
  for (const r of candidate.results) {
    const was = base.get(r.case_id);
    if (was === true && !r.passed) regressions.push(r.case_id);
    if (was === false && r.passed) fixes.push(r.case_id);
  }
  return {
    regressions,
    fixes,
    baseline_passed: baseline.passed,
    candidate_passed: candidate.passed,
  };
}

// --- formatting --------------------------------------------------------------

export function formatJson(summary: Summary, comparison?: Comparison): string {
  return JSON.stringify({ ...summary, comparison }, null, 2);
}

export function formatMarkdown(summary: Summary, comparison?: Comparison): string {
  const lines: string[] = [];
  lines.push(`# Blind Bench eval summary — \`${summary.pack}\``);
  lines.push("");
  lines.push(
    `**${summary.passed}/${summary.total} passed** · ` +
      `${summary.hard_failed} hard-fail · ` +
      `mean score ${summary.mean_score}`,
  );
  if (summary.missing_fixtures.length) {
    lines.push("");
    lines.push(`> ⚠ ${summary.missing_fixtures.length} case(s) had no fixture and were skipped.`);
  }
  lines.push("");
  lines.push("| Case | Product | Score | Result | Failing scorers |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const r of summary.results) {
    const verdict = r.hard_failed ? "🛑 hard-fail" : r.passed ? "✅ pass" : "⚠ fail";
    const failing = r.scores
      .filter((s) => !s.passed)
      .map((s) => (s.hard_fail ? `**${s.scorer}**` : s.scorer))
      .join(", ");
    lines.push(
      `| \`${r.case_id}\` | ${r.product} | ${r.score.toFixed(2)} | ${verdict} | ${failing || "—"} |`,
    );
  }
  if (comparison) {
    lines.push("");
    lines.push("## Baseline vs candidate");
    lines.push("");
    lines.push(
      `- baseline passed: ${comparison.baseline_passed} → candidate passed: ${comparison.candidate_passed}`,
    );
    lines.push(`- regressions: ${comparison.regressions.join(", ") || "none"}`);
    lines.push(`- fixes: ${comparison.fixes.join(", ") || "none"}`);
  }
  lines.push("");
  return lines.join("\n");
}
