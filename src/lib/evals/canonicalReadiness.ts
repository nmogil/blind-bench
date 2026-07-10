import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main as scorecardMain } from "./scorecard";
import { main as comparisonMain } from "./modelComparison";
import { main as trainingDatasetMain } from "./trainingDataset";
import { verifyTrainingExportArtifacts } from "./trainingExportVerifier";

export type ReadinessStatus = "pass" | "fail";

export interface ReadinessCheck {
  id: string;
  label: string;
  status: ReadinessStatus;
  artifacts: string[];
  summary: Record<string, string | number | boolean | null>;
  errors?: string[];
}

export interface CanonicalDemoReadinessReport {
  status: ReadinessStatus;
  generated_at: string;
  loop: {
    import_source: string;
    review_signal: string;
    reuse_artifact: string;
  };
  checks: ReadinessCheck[];
  artifact_paths: string[];
  guardrails: string[];
  next_operator_steps: string[];
}

export interface BuildReportOptions {
  generated_at: string;
  checks: ReadinessCheck[];
}

const GUARDRAILS = [
  "Local-only deterministic demo: no live Cloudflare, Fireworks, model-provider, or Convex network calls are required.",
  "Synthetic/internal fixture data only by default; no customer or design-partner traces are imported.",
  "Readiness report contains aggregate counts, decisions, and artifact paths only — no raw prompts, model outputs, transcripts, credentials, or secrets.",
  "Fireworks training/deployment remains an operator step after explicit data-boundary approval.",
];

const NEXT_OPERATOR_STEPS = [
  "Review artifacts/canonical-demo-readiness.md for the local handoff status.",
  "For live Gateway testing, import a customer-owned Cloudflare AI Gateway export only after consent/redaction/retention approval.",
  "For Fireworks testing, use the generated training/export artifacts as handoff inputs; do not start a fine-tune until the dataset manifest says the rows are approved and non-sensitive.",
  "Use the scorecard and comparison reports as management-safe artifacts; keep raw traces inside the authenticated app/review surfaces.",
];

export function buildCanonicalDemoReadinessReport(
  opts: BuildReportOptions,
): CanonicalDemoReadinessReport {
  const status: ReadinessStatus = opts.checks.every((c) => c.status === "pass")
    ? "pass"
    : "fail";
  const artifact_paths = [...new Set(opts.checks.flatMap((c) => c.artifacts))].sort();

  return {
    status,
    generated_at: opts.generated_at,
    loop: {
      import_source: "Synthetic/internal fixture eval pack; live trace import remains operator-gated.",
      review_signal: "Deterministic scorecard/comparison verdicts stand in for the first local readiness signal.",
      reuse_artifact: "Training dataset JSONL + manifest and management-safe scorecard/comparison reports.",
    },
    checks: opts.checks,
    artifact_paths,
    guardrails: GUARDRAILS,
    next_operator_steps: NEXT_OPERATOR_STEPS,
  };
}

