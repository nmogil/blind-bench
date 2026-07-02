/**
 * Live baseline-vs-candidate endpoint comparison CLI (issue #229).
 *
 * Captures one eval pack's cases from TWO live OpenAI-compatible endpoints
 * (e.g. current production model vs a Fireworks candidate routed through
 * Cloudflare AI Gateway), scores both with the existing runner, and emits the
 * modelComparison Markdown/JSON report with promote/hold/reject CI exit
 * semantics. Endpoint request failures surface as candidate coverage gaps,
 * which block promotion (fail-closed).
 *
 *   npx tsx src/lib/evals/compareEndpoints.ts \
 *     --pack customer-pilot/smoke \
 *     --baseline ./baseline-endpoint.json \
 *     --candidate fireworks:env \
 *     --out-dir artifacts
 *
 * Endpoint config JSON: { label, url, model, headers?, max_tokens?, temperature? }.
 * Header values use $ENV_VAR placeholders (never raw secrets). The special spec
 * `fireworks:env` builds the candidate from CF_* / FIREWORKS_* env vars and
 * fails closed when they are missing. Captured outputs are written alongside
 * the reports as fixture files replayable via `cli.ts --candidate-fixtures`.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  type Capture,
  captureOutputs,
  EndpointConfig,
  fireworksCandidateEndpoint,
} from "./endpointAdapter";
import {
  compareModels,
  formatComparisonJson,
  formatComparisonMarkdown,
} from "./modelComparison";
import { PACKS, runPack } from "./runner";

// --- args + config -----------------------------------------------------------

const OUT_BASENAME = "live-endpoint-comparison";
const USAGE =
  "usage: compareEndpoints --pack <pack> --baseline <endpoint.json> " +
  "--candidate <endpoint.json | fireworks:env> [--out-dir artifacts]\n";

function parseArgs(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a?.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[a.slice(2)] = next;
      i++;
    }
  }
  return flags;
}

function loadEndpoint(
  spec: string,
  env: Record<string, string | undefined>,
): EndpointConfig {
  if (spec === "fireworks:env") return fireworksCandidateEndpoint(env);
  return EndpointConfig.parse(JSON.parse(readFileSync(spec, "utf8")));
}

function reportCaptureErrors(side: string, capture: Capture): void {
  for (const e of capture.errors) {
    process.stderr.write(`${side} capture failed for ${e.case_id}: ${e.error}\n`);
  }
}

// --- main --------------------------------------------------------------------

export interface Deps {
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  now?: () => number;
}

export async function main(argv: string[], deps: Deps = {}): Promise<number> {
  const flags = parseArgs(argv);
  const packName = flags.pack ?? "customer-pilot/smoke";
  const pack = PACKS[packName];
  if (!flags.baseline || !flags.candidate || !pack) {
    if (!pack) process.stderr.write(`Unknown pack: ${packName}. Known: ${Object.keys(PACKS).join(", ")}\n`);
    process.stderr.write(USAGE);
    return 1;
  }
  const env = deps.env ?? process.env;
  const outDir = flags["out-dir"] ?? "artifacts";

  const baselineEndpoint = loadEndpoint(flags.baseline, env);
  const candidateEndpoint = loadEndpoint(flags.candidate, env);

  const captureOpts = { fetchImpl: deps.fetchImpl, env, now: deps.now };
  const baselineCapture = await captureOutputs(pack.cases, baselineEndpoint, captureOpts);
  reportCaptureErrors("baseline", baselineCapture);
  const candidateCapture = await captureOutputs(pack.cases, candidateEndpoint, captureOpts);
  reportCaptureErrors("candidate", candidateCapture);

  // Captured outputs double as replayable fixture files (cli.ts --candidate-fixtures).
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    `${outDir}/${OUT_BASENAME}.baseline-outputs.json`,
    JSON.stringify(baselineCapture.outputs, null, 2),
  );
  writeFileSync(
    `${outDir}/${OUT_BASENAME}.candidate-outputs.json`,
    JSON.stringify(candidateCapture.outputs, null, 2),
  );

  const baseline = await runPack(packName, baselineCapture.outputs);
  const candidate = await runPack(packName, candidateCapture.outputs);
  const cmp = compareModels(baseline, candidate, {
    baseline_label: baselineEndpoint.label,
    candidate_label: candidateEndpoint.label,
    metrics_note:
      "Metrics captured live from endpoint responses: latency measured client-side; " +
      "tokens/cost as reported by the provider (cost may be n/a — Gateway logs are authoritative).",
  });

  const md = formatComparisonMarkdown(cmp);
  writeFileSync(`${outDir}/${OUT_BASENAME}.md`, md);
  writeFileSync(`${outDir}/${OUT_BASENAME}.json`, formatComparisonJson(cmp));
  process.stdout.write(md + "\n");
  process.stdout.write(
    `\nWrote ${outDir}/${OUT_BASENAME}.{md,json} — decision: ${cmp.recommendation.decision}.\n`,
  );
  return cmp.recommendation.blocking ? 1 : 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