export function formatCanonicalDemoReadinessMarkdown(
  report: CanonicalDemoReadinessReport,
): string {
  const lines: string[] = [];
  lines.push("# Canonical demo readiness");
  lines.push("");
  lines.push(`_Generated: ${report.generated_at} · status: **${report.status.toUpperCase()}**_`);
  lines.push("");
  lines.push("## Canonical loop");
  lines.push("");
  lines.push(`- Bring in one run: ${report.loop.import_source}`);
  lines.push(`- Get a verdict: ${report.loop.review_signal}`);
  lines.push(`- Route it back: ${report.loop.reuse_artifact}`);
  lines.push("");
  lines.push("## Checks");
  lines.push("");
  for (const check of report.checks) {
    lines.push(`### ${check.status === "pass" ? "✅" : "❌"} ${check.label}`);
    lines.push("");
    for (const [key, value] of Object.entries(check.summary)) {
      lines.push(`- ${key}: ${value ?? "n/a"}`);
    }
    if (check.artifacts.length) {
      lines.push(`- artifacts: ${check.artifacts.map((p) => `\`${p}\``).join(", ")}`);
    }
    if (check.errors?.length) {
      lines.push("- errors:");
      for (const err of check.errors) lines.push(`  - ${err}`);
    }
    lines.push("");
  }
  lines.push("## Management-safe guardrails");
  lines.push("");
  for (const guardrail of report.guardrails) lines.push(`- ${guardrail}`);
  lines.push("");
  lines.push("## Next operator steps");
  lines.push("");
  for (const step of report.next_operator_steps) lines.push(`- ${step}`);
  lines.push("");
  return lines.join("\n");
}

export function formatCanonicalDemoReadinessJson(
  report: CanonicalDemoReadinessReport,
): string {
  return JSON.stringify(report, null, 2) + "\n";
}

function requiredArtifactCheck(
  id: string,
  label: string,
  artifacts: string[],
  summary: Record<string, string | number | boolean | null>,
  blockingErrors: string[] = [],
): ReadinessCheck {
  const missing = artifacts.filter((p) => !existsSync(p));
  const errors = [...missing.map((p) => `Missing artifact: ${p}`), ...blockingErrors];
  return {
    id,
    label,
    status: errors.length ? "fail" : "pass",
    artifacts,
    summary,
    ...(errors.length ? { errors } : {}),
  };
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export async function runCanonicalDemoReadiness(
  opts: { outDir?: string; generated_at?: string } = {},
): Promise<CanonicalDemoReadinessReport> {
  const outDir = opts.outDir ?? "artifacts";
  const generated_at = opts.generated_at ?? new Date().toISOString();
  mkdirSync(outDir, { recursive: true });

  const scorecardExit = await scorecardMain([]);
  const comparisonExit = await comparisonMain([]);
  const trainingDatasetExit = await trainingDatasetMain([generated_at]);

  const scorecardPath = join(outDir, "ai-quality-scorecard.json");
  const comparisonPath = join(outDir, "model-comparison.json");
  const manifestPath = join(outDir, "training-dataset.manifest.json");

  const scorecard = readJson<{
    quality: { cases_evaluated: number; cases_fully_passing: number; mean_score: number };
    safety_privacy: { hard_failed_cases: number };
    fine_tuning_readiness: { status: string };
  }>(scorecardPath);
  const comparison = readJson<{
    cases_compared: number;
    recommendation: { decision: string; blocking: boolean };
    safety_privacy: { hard_fail_regressions: unknown[] };
  }>(comparisonPath);
  const manifest = readJson<{
    split_counts: { train: number; validation: number; test: number };
    excluded: unknown[];
    dataset_hash: string;
  }>(manifestPath);

  const trainingVerification = verifyTrainingExportArtifacts({ artifactDir: outDir });
  const checks: ReadinessCheck[] = [
    requiredArtifactCheck(
      "scorecard_demo",
      "Management-safe scorecard demo",
      [join(outDir, "ai-quality-scorecard.md"), scorecardPath],
      {
        cases_evaluated: scorecard.quality.cases_evaluated,
        cases_fully_passing: scorecard.quality.cases_fully_passing,
        mean_score: scorecard.quality.mean_score,
        hard_failed_cases: scorecard.safety_privacy.hard_failed_cases,
        fine_tuning_status: scorecard.fine_tuning_readiness.status,
      },
      [
        ...(scorecardExit !== 0 ? [`Scorecard gate exited ${scorecardExit}.`] : []),
        ...(scorecard.safety_privacy.hard_failed_cases > 0 ? ["Scorecard contains blocking safety/privacy hard failures."] : []),
        ...(scorecard.fine_tuning_readiness.status !== "ready" ? [`Fine-tuning gate: ${scorecard.fine_tuning_readiness.status}`] : []),
      ],
    ),
    requiredArtifactCheck(
      "model_comparison_demo",
      "Baseline-vs-candidate comparison demo",
      [join(outDir, "model-comparison.md"), comparisonPath],
      {
        cases_compared: comparison.cases_compared,
        decision: comparison.recommendation.decision,
        blocking: comparison.recommendation.blocking,
        hard_fail_regressions: comparison.safety_privacy.hard_fail_regressions.length,
      },
      [
        ...(comparisonExit !== 0 ? [`Model comparison gate exited ${comparisonExit}.`] : []),
        ...(comparison.recommendation.blocking ? ["Model comparison recommendation is blocking."] : []),
        ...(comparison.safety_privacy.hard_fail_regressions.length > 0 ? ["Model comparison contains safety/privacy hard-fail regressions."] : []),
      ],
    ),
    requiredArtifactCheck(
      "training_dataset_demo",
      "Fireworks-compatible training dataset demo",
      [
        join(outDir, "training-dataset.train.jsonl"),
        join(outDir, "training-dataset.validation.jsonl"),
        join(outDir, "training-dataset.test.jsonl"),
        manifestPath,
      ],
      {
        train_rows: manifest.split_counts.train,
        validation_rows: manifest.split_counts.validation,
        test_rows: manifest.split_counts.test,
        excluded_rows: manifest.excluded.length,
        dataset_hash_prefix: manifest.dataset_hash.slice(0, 16),
        verifier_status: trainingVerification.readiness,
      },
      [
        ...(trainingDatasetExit !== 0 ? [`Training dataset compiler exited ${trainingDatasetExit}.`] : []),
        ...trainingVerification.errors.map((error) => `Training export verifier: ${error}`),
      ],
    ),
  ];

  const report = buildCanonicalDemoReadinessReport({ generated_at, checks });
  writeFileSync(join(outDir, "canonical-demo-readiness.md"), formatCanonicalDemoReadinessMarkdown(report));
  writeFileSync(join(outDir, "canonical-demo-readiness.json"), formatCanonicalDemoReadinessJson(report));
  return report;
}
